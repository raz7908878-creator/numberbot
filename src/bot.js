require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const mkApi = require('./api');
const nexaApi = require('./nexaApi');
const { getBalance, setBalance, addBalance, getAllBalances } = require('./balance');

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
  return api === 'nexaotp' ? 'NexaOTP' : 'MK Network';
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

// -----------------------------------------------------------------
// Ranges persistence
// -----------------------------------------------------------------
const RANGES_FILE = path.join(__dirname, '..', 'data', 'ranges.json');

function loadRanges() {
  try {
    const data = fs.readFileSync(RANGES_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

function saveRanges(ranges) {
  fs.mkdirSync(path.dirname(RANGES_FILE), { recursive: true });
  fs.writeFileSync(RANGES_FILE, JSON.stringify(ranges, null, 2));
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

  const ranges = loadRanges();
  const activeApi = getActiveApi();
  const balance = await getBalance(chatId);

  const keyboard = [];

  // Show top 3 ranges as buttons if available
  if (ranges.length > 0) {
    const topRanges = ranges.slice(0, 3);
    for (const r of topRanges) {
      keyboard.push([{ text: `📱 ${r}`, callback_data: `range:${r}` }]);
    }
  }

  keyboard.push([{ text: '🔢 Enter Custom Range', callback_data: 'custom_range' }]);

  const welcome = ranges.length > 0
    ? `Welcome to the *SRF Number Bot!*\n\n💰 *Your Balance:* \`${balance}\` points\n\nSelect a range below or type a range directly:`
    : `Welcome to the *SRF Number Bot!*\n\n💰 *Your Balance:* \`${balance}\` points\n\nType a number range to get started (e.g. \`224655XXXXXX\`):`;

  bot.sendMessage(chatId, welcome, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
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
    // If ADMIN_ID not set, allow anyone (for initial setup)
    console.warn(`Admin command used by ${chatId}. Set ADMIN_ID=${chatId} in .env to restrict.`);
  }

  const ranges = loadRanges();
  const activeApi = getActiveApi();
  const apiLabel = getApiLabel(activeApi);
  const rangeList = ranges.length > 0
    ? ranges.map((r, i) => `${i + 1}. \`${r}\``).join('\n')
    : '_No ranges configured._';

  bot.sendMessage(chatId,
    `⚙️ *Admin Panel*\n\n🔌 *Active API:* ${apiLabel}\n\n*Active Ranges:*\n${rangeList}\n\nUse the buttons below to manage:`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Add Range', callback_data: 'admin_add_range' }],
          [{ text: '🗑️ Remove Range', callback_data: 'admin_remove_range' }],
          [{ text: '📋 View Ranges', callback_data: 'admin_view_ranges' }],
          [{ text: `🔄 Switch API (→ ${activeApi === 'mknetwork' ? 'NexaOTP' : 'MK Network'})`, callback_data: 'admin_switch_api' }],
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
              { text: '🔄 Change Number', callback_data: `change_number:${range}` },
              { text: '📊 Active Ranges', url: 'https://t.me/+E_M7TqggqpZjZTNl' }
            ],
            [
              { text: '📬 OTP Group', url: 'https://t.me/+y3Y4QfaD22QyZjE9' }
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

    // --- User: Select a preset range ---
    if (query.data.startsWith('range:')) {
      const range = query.data.substring(6);
      bot.answerCallbackQuery(query.id).catch(() => {});
      await fetchNumberForUser(chatId, range);
    }
    // --- User: Enter custom range ---
    else if (query.data === 'custom_range') {
      bot.answerCallbackQuery(query.id).catch(() => {});
      adminStates[chatId] = 'WAITING_FOR_RANGE';
      bot.sendMessage(chatId, 'Please enter the number range (e.g., `224655XXXXXX`):', { parse_mode: 'Markdown' }).catch(() => {});
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
              { text: '🔄 Change Number', callback_data: `change_number:${lastData.range}` },
              { text: '📊 Active Ranges', url: 'https://t.me/+E_M7TqggqpZjZTNl' }
            ],
            [
              { text: '📬 OTP Group', url: 'https://t.me/+y3Y4QfaD22QyZjE9' }
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
    // --- Admin: Add Range ---
    else if (query.data === 'admin_add_range') {
      if (ADMIN_ID && chatId !== ADMIN_ID) return bot.answerCallbackQuery(query.id, { text: '⛔ Not authorized' }).catch(() => {});
      bot.answerCallbackQuery(query.id).catch(() => {});
      adminStates[chatId] = 'ADMIN_ADDING_RANGE';
      bot.sendMessage(chatId, '📝 Send the range to add (e.g., `224655XXXXXX`):', { parse_mode: 'Markdown' }).catch(() => {});
    }
    // --- Admin: Remove Range ---
    else if (query.data === 'admin_remove_range') {
      if (ADMIN_ID && chatId !== ADMIN_ID) return bot.answerCallbackQuery(query.id, { text: '⛔ Not authorized' }).catch(() => {});
      bot.answerCallbackQuery(query.id).catch(() => {});
      const ranges = loadRanges();
      if (ranges.length === 0) {
        return bot.sendMessage(chatId, '❌ No ranges to remove.').catch(() => {});
      }
      const keyboard = ranges.map((r, i) => [{ text: `🗑️ ${r}`, callback_data: `admin_del:${i}` }]);
      bot.sendMessage(chatId, 'Select a range to remove:', { reply_markup: { inline_keyboard: keyboard } }).catch(() => {});
    }
    // --- Admin: Confirm delete ---
    else if (query.data.startsWith('admin_del:')) {
      if (ADMIN_ID && chatId !== ADMIN_ID) return bot.answerCallbackQuery(query.id, { text: '⛔ Not authorized' }).catch(() => {});
      const index = parseInt(query.data.split(':')[1]);
      const ranges = loadRanges();
      if (index >= 0 && index < ranges.length) {
        const removed = ranges.splice(index, 1)[0];
        saveRanges(ranges);
        bot.answerCallbackQuery(query.id, { text: `Removed: ${removed}` }).catch(() => {});
        bot.editMessageText(`✅ Range \`${removed}\` removed.`, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown'
        }).catch(() => {});
      } else {
        bot.answerCallbackQuery(query.id, { text: 'Invalid range' }).catch(() => {});
      }
    }
    // --- Admin: View Ranges ---
    else if (query.data === 'admin_view_ranges') {
      if (ADMIN_ID && chatId !== ADMIN_ID) return bot.answerCallbackQuery(query.id, { text: '⛔ Not authorized' }).catch(() => {});
      bot.answerCallbackQuery(query.id).catch(() => {});
      const ranges = loadRanges();
      const rangeList = ranges.length > 0
        ? ranges.map((r, i) => `${i + 1}. \`${r}\``).join('\n')
        : '_No ranges configured._';
      bot.sendMessage(chatId, `📋 *Active Ranges:*\n\n${rangeList}`, { parse_mode: 'Markdown' }).catch(() => {});
    }
    // --- Admin: Switch API ---
    else if (query.data === 'admin_switch_api') {
      if (ADMIN_ID && chatId !== ADMIN_ID) return bot.answerCallbackQuery(query.id, { text: '⛔ Not authorized' }).catch(() => {});

      const config = loadConfig();
      const newApi = config.activeApi === 'mknetwork' ? 'nexaotp' : 'mknetwork';
      config.activeApi = newApi;
      saveConfig(config);

      const newLabel = getApiLabel(newApi);
      const nextSwitch = newApi === 'mknetwork' ? 'NexaOTP' : 'MK Network';

      bot.answerCallbackQuery(query.id, { text: `Switched to ${newLabel}` }).catch(() => {});

      // Update the admin panel message in-place
      const ranges = loadRanges();
      const rangeList = ranges.length > 0
        ? ranges.map((r, i) => `${i + 1}. \`${r}\``).join('\n')
        : '_No ranges configured._';

      bot.editMessageText(
        `⚙️ *Admin Panel*\n\n🔌 *Active API:* ${newLabel} ✅\n\n*Active Ranges:*\n${rangeList}\n\nUse the buttons below to manage:`, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '➕ Add Range', callback_data: 'admin_add_range' }],
              [{ text: '🗑️ Remove Range', callback_data: 'admin_remove_range' }],
              [{ text: '📋 View Ranges', callback_data: 'admin_view_ranges' }],
              [{ text: `🔄 Switch API (→ ${nextSwitch})`, callback_data: 'admin_switch_api' }],
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
      // Fetch user info (name/username) for each user
      const keyboard = [];
      for (const uid of userIds) {
        let label = uid;
        try {
          const chat = await bot.getChat(uid);
          const name = chat.first_name || '';
          const uname = chat.username ? `@${chat.username}` : '';
          label = uname ? `${name} (${uname})` : name || uid;
        } catch (e) { /* fallback to uid */ }
        keyboard.push([
          { text: `👤 ${label}  •  💰 ${balances[uid]} pts`, callback_data: `admin_bal_user:${uid}` }
        ]);
      }
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

  // Admin adding a range
  if (adminStates[chatId] === 'ADMIN_ADDING_RANGE') {
    adminStates[chatId] = null;
    const range = text.trim();
    const ranges = loadRanges();
    if (ranges.includes(range)) {
      return bot.sendMessage(chatId, `⚠️ Range \`${range}\` already exists.`, { parse_mode: 'Markdown' });
    }
    ranges.push(range);
    saveRanges(ranges);
    return bot.sendMessage(chatId, `✅ Range \`${range}\` added!`, { parse_mode: 'Markdown' });
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

  // User waiting to enter custom range
  if (adminStates[chatId] === 'WAITING_FOR_RANGE') {
    adminStates[chatId] = null;
    return await fetchNumberForUser(chatId, text.trim());
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
  for (const pNumber of pendingKeys) {
    if (pendingNumbers[pNumber].api === 'nexaotp') {
      nexaPending.push(pNumber);
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
          const newOtps = allOtps.slice(knownCount).join('|||');
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
                  { text: '🔄 Change Number', callback_data: `change_from_otp:${reqData.range}` },
                  { text: '📊 Active Ranges', url: 'https://t.me/+E_M7TqggqpZjZTNl' }
                ],
                [
                  { text: '🔁 Restore Last Number', callback_data: `restore_last:${pNumber}` }
                ]
              ]
            }
          }).catch(e => console.error('[OTP send] Error:', e.message));

          // Forward to OTP group with masked number
          if (OTP_GROUP_ID) {
            const masked = maskNumber(pNumber);
            const groupFlag = isoToFlag(reqData.iso);
            const groupMsg = `📩 *OTP Received*\n\n${groupFlag} *Number:* \`${masked}\`\n🔑 *Code:* \`${newOtps}\`\n📝 *SMS:* \`${newSms}\``;
            bot.sendMessage(OTP_GROUP_ID, groupMsg, { parse_mode: 'Markdown' }).catch(() => {});
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
          const newOtps = allOtps.slice(knownCount).join('|||');
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
                  { text: '🔄 Change Number', callback_data: `change_from_otp:${reqData.range}` },
                  { text: '📊 Active Ranges', url: 'https://t.me/+E_M7TqggqpZjZTNl' }
                ],
                [
                  { text: '🔁 Restore Last Number', callback_data: `restore_last:${pNumber}` }
                ]
              ]
            }
          }).catch(e => console.error('[NexaOTP send] Error:', e.message));

          // Forward to OTP group with masked number
          if (OTP_GROUP_ID) {
            const masked = maskNumber(pNumber);
            const groupFlag = isoToFlag(reqData.iso);
            const groupMsg = `📩 *OTP Received*\n\n${groupFlag} *Number:* \`${masked}\`\n🔑 *Code:* \`${newOtps}\`\n📝 *SMS:* \`${newSms}\``;
            bot.sendMessage(OTP_GROUP_ID, groupMsg, { parse_mode: 'Markdown' }).catch(() => {});
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
      bot.sendMessage(reqData.chatId, `⏰ *Timeout!* Number \`${pNumber}\` has been unassigned after 10 minutes with no OTP.`, { parse_mode: 'Markdown' }).catch(() => {});
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
      const logs = await nexaApi.getConsoleLogs();

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
