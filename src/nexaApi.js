const axios = require('axios');

const BASE_URL = 'http://63.141.255.227';

// Map common country names to ISO 3166-1 alpha-2 codes
const COUNTRY_TO_ISO = {
  'afghanistan': 'AF', 'albania': 'AL', 'algeria': 'DZ', 'angola': 'AO',
  'argentina': 'AR', 'armenia': 'AM', 'australia': 'AU', 'austria': 'AT',
  'azerbaijan': 'AZ', 'bahrain': 'BH', 'bangladesh': 'BD', 'belarus': 'BY',
  'belgium': 'BE', 'benin': 'BJ', 'bolivia': 'BO', 'brazil': 'BR',
  'burkina faso': 'BF', 'burundi': 'BI', 'cambodia': 'KH', 'cameroon': 'CM',
  'canada': 'CA', 'chad': 'TD', 'chile': 'CL', 'china': 'CN',
  'colombia': 'CO', 'comoros': 'KM', 'congo': 'CG', 'costa rica': 'CR',
  'cote d\'ivoire': 'CI', 'ivory coast': 'CI', 'croatia': 'HR', 'cuba': 'CU',
  'czech republic': 'CZ', 'czechia': 'CZ', 'denmark': 'DK',
  'dominican republic': 'DO', 'ecuador': 'EC', 'egypt': 'EG',
  'el salvador': 'SV', 'equatorial guinea': 'GQ', 'eritrea': 'ER',
  'estonia': 'EE', 'ethiopia': 'ET', 'finland': 'FI', 'france': 'FR',
  'gabon': 'GA', 'gambia': 'GM', 'georgia': 'GE', 'germany': 'DE',
  'ghana': 'GH', 'greece': 'GR', 'guatemala': 'GT', 'guinea': 'GN',
  'guinea-bissau': 'GW', 'haiti': 'HT', 'honduras': 'HN', 'hungary': 'HU',
  'india': 'IN', 'indonesia': 'ID', 'iran': 'IR', 'iraq': 'IQ',
  'ireland': 'IE', 'israel': 'IL', 'italy': 'IT', 'jamaica': 'JM',
  'japan': 'JP', 'jordan': 'JO', 'kazakhstan': 'KZ', 'kenya': 'KE',
  'korea': 'KR', 'south korea': 'KR', 'kuwait': 'KW', 'kyrgyzstan': 'KG',
  'laos': 'LA', 'latvia': 'LV', 'lebanon': 'LB', 'liberia': 'LR',
  'libya': 'LY', 'lithuania': 'LT', 'madagascar': 'MG', 'malawi': 'MW',
  'malaysia': 'MY', 'mali': 'ML', 'mauritania': 'MR', 'mauritius': 'MU',
  'mexico': 'MX', 'moldova': 'MD', 'mongolia': 'MN', 'morocco': 'MA',
  'mozambique': 'MZ', 'myanmar': 'MM', 'namibia': 'NA', 'nepal': 'NP',
  'netherlands': 'NL', 'new zealand': 'NZ', 'nicaragua': 'NI', 'niger': 'NE',
  'nigeria': 'NG', 'norway': 'NO', 'oman': 'OM', 'pakistan': 'PK',
  'palestine': 'PS', 'panama': 'PA', 'papua new guinea': 'PG',
  'paraguay': 'PY', 'peru': 'PE', 'philippines': 'PH', 'poland': 'PL',
  'portugal': 'PT', 'qatar': 'QA', 'romania': 'RO', 'russia': 'RU',
  'rwanda': 'RW', 'saudi arabia': 'SA', 'senegal': 'SN', 'serbia': 'RS',
  'sierra leone': 'SL', 'singapore': 'SG', 'slovakia': 'SK', 'slovenia': 'SI',
  'somalia': 'SO', 'south africa': 'ZA', 'spain': 'ES', 'sri lanka': 'LK',
  'sudan': 'SD', 'sweden': 'SE', 'switzerland': 'CH', 'syria': 'SY',
  'taiwan': 'TW', 'tajikistan': 'TJ', 'tanzania': 'TZ', 'thailand': 'TH',
  'togo': 'TG', 'tunisia': 'TN', 'turkey': 'TR', 'turkmenistan': 'TM',
  'uganda': 'UG', 'ukraine': 'UA', 'united arab emirates': 'AE',
  'united kingdom': 'GB', 'united states': 'US', 'uruguay': 'UY',
  'uzbekistan': 'UZ', 'venezuela': 'VE', 'vietnam': 'VN', 'yemen': 'YE',
  'zambia': 'ZM', 'zimbabwe': 'ZW'
};

function countryToIso(countryName) {
  if (!countryName) return '';
  return COUNTRY_TO_ISO[countryName.toLowerCase()] || '';
}

// -----------------------------------------------------------------
// Dynamic cookie & session management
// -----------------------------------------------------------------
let currentCookie = process.env.NEXA_SESSION_COOKIE || '';
let currentSessionToken = '';
let isFirstCookieRefresh = true;

