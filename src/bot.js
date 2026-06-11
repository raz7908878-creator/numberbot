require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const mkApi = require('./api');
const nexaApi = require('./nexaApi');
const zenexApi = require('./zenexApi');
const { getBalance, setBalance, addBalance, getAllBalances } = require('./balance');
const { TOTP } = require('totp-generator');

const awaiting2fa = {};
// -----------------------------------------------------------------
// Global error handlers — prevent crash on transient network errors
// -----------------------------------------------------------------
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Unhandled Rejection]', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err.message);
  // Only exit on truly fatal errors, not network blips
  if (!['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'EFATAL'].includes(err.code)) {
    process.exit(1);
  }
});

const token = process.env.BOT_TOKEN;
const rangeBotToken = process.env.RANGE_BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null;
const OTP_GROUP_ID = process.env.OTP_GROUP_ID || null;

if (!token) {
  console.error('BOT_TOKEN is required in .env file');
  process.exit(1);
}

if (!process.env.MK_LOGIN_ID || !process.env.MK_PASSWORD) {
  console.warn('WARNING: MK_LOGIN_ID or MK_PASSWORD not set. Cookie auto-refresh will not work.');
}

// Start background cookie refresh (immediate + every 5 minutes)
mkApi.startCookieRefreshLoop();
nexaApi.startCookieRefreshLoop();
zenexApi.startCookieRefreshLoop();

const bot = new TelegramBot(token, { polling: true });
const rangeBot = rangeBotToken ? new TelegramBot(rangeBotToken, { polling: false }) : bot;

// -----------------------------------------------------------------
// Config persistence (active API provider)
// -----------------------------------------------------------------
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

function loadConfig() {
  try {
    const data = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return { activeApi: 'mknetwork' };
  }
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function getActiveApi() {
  return loadConfig().activeApi || 'mknetwork';
}

function getApiLabel(api) {
  return api === 'nexaotp' ? 'NexaOTP' : (api === 'zenex' ? 'Zenex Panel' : 'MK Network');
}

function getActiveRangeApi() {
  return loadConfig().activeRangeApi || 'nexaotp';
}

function getRangeApiLabel(api) {
  return api === 'zenex' ? 'Zenex Panel' : 'NexaOTP';
}

// Store pending numbers to poll for OTPs.
// MK Network format: { "237621813755": { chatId, range, iso, successMsgId, requestedAt, api: 'mknetwork' } }
// NexaOTP format:    { "237621813755": { chatId, range, iso, successMsgId, requestedAt, api: 'nexaotp', numberId: '...' } }
const pendingNumbers = {};

// Track the last number that received an OTP per user (chatId -> { number, range, iso, api, numberId })
const lastOtpNumbers = {};

// Mask a phone number: show first 4 and last 3 digits, mask the rest
// e.g. 224655438341 -> 2246XXXXX341
function maskNumber(num) {
  const str = String(num);
  if (str.length <= 7) return str;
  return str.slice(0, 4) + 'X'.repeat(str.length - 7) + str.slice(-3);
}

// Convert 2-letter ISO country code to flag emoji
// e.g. "GN" -> 🇬🇳, "KG" -> 🇰🇬
function isoToFlag(iso) {
  if (!iso || iso.length !== 2) return '';
  const code = iso.toUpperCase();
  return String.fromCodePoint(
    ...[...code].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)
  );
}

// Detect language from SMS text
function detectLanguage(text) {
  if (!text) return 'English';
  const lowerText = text.toLowerCase();
  
  if (lowerText.includes('es tu') || lowerText.includes('código') || lowerText.includes('codigo')) return 'Spanish';
  if (lowerText.includes('est votre') || lowerText.includes('votre code')) return 'French';
  if (lowerText.includes('é o seu') || lowerText.includes('seu código') || lowerText.includes('seu codigo')) return 'Portuguese';
  if (lowerText.includes('adalah kode') || lowerText.includes('kode anda')) return 'Indonesian';
  if (lowerText.includes('ваш код') || lowerText.includes('код')) return 'Russian';
  if (lowerText.includes('رمز') || lowerText.includes('كود')) return 'Arabic';
  if (lowerText.includes('ist dein') || lowerText.includes('dein code')) return 'German';
  if (lowerText.includes('è il tuo') || lowerText.includes('il tuo codice')) return 'Italian';
  if (lowerText.includes('mã của')) return 'Vietnamese';
  if (lowerText.includes('รหัส')) return 'Thai';
  if (lowerText.includes('कोड़') || lowerText.includes('कोड')) return 'Hindi';

  return 'English';
}

// -----------------------------------------------------------------
// Live Range Cache (populated from range group polling)
// -----------------------------------------------------------------
// liveRanges: { "Guinea": [ { range, carrier, app, iso, timestamp }, ... ], ... }
const liveRanges = {};
const LIVE_RANGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function addLiveRange(country, range, carrier, app, iso) {
  if (!liveRanges[country]) liveRanges[country] = [];
  liveRanges[country].push({ range, carrier, app, iso, timestamp: Date.now() });
  // Keep max 50 entries per country to prevent memory leak
  if (liveRanges[country].length > 50) {
    liveRanges[country] = liveRanges[country].slice(-50);
  }
}

function getLiveCountries() {
  const cutoff = Date.now() - LIVE_RANGE_TTL_MS;
  const results = [];
  for (const country of Object.keys(liveRanges)) {
    const recent = liveRanges[country].filter(r => r.timestamp > cutoff);
    if (recent.length > 0) {
      // Most recent entry for flag/iso
      const latest = recent[recent.length - 1];
      results.push({ country, count: recent.length, iso: latest.iso, range: latest.range });
    }
  }
  return results.sort((a, b) => b.count - a.count);
}

