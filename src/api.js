const axios = require('axios');
const FormData = require('form-data');
const querystring = require('querystring');

const API_URL = 'https://mknetworkbd.com/API/api_handler_test.php';
const LOGIN_URL = 'https://mknetworkbd.com/login.php';

// -----------------------------------------------------------------
// Dynamic cookie management
// -----------------------------------------------------------------
let currentCookie = process.env.SESSION_COOKIE || '';
let isFirstCookieRefresh = true;


/**
 * Log in to mknetworkbd.com and extract fresh session cookies.
 * Returns the cookie string on success, or null on failure.
 */
async function loginAndExtractCookies() {
  const loginId = process.env.MK_LOGIN_ID;
  const password = process.env.MK_PASSWORD;

  if (!loginId || !password) {
    console.error('[Cookie] MK_LOGIN_ID or MK_PASSWORD not set in .env');
    return null;
  }

  try {
    if (isFirstCookieRefresh) {
      console.log('[Cookie] Logging in to extract fresh cookies...');
    }

    const payload = querystring.stringify({
      login_id: loginId,
      password: password
    });

    const response = await axios.post(LOGIN_URL, payload, {
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'accept-encoding': 'gzip, deflate, br, zstd',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'max-age=0',
        'content-type': 'application/x-www-form-urlencoded',
        'origin': 'https://mknetworkbd.com',
        'referer': 'https://mknetworkbd.com/login.php',
        'sec-ch-ua': '"Microsoft Edge";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0'
      },
      // Don't follow redirects so we can capture Set-Cookie headers
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400
    });

    // Extract Set-Cookie headers from the response
    const setCookieHeaders = response.headers['set-cookie'];
    if (!setCookieHeaders || setCookieHeaders.length === 0) {
      console.error('[Cookie] No Set-Cookie headers received from login response.');
      return null;
    }

    // Parse all cookies from Set-Cookie headers
    // Each header looks like: "PHPSESSID=abc123; path=/; HttpOnly"
    const cookies = {};

    // Always keep mk_lang=en
    cookies['mk_lang'] = 'en';

    for (const header of setCookieHeaders) {
      // Extract cookie name=value (before the first semicolon)
      const cookiePart = header.split(';')[0].trim();
      const eqIndex = cookiePart.indexOf('=');
      if (eqIndex > 0) {
        const name = cookiePart.substring(0, eqIndex);
        const value = cookiePart.substring(eqIndex + 1);
        cookies[name] = value;
      }
    }

    // Build cookie string
    const cookieString = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    if (isFirstCookieRefresh) {
      console.log(`[Cookie] Successfully extracted cookies: ${Object.keys(cookies).join(', ')}`);
    }
    return cookieString;
  } catch (error) {
    console.error('[Cookie] Login failed:', error.message);
    return null;
  }
}

/**
 * Refresh cookies immediately by logging in.
 */
async function refreshCookies() {
  const newCookies = await loginAndExtractCookies();
  if (newCookies) {
    currentCookie = newCookies;
    if (isFirstCookieRefresh) {
      console.log('[Cookie] Cookie updated successfully.');
      isFirstCookieRefresh = false;
    }
  } else {
    console.warn('[Cookie] Failed to refresh cookies, keeping existing cookie.');
  }
}

/**
 * Start the background cookie refresh loop.
 * Extracts fresh cookies immediately, then every 1 minute.
 */
async function startCookieRefreshLoop() {
  // Initial extraction
  await refreshCookies();

  // Refresh every 1 minute
  setInterval(async () => {
    await refreshCookies();
  }, 1 * 60 * 1000);
}

/**
 * Get the current active cookie string.
 */
function getCookie() {
  return currentCookie;
}

// -----------------------------------------------------------------
// API Functions
// -----------------------------------------------------------------

/**
 * Fetches a number from the MK Network API using session cookies.
 * @param {string} range - The range of the number (e.g., '237621813XXX')
 * @returns {Promise<{status: string, number: string, iso: string}>}
 */
async function getNumber(range) {
  try {
    const cookie = getCookie();
    if (!cookie) {
      throw new Error('No valid session cookie available. Check MK_LOGIN_ID and MK_PASSWORD in .env.');
    }

    const form = new FormData();
    form.append('action', 'get_number');
    form.append('range', range);

    const headers = {
      ...form.getHeaders(),
      'accept': '*/*',
      'accept-encoding': 'gzip, deflate, br, zstd',
      'accept-language': 'en-GB,en;q=0.5',
      'cookie': cookie,
      'origin': 'https://mknetworkbd.com',
      'referer': 'https://mknetworkbd.com/getnum.php',
      'sec-ch-ua': '"Brave";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'sec-gpc': '1',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
    };

    const response = await axios.post(API_URL, form, { headers });

    return response.data;
  } catch (error) {
    console.error('getNumber Request failed:', error.message);
    throw error;
  }
}

/**
 * Fetches the OTP history for a specific page.
 * @param {number} page - The page number to fetch
 * @param {number} limit - The number of records per page
 * @returns {Promise<{data: Array, totalPages: number}>} Object containing records and total pages
 */
async function getHistory(page = 1, limit = 50) {
  try {
    const cookie = getCookie();
    if (!cookie) {
      throw new Error('No valid session cookie available. Check MK_LOGIN_ID and MK_PASSWORD in .env.');
    }

    // Use Asia/Dhaka time zone to prevent midnight date issues
    const dateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Dhaka',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());

    const headers = {
      'accept': '*/*',
      'accept-encoding': 'gzip, deflate, br, zstd',
      'accept-language': 'en-GB,en;q=0.5',
      'cookie': cookie,
      'priority': 'u=1, i',
      'referer': 'https://mknetworkbd.com/getnum.php',
      'sec-ch-ua': '"Brave";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'sec-gpc': '1',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
    };

    // Only fetch records with successful OTPs for efficient polling
    const url = `${API_URL}?action=get_history&filter=success&page=${page}&limit=${limit}&date=${dateStr}`;
    const response = await axios.get(url, { headers });

    if (response.data && response.data.status === 'success') {
      return {
        data: response.data.data || [],
        totalPages: response.data.total_pages || 1
      };
    }
    return { data: [], totalPages: 1 };
  } catch (error) {
    console.error(`getHistory (page ${page}) Request failed:`, error.message);
    return { data: [], totalPages: 1 };
  }
}

module.exports = {
  getNumber,
  getHistory,
  startCookieRefreshLoop
};
