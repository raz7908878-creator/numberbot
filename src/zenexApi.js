const axios = require('axios');

const BASE_URL = 'https://api.zenexnetwork.com/v1';

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

function getApiKey() {
  return process.env.ZENEX_API_KEY || '';
}

async function startCookieRefreshLoop() {
  // Zenex uses a static API key, so no cookie refresh is needed
}

async function getNumber(range) {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new Error('No Zenex API key available. Check ZENEX_API_KEY in .env.');
    }

    const response = await axios.post(`${BASE_URL}/getnum`, {
      range: range,
      is_national: false,
      remove_plus: false
    }, {
      headers: {
        'mapikey': apiKey,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    const data = response.data;

    if (data && data.meta && data.meta.status === 'success' && data.data) {
      const numData = data.data;
      
      let iso = '';
      if (numData.iso && numData.iso.toUpperCase() !== 'UNKNOWN') {
        iso = numData.iso.toUpperCase();
      } else if (numData.country && numData.country.toUpperCase() !== 'UNKNOWN') {
        iso = countryToIso(numData.country);
      }
      
      // Remove any '+' from the number for consistent tracking
      const cleanNumber = (numData.full_number || numData.number).replace('+', '');
      
      return {
        status: 'success',
        number: cleanNumber,
        iso: iso,
        number_id: null // Zenex doesn't use internal_id in getNumber response
      };
    }

    if (data && data.message) return { status: 'error', message: data.message };
    return { status: 'error', message: 'Unknown error from Zenex API' };
  } catch (error) {
    if (error.response && error.response.data && error.response.data.message) {
      return { status: 'error', message: error.response.data.message };
    }
    throw error;
  }
}

async function getHistory(page = 1, limit = 15) {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new Error('No Zenex API key available. Check ZENEX_API_KEY in .env.');
    }

    const response = await axios.get(`${BASE_URL}/numsuccess/info`, {
      headers: {
        'mapikey': apiKey
      },
      timeout: 15000
    });

    if (response.data && response.data.meta && response.data.meta.status === 'success' && response.data.data) {
      const otps = response.data.data.otps || [];
      
      const grouped = {};
      for (const record of otps) {
        const phone = (record.number || '').replace('+', '');
        if (!phone) continue;
        
        if (!grouped[phone]) {
          grouped[phone] = {
            phone_number: phone,
            status: 'success',
            otps: [],
            full_sms_list: [],
            remaining_seconds: 1800
          };
        }
        grouped[phone].otps.push(record.otp);
        grouped[phone].full_sms_list.push(record.otp);
      }

      const mappedData = Object.values(grouped).map(g => ({
        ...g,
        otps: g.otps.join('|||'),
        full_sms_list: g.full_sms_list.join('|||')
      }));

      return {
        data: mappedData,
        totalPages: 1
      };
    }
    return { data: [], totalPages: 1 };
  } catch (error) {
    return { data: [], totalPages: 1 };
  }
}

// Zenex doesn't seem to have a console log endpoint for ranges based on user examples
async function getConsoleLogs() {
  return [];
}

async function getActiveRanges() {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new Error('No Zenex API key available. Check ZENEX_API_KEY in .env.');
    }

    const response = await axios.get(`${BASE_URL}/active-ranges`, {
      headers: {
        'mapikey': apiKey
      },
      timeout: 15000
    });

    if (response.data && response.data.success && response.data.data && response.data.data.active_ranges) {
      return response.data.data.active_ranges;
    }
    return [];
  } catch (error) {
    console.error('Error fetching Zenex active ranges:', error.message);
    return [];
  }
}

module.exports = {
  getNumber,
  getHistory,
  startCookieRefreshLoop,
  getConsoleLogs,
  getActiveRanges,
  countryToIso
};