function getBestRange(country) {
  const cutoff = Date.now() - LIVE_RANGE_TTL_MS;
  const entries = (liveRanges[country] || []).filter(r => r.timestamp > cutoff);
  if (entries.length === 0) return null;
  // Return the most recent range
  return entries[entries.length - 1];
}

// -----------------------------------------------------------------
// Balance / Points persistence
// -----------------------------------------------------------------
// Balances are now managed via Upstash Redis (see src/balance.js)

// -----------------------------------------------------------------
// /start command
// -----------------------------------------------------------------
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const balance = await getBalance(chatId);

  const welcome = `Welcome to the *SRF Number Bot!* 🚀\n\n💰 *Your Balance:* \`${balance}\` points\n\nTap a button below to get started:`;

  bot.sendMessage(chatId, welcome, {
    parse_mode: 'Markdown',
    reply_markup: {
      keyboard: [
        [{ text: '📲 Get Number', style: 'primary' }, { text: '📡 Live Traffic', style: 'primary' }],
        [{ text: '🛡️ Get 2FA', style: 'primary' }, { text: '🆘 Support', style: 'primary' }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  });
});

// -----------------------------------------------------------------
// /admin command
// -----------------------------------------------------------------
bot.onText(/\/admin/, (msg) => {
  const chatId = msg.chat.id;

  if (ADMIN_ID && chatId !== ADMIN_ID) {
    return bot.sendMessage(chatId, '⛔ You are not authorized.');
  }

  if (!ADMIN_ID) {
    console.warn(`Admin command used by ${chatId}. Set ADMIN_ID=${chatId} in .env to restrict.`);
  }

  const activeApi = getActiveApi();
  const apiLabel = getApiLabel(activeApi);
  const liveCountries = getLiveCountries();
  const liveList = liveCountries.length > 0
    ? liveCountries.map(c => `${isoToFlag(c.iso)} ${c.country} — ${c.count} range(s)`).join('\n')
    : '_No live ranges right now._';

  const activeRangeApi = getActiveRangeApi();
  const rangeApiLabel = getRangeApiLabel(activeRangeApi);

  bot.sendMessage(chatId,
    `⚙️ *Admin Panel*\n\n🔌 *Active API:* ${apiLabel}\n📡 *Range API:* ${rangeApiLabel}\n\n📡 *Live Ranges (last 5 min):*\n${liveList}\n\nUse the buttons below to manage:`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: `🔄 Switch API (→ ${activeApi === 'mknetwork' ? 'NexaOTP' : (activeApi === 'nexaotp' ? 'Zenex Panel' : 'MK Network')})`, callback_data: 'admin_switch_api' }],
          [{ text: `🔄 Switch Range API (→ ${activeRangeApi === 'nexaotp' ? 'Zenex Panel' : 'NexaOTP'})`, callback_data: 'admin_switch_range_api' }],
          [{ text: '💰 Edit User Balance', callback_data: 'admin_edit_balance' }]
        ]
      }
    });
});

// -----------------------------------------------------------------
// Fetch number helper
// -----------------------------------------------------------------

// Immediately unassign any pending number for a user (prevents stale timeout)
function unassignPendingForChat(chatId) {
  for (const pNumber of Object.keys(pendingNumbers)) {
    if (pendingNumbers[pNumber].chatId === chatId) {
      delete pendingNumbers[pNumber];
    }
  }
}

async function fetchNumberForUser(chatId, range, messagesToDelete = []) {
  try {
    // Unassign any previous pending number for this user immediately
    unassignPendingForChat(chatId);

    const activeApi = getActiveApi();
    const fetchingMsg = await bot.sendMessage(chatId, `Fetching number, please wait...`);

    let response = null;
    let lastError = null;
    const MAX_ATTEMPTS = 2;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        if (activeApi === 'nexaotp') {
          response = await nexaApi.getNumber(range);
        } else if (activeApi === 'zenex') {
          response = await zenexApi.getNumber(range);
        } else {
          response = await mkApi.getNumber(range);
        }

        if (response && response.status === 'success' && response.number) {
          break; // Success, stop retrying
        }

        // API returned non-success, retry if we have attempts left
        if (attempt < MAX_ATTEMPTS) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
      } catch (error) {
        lastError = error;
        if (attempt < MAX_ATTEMPTS) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
      }
    }

    // Delete old messages and fetching message
    for (const msgId of messagesToDelete) {
      try { await bot.deleteMessage(chatId, msgId); } catch (e) { /* ignore */ }
    }
    try { await bot.deleteMessage(chatId, fetchingMsg.message_id); } catch (e) { /* ignore */ }

    // Check final result
    if (response && response.status === 'success' && response.number) {
      const flag = isoToFlag(response.iso);
      const message = `✅ *Success!*\n\n${flag} *Number:* \`${response.number}\`\n*ISO:* ${response.iso || 'N/A'}\n\n⏳ _Waiting for SMS..._`;
      const successMsg = await bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔄 Change Number', callback_data: `change_number:${range}`, style: 'success' },
              { text: '📊 Active Ranges', url: 'https://t.me/srfranges', style: 'primary' }
            ],
            [
              { text: '📬 OTP Group', url: 'https://t.me/srfotpgroups', style: 'success' }
            ]
          ]
        }
      });

      // Strip '+' from the number to match history API format
      const cleanNumber = response.number.replace('+', '');
      pendingNumbers[cleanNumber] = {
        chatId: chatId,
        range: range,
        iso: response.iso || '',
        successMsgId: successMsg.message_id,
        requestedAt: Date.now(),
        api: activeApi,
        // NexaOTP-specific: store the number_id for polling
        numberId: response.number_id || null
      };
    } else if (lastError) {
      bot.sendMessage(chatId, `❌ Error: ${lastError.message}`).catch(() => {});
    } else {
      const status = response && response.status ? response.status : 'Unknown error';
      const errMsg = response && response.message ? ` — ${response.message}` : '';
      bot.sendMessage(chatId, `Failed to get number. Status: ${status}${errMsg}`).catch(() => {});
    }
  } catch (err) {
    console.error('[fetchNumberForUser] Error:', err.message);
    bot.sendMessage(chatId, '⚠️ A network error occurred. Please try again.').catch(() => {});
  }
}