/**
 * Log in to NexaOTP and extract session cookie + token.
 */
async function loginAndExtractCookies() {
  const loginId = process.env.NEXA_LOGIN_ID;
  const password = process.env.NEXA_PASSWORD;

  if (!loginId || !password) {
    return null;
  }

  try {
    if (isFirstCookieRefresh) {
    }

    const payload = {
      email: loginId,
      password: password
    };

    const response = await axios.post(`${BASE_URL}/api/auth/login`, payload, {
      headers: {
        'accept': '*/*',
        'content-type': 'application/json',
        'origin': BASE_URL,
        'referer': `${BASE_URL}/app/login`,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
      },
      // Capture Set-Cookie headers
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400
    });

    const setCookieHeaders = response.headers['set-cookie'];
    if (!setCookieHeaders || setCookieHeaders.length === 0) {
      return null;
    }

    const cookies = {};
    for (const header of setCookieHeaders) {
      const cookiePart = header.split(';')[0].trim();
      const eqIndex = cookiePart.indexOf('=');
      if (eqIndex > 0) {
        const name = cookiePart.substring(0, eqIndex);
        const value = cookiePart.substring(eqIndex + 1);
        cookies[name] = value;
      }
    }

    const cookieString = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    if (isFirstCookieRefresh) {
    }

    return {
      cookie: cookieString,
      token: cookies['session_token'] || ''
    };
  } catch (error) {
    return null;
  }
}

async function refreshCookies() {
  const newAuth = await loginAndExtractCookies();
  if (newAuth) {
    currentCookie = newAuth.cookie;
    currentSessionToken = newAuth.token;
    if (isFirstCookieRefresh) {
      isFirstCookieRefresh = false;
    }
  }
}

async function startCookieRefreshLoop() {
  await refreshCookies();
  setInterval(async () => {
    await refreshCookies();
  }, 1 * 60 * 1000);
}

function getAuthHeaders(referer) {
  return {
    'accept': '*/*',
    'content-type': 'application/json',
    'cookie': currentCookie,
    'host': '63.141.255.227',
    'origin': BASE_URL,
    'referer': referer,
    'x-session-token': currentSessionToken,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
  };
}

// -----------------------------------------------------------------
// API Functions
// -----------------------------------------------------------------

/**
 * Fetches a number from the NexaOTP API.
 */
async function getNumber(range) {
  try {
    if (!currentCookie) {
      throw new Error('No NexaOTP session cookie available. Check NEXA_LOGIN_ID in .env.');
    }

    const response = await axios.post(`${BASE_URL}/api/user/request-number`, {
      range: range,
      format: 'normal'
    }, {
      headers: getAuthHeaders(`${BASE_URL}/app/getnum`),
      timeout: 15000
    });

    const data = response.data;

    // Actual response: { success, country, internal_id, number, number_raw, operator, expires_in }
    if (data && data.success && data.number) {
      const iso = countryToIso(data.country);
      return {
        status: 'success',
        number: data.number,
        iso: iso,
        number_id: data.internal_id
      };
    }

    if (data && data.error) return { status: 'error', message: data.error };
    return { status: 'error', message: data.message || 'Unknown error from NexaOTP' };
  } catch (error) {
    throw error;
  }
}

/**
 * Fetches the OTP history for NexaOTP and maps it to the same format as MK Network
 * so the main bot loop can process both exactly the same way.
 */
async function getHistory(page = 1, limit = 15) {
  try {
    if (!currentCookie) {
      throw new Error('No NexaOTP session cookie available. Check NEXA_LOGIN_ID in .env.');
    }

    const response = await axios.get(`${BASE_URL}/api/user/history?page=${page}&status=success&limit=${limit}`, {
      headers: getAuthHeaders(`${BASE_URL}/app/getnum`),
      timeout: 15000
    });

    if (response.data && response.data.success) {
      // Map NexaOTP data shape -> MK Network data shape
      const mappedData = (response.data.data || []).map(record => {
        return {
          phone_number: record.number, // without '+'
          status: record.status, // "success"
          otps: record.otp,
          full_sms_list: record.message,
          remaining_seconds: 1800 // Dummy value to prevent expiration errors
        };
      });

      return {
        data: mappedData,
        totalPages: response.data.total_pages || 1
      };
    }
    return { data: [], totalPages: 1 };
  } catch (error) {
    return { data: [], totalPages: 1 };
  }
}

/**
 * Fetches the console logs for Range Group.
 */
async function getConsoleLogs() {
  try {
    if (!currentCookie) {
      return []; // Return empty array silently to avoid console spam
    }

    const headers = getAuthHeaders(`${BASE_URL}/app/console`);

    const response = await axios.get(`${BASE_URL}/api/user/console-log`, {
      headers: headers,
      timeout: 15000
    });

    if (response.data && response.data.success && response.data.data) {
      return response.data.data.logs || [];
    }
    return [];
  } catch (error) {
    return [];
  }
}

module.exports = {
  getNumber,
  getHistory,
  startCookieRefreshLoop,
  getConsoleLogs,
  countryToIso
};