// -----------------------------------------------------------------
// Admin state tracking
// -----------------------------------------------------------------
const adminStates = {};

// -----------------------------------------------------------------
// Callback query handler
// -----------------------------------------------------------------
bot.on('callback_query', async (query) => {
  try {
    const chatId = query.message.chat.id;

    // --- User: Select a country to get number ---
    if (query.data.startsWith('country:')) {
      const country = query.data.substring(8);
      bot.answerCallbackQuery(query.id).catch(() => {});
      // Delete the country selection message (fire-and-forget, don't wait)
      bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const best = getBestRange(country);
      if (!best) {
        bot.sendMessage(chatId, `⚠️ No live ranges for *${country}* right now. Try again in a moment.`, { parse_mode: 'Markdown' }).catch(() => {});
        return;
      }
      await fetchNumberForUser(chatId, best.range);
    }
    // --- User: Change number (from success msg - delete old) ---
    else if (query.data.startsWith('change_number:')) {
      const range = query.data.split(':')[1];
      const oldMessageId = query.message.message_id;
      bot.answerCallbackQuery(query.id).catch(() => {});
      await fetchNumberForUser(chatId, range, [oldMessageId]);
    }
    // --- User: Change number (from OTP msg - keep old) ---
    else if (query.data.startsWith('change_from_otp:')) {
      const range = query.data.split(':')[1];
      bot.answerCallbackQuery(query.id).catch(() => {});
      // Remove the button from the OTP message but keep the message itself
      try {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
          chat_id: chatId,
          message_id: query.message.message_id
        });
      } catch (e) { /* ignore */ }
      await fetchNumberForUser(chatId, range);
    }
    // --- User: Restore last number (re-add to pending for another OTP) ---
    else if (query.data.startsWith('restore_last:')) {
      const number = query.data.split(':')[1];
      bot.answerCallbackQuery(query.id).catch(() => {});

      const lastData = lastOtpNumbers[chatId];
      if (!lastData || lastData.number !== number) {
        bot.sendMessage(chatId, '⚠️ Could not restore. Number data not found.').catch(() => {});
        return;
      }

      // Remove the restore button from the OTP message
      try {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
          chat_id: chatId,
          message_id: query.message.message_id
        });
      } catch (e) { /* ignore */ }

      // Unassign any current pending number for this user
      unassignPendingForChat(chatId);

      const flag = isoToFlag(lastData.iso);
      const restoreMsg = `🔁 *Number Restored!*\n\n${flag} *Number:* \`${number}\`\n*ISO:* ${lastData.iso || 'N/A'}\n\n⏳ _Waiting for new SMS..._`;
      const successMsg = await bot.sendMessage(chatId, restoreMsg, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔄 Change Number', callback_data: `change_number:${lastData.range}`, style: 'success' },
              { text: '📊 Active Ranges', url: 'https://t.me/srfranges', style: 'primary' }
            ],
            [
              { text: '📬 OTP Group', url: 'https://t.me/srfotpgroups', style: 'success' }
            ]
          ]
        }
      });

      // Re-add to pendingNumbers tracking
      pendingNumbers[number] = {
        chatId: chatId,
        range: lastData.range,
        iso: lastData.iso,
        successMsgId: successMsg.message_id,
        requestedAt: Date.now(),
        api: lastData.api,
        numberId: lastData.numberId || null,
        knownOtpCount: lastData.lastOtpCount || 0  // skip previously seen OTPs
      };
    }

    // --- Admin: Switch API ---
    else if (query.data === 'admin_switch_api') {
      if (ADMIN_ID && chatId !== ADMIN_ID) return bot.answerCallbackQuery(query.id, { text: '⛔ Not authorized' }).catch(() => {});

      const config = loadConfig();
      const apis = ['mknetwork', 'nexaotp', 'zenex'];
      const currentIndex = apis.indexOf(config.activeApi) !== -1 ? apis.indexOf(config.activeApi) : 0;
      const newApi = apis[(currentIndex + 1) % apis.length];
      config.activeApi = newApi;
      saveConfig(config);

      const newLabel = getApiLabel(newApi);
      const nextApi = apis[(currentIndex + 2) % apis.length];
      const nextSwitch = getApiLabel(nextApi);

      bot.answerCallbackQuery(query.id, { text: `Switched to ${newLabel}` }).catch(() => {});

      // Update the admin panel message in-place
      const liveCountries = getLiveCountries();
      const liveList = liveCountries.length > 0
        ? liveCountries.map(c => `${isoToFlag(c.iso)} ${c.country} — ${c.count} range(s)`).join('\n')
        : '_No live ranges right now._';

      const activeRangeApi = getActiveRangeApi();
      const rangeApiLabel = getRangeApiLabel(activeRangeApi);

      bot.editMessageText(
        `⚙️ *Admin Panel*\n\n🔌 *Active API:* ${newLabel} ✅\n📡 *Range API:* ${rangeApiLabel}\n\n📡 *Live Ranges (last 5 min):*\n${liveList}\n\nUse the buttons below to manage:`, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: `🔄 Switch API (→ ${nextSwitch})`, callback_data: 'admin_switch_api' }],
              [{ text: `🔄 Switch Range API (→ ${activeRangeApi === 'nexaotp' ? 'Zenex Panel' : 'NexaOTP'})`, callback_data: 'admin_switch_range_api' }],
              [{ text: '💰 Edit User Balance', callback_data: 'admin_edit_balance' }]
            ]
          }
        }).catch(() => {});
    }
    // --- Admin: Switch Range API ---
    else if (query.data === 'admin_switch_range_api') {
      if (ADMIN_ID && chatId !== ADMIN_ID) return bot.answerCallbackQuery(query.id, { text: '⛔ Not authorized' }).catch(() => {});

      const config = loadConfig();
      const newRangeApi = config.activeRangeApi === 'nexaotp' ? 'zenex' : 'nexaotp';
      config.activeRangeApi = newRangeApi;
      saveConfig(config);

      const newRangeLabel = getRangeApiLabel(newRangeApi);
      const nextRangeSwitch = newRangeApi === 'nexaotp' ? 'Zenex Panel' : 'NexaOTP';

      bot.answerCallbackQuery(query.id, { text: `Switched Range API to ${newRangeLabel}` }).catch(() => {});

      const activeApi = getActiveApi();
      const apiLabel = getApiLabel(activeApi);
      const nextApiSwitch = activeApi === 'mknetwork' ? 'NexaOTP' : (activeApi === 'nexaotp' ? 'Zenex Panel' : 'MK Network');

      const liveCountries = getLiveCountries();
      const liveList = liveCountries.length > 0
        ? liveCountries.map(c => `${isoToFlag(c.iso)} ${c.country} — ${c.count} range(s)`).join('\n')
        : '_No live ranges right now._';

      bot.editMessageText(
        `⚙️ *Admin Panel*\n\n🔌 *Active API:* ${apiLabel}\n📡 *Range API:* ${newRangeLabel} ✅\n\n📡 *Live Ranges (last 5 min):*\n${liveList}\n\nUse the buttons below to manage:`, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: `🔄 Switch API (→ ${nextApiSwitch})`, callback_data: 'admin_switch_api' }],
              [{ text: `🔄 Switch Range API (→ ${nextRangeSwitch})`, callback_data: 'admin_switch_range_api' }],
              [{ text: '💰 Edit User Balance', callback_data: 'admin_edit_balance' }]
            ]
          }
        }).catch(() => {});
    }
    // --- Admin: Edit User Balance (show user list) ---
    else if (query.data === 'admin_edit_balance') {
      if (ADMIN_ID && chatId !== ADMIN_ID) return bot.answerCallbackQuery(query.id, { text: '⛔ Not authorized' }).catch(() => {});
      bot.answerCallbackQuery(query.id).catch(() => {});
      const balances = await getAllBalances();
      const userIds = Object.keys(balances);
      if (userIds.length === 0) {
        return bot.sendMessage(chatId, '❌ No users found. Users appear here after receiving their first OTP.').catch(() => {});
      }
      // Fetch user info (name/username) for all users in parallel
      const userInfoResults = await Promise.allSettled(
        userIds.map(uid => bot.getChat(uid).then(chat => {
          const name = chat.first_name || '';
          const uname = chat.username ? `@${chat.username}` : '';
          return uname ? `${name} (${uname})` : name || uid;
        }))
      );
      const keyboard = userIds.map((uid, i) => {
        const label = userInfoResults[i].status === 'fulfilled' ? userInfoResults[i].value : uid;
        return [{ text: `👤 ${label}  •  💰 ${balances[uid]} pts`, callback_data: `admin_bal_user:${uid}` }];
      });
      bot.sendMessage(chatId, '👥 *Select a user to edit balance:*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      }).catch(() => {});
    }
    // --- Admin: User selected for balance edit ---
    else if (query.data.startsWith('admin_bal_user:')) {
      if (ADMIN_ID && chatId !== ADMIN_ID) return bot.answerCallbackQuery(query.id, { text: '⛔ Not authorized' }).catch(() => {});
      const userId = query.data.split(':')[1];
      const currentBal = await getBalance(userId);
      bot.answerCallbackQuery(query.id).catch(() => {});
      // Fetch user name for display
      let userLabel = userId;
      try {
        const chat = await bot.getChat(userId);
        const name = chat.first_name || '';
        const uname = chat.username ? `@${chat.username}` : '';
        userLabel = uname ? `${name} (${uname})` : name || userId;
      } catch (e) { /* fallback to uid */ }
      adminStates[chatId] = { state: 'ADMIN_EDIT_BALANCE_AMOUNT', userId: userId };
      bot.sendMessage(chatId, `👤 *User:* ${userLabel} — \`${userId}\`\n💰 *Current Balance:* \`${currentBal}\` points\n\nSend the *new balance* amount:`, { parse_mode: 'Markdown' }).catch(() => {});
    }
  } catch (err) {
    console.error('[callback_query] Error:', err.message);
  }
});

// -----------------------------------------------------------------
// Message handler (direct range typing + admin input)
// -----------------------------------------------------------------
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith('/')) return;

  // --- Support ---
  if (text === '🆘 Support' || text === 'Support') {
    delete awaiting2fa[chatId];
    return bot.sendMessage(chatId, 'Need help? Contact our admin for support!', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🧑‍💻 Contact Admin', url: 'https://t.me/raz908878', style: 'primary' }]
        ]
      }
    });
  }

  // --- Get 2FA ---
  if (text === '🛡️ Get 2FA' || text === 'Get 2FA') {
    awaiting2fa[chatId] = true;
    return bot.sendMessage(chatId, '🔐 *Please send your 2FA Security Key (Base32 secret):*', { parse_mode: 'Markdown' });
  }

  // --- 2FA Secret Input ---
  if (awaiting2fa[chatId]) {
    if (!['📲 Get Number', '📡 Live Traffic', '🛡️ Get 2FA', '🆘 Support'].some(btn => text.includes(btn))) {
      delete awaiting2fa[chatId];
      try {
        const secret = text.replace(/\s+/g, '').toUpperCase();
        const { otp } = await TOTP.generate(secret);
        return bot.sendMessage(chatId, `✅ *Your 2FA Code is:*`, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: `🔑 ${otp}`, copy_text: { text: otp } }]
            ]
          }
        });
      } catch (e) {
        return bot.sendMessage(chatId, '❌ *Invalid 2FA Secret Key.* Please check the key and try again.', { parse_mode: 'Markdown' });
      }
    } else {
      delete awaiting2fa[chatId]; // User clicked another menu button, fall through to normal handling
    }
  }

  // --- Reply Keyboard: Get Number ---
  if (text === '📲 Get Number' || text === '📲 Get Number') {
    const countries = getLiveCountries();
    if (countries.length === 0) {
      return bot.sendMessage(chatId, '😔 No live ranges available right now.\n\n_Ranges appear here automatically when new ones drop in the range group. Try again in a moment._', { parse_mode: 'Markdown' }).catch(() => {});
    }
    const keyboard = countries.map(c => {
      const flag = isoToFlag(c.iso) || '🌍';
      return [{ text: `${flag} ${c.country} (${c.count})`, callback_data: `country:${c.country}` }];
    });
    return bot.sendMessage(chatId, '🌍 *Select a country to get a number:*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    }).catch(() => {});
  }

  // --- Reply Keyboard: Live Traffic ---
  if (text === '📡 Live Traffic' || text === '📡 Live Traffic') {
    const countries = getLiveCountries();
    if (countries.length === 0) {
      return bot.sendMessage(chatId, '📡 *Live Traffic*\n\n_No live traffic in the last 5 minutes._\n\nNew ranges will appear here automatically when they drop.', { parse_mode: 'Markdown' }).catch(() => {});
    }
    const lines = countries.map(c => {
      const flag = isoToFlag(c.iso) || '🌍';
      return `${flag} *${c.country}* — \`${c.count}\` range(s)\n    └ Latest: \`${c.range}\``;
    });
    return bot.sendMessage(chatId, `📡 *Live Traffic (last 5 min)*\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' }).catch(() => {});
  }

  // Admin: waiting for new balance amount
  if (adminStates[chatId] && adminStates[chatId].state === 'ADMIN_EDIT_BALANCE_AMOUNT') {
    const amount = parseFloat(text.trim());
    if (isNaN(amount)) {
      return bot.sendMessage(chatId, '❌ Invalid amount. Please send a number (e.g. `12.5`).', { parse_mode: 'Markdown' }).catch(() => {});
    }
    const userId = adminStates[chatId].userId;
    const newBal = await setBalance(userId, amount);
    adminStates[chatId] = null;
    return bot.sendMessage(chatId, `✅ Balance updated!\n\n👤 *User:* \`${userId}\`\n💰 *New Balance:* \`${newBal}\` points`, { parse_mode: 'Markdown' }).catch(() => {});
  }

  // Direct range typing — any text that looks like a number range
  // Ranges typically contain digits and X characters
  const trimmed = text.trim();
  if (/^[\dXx]{6,}$/.test(trimmed)) {
    await fetchNumberForUser(chatId, trimmed);
  }
});

// -----------------------------------------------------------------
// Background OTP Polling mechanism
// -----------------------------------------------------------------
let isOtpPolling = false;

setInterval(async () => {
  // Prevent overlapping poll cycles — if the previous poll is still running
  // (e.g. slow API response), skip this cycle to avoid sending duplicate OTPs.
  if (isOtpPolling) return;
  isOtpPolling = true;

  try {
  let pendingKeys = Object.keys(pendingNumbers);

  // If there are no pending numbers, don't spam the API
  if (pendingKeys.length === 0) return;

  // Separate pending numbers by API provider
  const mkPending = [];
  const nexaPending = [];
  const zenexPending = [];
  for (const pNumber of pendingKeys) {
    if (pendingNumbers[pNumber].api === 'nexaotp') {
      nexaPending.push(pNumber);
    } else if (pendingNumbers[pNumber].api === 'zenex') {
      zenexPending.push(pNumber);
    } else {
      mkPending.push(pNumber);
    }
  }

  // --- Poll MK Network numbers ---
  if (mkPending.length > 0) {
    try {
      // Fetch only the latest 15 successful records (page 1)
      const result = await mkApi.getHistory(1, 15);
      const history = result.data;

      // Build a lookup map from records for O(1) access by phone number
      const recordMap = {};
      for (const record of history) {
        recordMap[record.phone_number] = record;
      }

      // Iterate only over pending numbers (1-3 typically) instead of all records
      for (const pNumber of mkPending) {
        const record = recordMap[pNumber];
        if (!record) continue; // Not in history yet, skip

        const reqData = pendingNumbers[pNumber];
        if (!reqData) continue;

        // Check if an OTP was received
        if (record.status === 'success' && record.otps) {
          // Count OTPs (separated by '|||')
          const otpCount = record.otps.split('|||').length;
          const knownCount = reqData.knownOtpCount || 0;

          // Skip if no NEW OTPs since restore
          if (otpCount <= knownCount) continue;
          // Delete the old "Waiting for SMS" success message
          if (reqData.successMsgId) {
            try { await bot.deleteMessage(reqData.chatId, reqData.successMsgId); } catch (e) { /* ignore */ }
          }

          // Extract only NEW OTPs (skip previously seen ones)
          const allOtps = record.otps.split('|||');
          const allSms = (record.full_sms_list || record.otps).split('|||');
          
          const newOtpsArr = allOtps.slice(knownCount).map((otp, index) => {
            const sms = allSms.slice(knownCount)[index] || otp;
            let cleanedOtp = otp.trim();
            // Smart extraction: If API returned words (e.g. "votre") instead of digits
            if (/[a-zA-Z]/.test(cleanedOtp) || cleanedOtp.length < 4) {
              const match = sms.match(/(?:\b|\D)(\d{3})\s*(\d{3})(?:\b|\D)/);
              if (match) {
                cleanedOtp = match[1] + match[2];
              } else {
                const digitsMatch = sms.match(/\d{4,8}/);
                if (digitsMatch) cleanedOtp = digitsMatch[0];
              }
            }
            return cleanedOtp;
          });
          
          const newOtps = newOtpsArr.join('|||');
          const newSms = allSms.slice(knownCount).join('|||');

          // Award 0.25 points per OTP received
          const newOtpCountForReward = otpCount - knownCount;
          const pointsAwarded = newOtpCountForReward * 0.25;
          const updatedBalance = await addBalance(reqData.chatId, pointsAwarded);

          const flag = isoToFlag(reqData.iso);
          const message = `📬 *OTP Received!*\n\n${flag} *Number:* \`${pNumber}\`\n🔑 *Code:* \`${newOtps}\`\n\n📝 *Full SMS:*\n\`${newSms}\`\n\n💰 *+${pointsAwarded} pts* (Balance: \`${updatedBalance}\`)`;

          // Save as last OTP number for this user
          lastOtpNumbers[reqData.chatId] = {
            number: pNumber,
            range: reqData.range,
            iso: reqData.iso,
            api: reqData.api,
            numberId: reqData.numberId || null,
            lastOtpCount: otpCount  // track how many OTPs this number had
          };

          bot.sendMessage(reqData.chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '🔄 Change Number', callback_data: `change_from_otp:${reqData.range}`, style: 'success' },
                  { text: '📊 Active Ranges', url: 'https://t.me/srfranges', style: 'primary' }
                ],
                [
                  { text: '🔁 Restore Last Number', callback_data: `restore_last:${pNumber}`, style: 'danger' }
                ]
              ]
            }
          }).catch(e => console.error('[OTP send] Error:', e.message));

          // Forward to OTP group with masked number
          if (OTP_GROUP_ID) {
            const customMask = pNumber.length > 6 ? pNumber.substring(0, 3) + '****' + pNumber.slice(-3) : pNumber;
            const flag = isoToFlag(reqData.iso) || '🏳';
            const safeSms = newSms.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const detectedLang = detectLanguage(newSms);
            const groupMsg = `${flag} ${reqData.iso || 'N/A'} · ${customMask} · ${detectedLang}\n<blockquote>${safeSms}</blockquote>`;
            bot.sendMessage(OTP_GROUP_ID, groupMsg, {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [{ text: `🔑 ${newOtps}`, copy_text: { text: newOtps }, style: 'success' }],
                  [
                    { text: '🤖 Bot', url: 'https://t.me/srfmk_bot', style: 'primary' },
                    { text: '🧑‍💻 Developer', url: 'https://t.me/raz908878', style: 'danger' }
                  ]
                ]
              }
            }).catch(() => {});
          }

          // Remove from tracking
          delete pendingNumbers[pNumber];
        }
        // If it was canceled or expired on the dashboard
        else if (record.status === 'canceled' || record.status === 'expired' || record.remaining_seconds <= 0) {
          bot.sendMessage(reqData.chatId, `⚠️ Number \`${pNumber}\` has expired or was canceled.`, { parse_mode: 'Markdown' }).catch(() => {});
          delete pendingNumbers[pNumber];
        }
      }
    } catch (err) {
      console.error('MK Polling error:', err.message);
    }
  }

  // --- Poll NexaOTP numbers ---
  if (nexaPending.length > 0) {
    try {
      // Fetch only the latest 15 successful records (page 1)
      const result = await nexaApi.getHistory(1, 15);
      const history = result.data;

      // Build a lookup map from records for O(1) access by phone number
      const recordMap = {};
      for (const record of history) {
        recordMap[record.phone_number] = record;
      }

      for (const pNumber of nexaPending) {
        const record = recordMap[pNumber];
        if (!record) continue; // Not in history yet, skip

        const reqData = pendingNumbers[pNumber];
        if (!reqData) continue;

        // Check if an OTP was received
        if (record.status === 'success' && record.otps) {
          // Count OTPs (separated by '|||')
          const otpCount = record.otps.split('|||').length;
          const knownCount = reqData.knownOtpCount || 0;

          // Skip if no NEW OTPs since restore
          if (otpCount <= knownCount) continue;
          // Delete the old "Waiting for SMS" success message
          if (reqData.successMsgId) {
            try { await bot.deleteMessage(reqData.chatId, reqData.successMsgId); } catch (e) { /* ignore */ }
          }

          // Extract only NEW OTPs (skip previously seen ones)
          const allOtps = record.otps.split('|||');
          const allSms = (record.full_sms_list || record.otps).split('|||');
          
          const newOtpsArr = allOtps.slice(knownCount).map((otp, index) => {
            const sms = allSms.slice(knownCount)[index] || otp;
            let cleanedOtp = otp.trim();
            // Smart extraction: If API returned words (e.g. "votre") instead of digits
            if (/[a-zA-Z]/.test(cleanedOtp) || cleanedOtp.length < 4) {
              const match = sms.match(/(?:\b|\D)(\d{3})\s*(\d{3})(?:\b|\D)/);
              if (match) {
                cleanedOtp = match[1] + match[2];
              } else {
                const digitsMatch = sms.match(/\d{4,8}/);
                if (digitsMatch) cleanedOtp = digitsMatch[0];
              }
            }
            return cleanedOtp;
          });
          
          const newOtps = newOtpsArr.join('|||');
          const newSms = allSms.slice(knownCount).join('|||');

          // Award 0.25 points per OTP received
          const newOtpCountForReward = otpCount - knownCount;
          const pointsAwarded = newOtpCountForReward * 0.25;
          const updatedBalance = await addBalance(reqData.chatId, pointsAwarded);

          const flag = isoToFlag(reqData.iso);
          const message = `📬 *OTP Received!*\n\n${flag} *Number:* \`${pNumber}\`\n🔑 *Code:* \`${newOtps}\`\n\n📝 *Full SMS:*\n\`${newSms}\`\n\n💰 *+${pointsAwarded} pts* (Balance: \`${updatedBalance}\`)`;

          // Save as last OTP number for this user
          lastOtpNumbers[reqData.chatId] = {
            number: pNumber,
            range: reqData.range,
            iso: reqData.iso,
            api: reqData.api,
            numberId: reqData.numberId || null,
            lastOtpCount: otpCount  // track how many OTPs this number had
          };

          bot.sendMessage(reqData.chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '🔄 Change Number', callback_data: `change_from_otp:${reqData.range}`, style: 'success' },
                  { text: '📊 Active Ranges', url: 'https://t.me/srfranges', style: 'primary' }
                ],
                [
                  { text: '🔁 Restore Last Number', callback_data: `restore_last:${pNumber}`, style: 'danger' }
                ]
              ]
            }
          }).catch(e => console.error('[NexaOTP send] Error:', e.message));

          // Forward to OTP group with masked number
          if (OTP_GROUP_ID) {
            const customMask = pNumber.length > 6 ? pNumber.substring(0, 3) + '****' + pNumber.slice(-3) : pNumber;
            const flag = isoToFlag(reqData.iso) || '🏳';
            const safeSms = newSms.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const detectedLang = detectLanguage(newSms);
            const groupMsg = `${flag} ${reqData.iso || 'N/A'} · ${customMask} · ${detectedLang}\n<blockquote>${safeSms}</blockquote>`;
            bot.sendMessage(OTP_GROUP_ID, groupMsg, {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [{ text: `🔑 ${newOtps}`, copy_text: { text: newOtps }, style: 'success' }],
                  [
                    { text: '🤖 Bot', url: 'https://t.me/srfmk_bot', style: 'primary' },
                    { text: '🧑‍💻 Developer', url: 'https://t.me/raz908878', style: 'danger' }
                  ]
                ]
              }
            }).catch(() => {});
          }

          // Remove from tracking
          delete pendingNumbers[pNumber];
        }
        // If it was canceled or expired on the dashboard
        else if (record.status === 'canceled' || record.status === 'expired' || record.remaining_seconds <= 0) {
          bot.sendMessage(reqData.chatId, `⚠️ Number \`${pNumber}\` has expired or was canceled.`, { parse_mode: 'Markdown' }).catch(() => {});
          delete pendingNumbers[pNumber];
        }
      }
    } catch (err) {
      console.error('NexaOTP Polling error:', err.message);
    }
  }

  // --- Poll Zenex numbers ---
  if (zenexPending.length > 0) {
    try {
      const result = await zenexApi.getHistory();
      const history = result.data;

      const recordMap = {};
      for (const record of history) {
        recordMap[record.phone_number] = record;
      }

      for (const pNumber of zenexPending) {
        const record = recordMap[pNumber];
        if (!record) continue;

        const reqData = pendingNumbers[pNumber];
        if (!reqData) continue;

        if (record.status === 'success' && record.otps) {
          const otpCount = record.otps.split('|||').length;
          const knownCount = reqData.knownOtpCount || 0;

          if (otpCount <= knownCount) continue;
          if (reqData.successMsgId) {
            try { await bot.deleteMessage(reqData.chatId, reqData.successMsgId); } catch (e) { /* ignore */ }
          }

          const allOtps = record.otps.split('|||');
          const allSms = (record.full_sms_list || record.otps).split('|||');
          
          const newOtpsArr = allOtps.slice(knownCount).map((otp, index) => {
            const sms = allSms.slice(knownCount)[index] || otp;
            let cleanedOtp = otp.trim();
            if (/[a-zA-Z]/.test(cleanedOtp) || cleanedOtp.length < 4) {
              const match = sms.match(/(?:\b|\D)(\d{3})\s*(\d{3})(?:\b|\D)/);
              if (match) {
                cleanedOtp = match[1] + match[2];
              } else {
                const digitsMatch = sms.match(/\d{4,8}/);
                if (digitsMatch) cleanedOtp = digitsMatch[0];
              }
            }
            return cleanedOtp;
          });
          
          const newOtps = newOtpsArr.join('|||');
          const newSms = allSms.slice(knownCount).join('|||');

          const newOtpCountForReward = otpCount - knownCount;
          const pointsAwarded = newOtpCountForReward * 0.25;
          const updatedBalance = await addBalance(reqData.chatId, pointsAwarded);

          const flag = isoToFlag(reqData.iso);
          const message = `📬 *OTP Received!*\n\n${flag} *Number:* \`${pNumber}\`\n🔑 *Code:* \`${newOtps}\`\n\n📝 *Full SMS:*\n\`${newSms}\`\n\n💰 *+${pointsAwarded} pts* (Balance: \`${updatedBalance}\`)`;

          lastOtpNumbers[reqData.chatId] = {
            number: pNumber,
            range: reqData.range,
            iso: reqData.iso,
            api: reqData.api,
            numberId: reqData.numberId || null,
            lastOtpCount: otpCount
          };

          bot.sendMessage(reqData.chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '🔄 Change Number', callback_data: `change_from_otp:${reqData.range}`, style: 'success' },
                  { text: '📊 Active Ranges', url: 'https://t.me/srfranges', style: 'primary' }
                ],
                [
                  { text: '🔁 Restore Last Number', callback_data: `restore_last:${pNumber}`, style: 'danger' }
                ]
              ]
            }
          }).catch(e => console.error('[Zenex send] Error:', e.message));

          if (OTP_GROUP_ID) {
            const customMask = pNumber.length > 6 ? pNumber.substring(0, 3) + '****' + pNumber.slice(-3) : pNumber;
            const flag = isoToFlag(reqData.iso) || '🏳';
            const safeSms = newSms.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const detectedLang = detectLanguage(newSms);
            const groupMsg = `${flag} ${reqData.iso || 'N/A'} · ${customMask} · ${detectedLang}\n<blockquote>${safeSms}</blockquote>`;
            bot.sendMessage(OTP_GROUP_ID, groupMsg, {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [{ text: `🔑 ${newOtps}`, copy_text: { text: newOtps }, style: 'success' }],
                  [
                    { text: '🤖 Bot', url: 'https://t.me/srfmk_bot', style: 'primary' },
                    { text: '🧑‍💻 Developer', url: 'https://t.me/raz908878', style: 'danger' }
                  ]
                ]
              }
            }).catch(() => {});
          }

          delete pendingNumbers[pNumber];
        }
        else if (record.status === 'canceled' || record.status === 'expired' || record.remaining_seconds <= 0) {
          bot.sendMessage(reqData.chatId, `⚠️ Number \`${pNumber}\` has expired or was canceled.`, { parse_mode: 'Markdown' }).catch(() => {});
          delete pendingNumbers[pNumber];
        }
      }
    } catch (err) {
      console.error('Zenex Polling error:', err.message);
    }
  }

  // 10-minute timeout: unassign numbers that haven't received OTP
  const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
  const finalNow = Date.now();
  // Re-read keys since some may have been deleted above
  for (const pNumber of Object.keys(pendingNumbers)) {
    if (pendingNumbers[pNumber] && (finalNow - pendingNumbers[pNumber].requestedAt > TIMEOUT_MS)) {
      const reqData = pendingNumbers[pNumber];
      // Delete the success message
      if (reqData.successMsgId) {
        try { await bot.deleteMessage(reqData.chatId, reqData.successMsgId); } catch (e) { /* ignore */ }
      }
      // Notify user
      bot.sendMessage(reqData.chatId, `⏰ *Timeout!* Number \`${pNumber}\` has been unassigned after 10 minutes with no OTP.`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📊 Active Range', url: 'https://t.me/srfranges' }]
          ]
        }
      }).catch(() => {});
      delete pendingNumbers[pNumber];
    }
  }

  } finally {
    isOtpPolling = false;
  }
}, 2000); // 2 seconds polling

// -----------------------------------------------------------------
// Range Group Polling mechanism
// -----------------------------------------------------------------
const RANGE_GROUP_ID = process.env.RANGE_GROUP_ID || null;
const processedLogIds = new Set();
let isFirstRangePoll = true;

let isRangePolling = false;

if (RANGE_GROUP_ID) {
  setInterval(async () => {
    if (isRangePolling) return;
    isRangePolling = true;

    try {
      const activeRangeApi = getActiveRangeApi();
      let logs = [];
      if (activeRangeApi === 'zenex') {
        logs = await zenexApi.getConsoleLogs();
      } else {
        logs = await nexaApi.getConsoleLogs();
      }

      if (logs.length === 0) {
        isRangePolling = false;
        return;
      }

      if (isFirstRangePoll) {
        logs.forEach(log => {
          const logId = log.id || `${log.number}_${log.time}_${log.otp}`;
          processedLogIds.add(logId);
        });
        isFirstRangePoll = false;
        console.log(`[Range Group] Initialized with ${logs.length} logs ignored.`);
        isRangePolling = false;
        return;
      }

      // Process from oldest to newest in the batch
      for (let i = logs.length - 1; i >= 0; i--) {
        const log = logs[i];
        
        // Filter: only show messages with Facebook
        if (!log.app_name || log.app_name.toLowerCase() !== 'facebook') continue;

        const logId = log.id || `${log.number}_${log.time}_${log.otp}`;
        
        if (!processedLogIds.has(logId)) {
          processedLogIds.add(logId);

          if (processedLogIds.size > 1000) {
            const it = processedLogIds.values();
            processedLogIds.delete(it.next().value);
          }

          const iso = nexaApi.countryToIso(log.country);
          const flag = isoToFlag(iso) || '🌍';
          
          // Format range to show first 7 digits and pad with 6 'X's
          const rawNumber = log.number || '';
          const rangeStr = rawNumber.length >= 7 ? rawNumber.substring(0, 7) + 'XXXXXX' : rawNumber;

          // Cache this range for Get Number / Live Traffic
          addLiveRange(log.country, rangeStr, log.carrier, log.app_name, iso);

          const message = `🌟 *New Range Dropped*\n\n` +
                          `📱 *App:* ${log.app_name}\n` +
                          `${flag} *Country:* ${log.country}\n` +
                          `📶 *Carrier:* ${log.carrier}\n\n` +
                          `🎯 *Range (Tap to copy):*\n` +
                          `\`${rangeStr}\`\n\n` +
                          `🔑 *OTP:* \`******\`\n\n` +
                          `*Bot :* @srfmk\\_bot`;

          let msgSent = false;
          let retries = 0;
          while (!msgSent && retries < 3) {
            try {
              await rangeBot.sendMessage(RANGE_GROUP_ID, message, { parse_mode: 'Markdown' });
              msgSent = true;
            } catch (e) {
              if (e.response && e.response.statusCode === 429) {
                const retryAfter = e.response.body.parameters.retry_after || 5;
                console.warn(`[Range Group] Rate limited. Retrying after ${retryAfter}s...`);
                await new Promise(r => setTimeout(r, retryAfter * 1000));
                retries++;
              } else {
                console.error('[Range Group] Error sending message:', e.message);
                break; // Break on non-429 errors
              }
            }
          }
          // Delay MUST be outside try/catch so it always waits to respect group limits (~20 msgs/min)
          await new Promise(r => setTimeout(r, 3500));
        }
      }
    } catch (err) {
      console.error('[Range Group] Polling error:', err.message);
    } finally {
      isRangePolling = false;
    }
  }, 3000); // 3 seconds polling
}

console.log('Bot is running natively with Background OTP Polling...');

// -----------------------------------------------------------------
// Dummy Web Server for Render
// -----------------------------------------------------------------
const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('SRF Bot is running!\\n');
});

server.listen(PORT, () => {
  console.log(`Web server listening on port ${PORT} (for Render health checks)`);
});
