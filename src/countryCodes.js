// Mapping of dialing codes to ISO 3166-1 alpha-2 country codes
const DIALING_CODES = {
  '1': 'US', '7': 'RU', '20': 'EG', '27': 'ZA', '30': 'GR', '31': 'NL', '32': 'BE', '33': 'FR',
  '34': 'ES', '36': 'HU', '39': 'IT', '40': 'RO', '41': 'CH', '43': 'AT', '44': 'GB', '45': 'DK',
  '46': 'SE', '47': 'NO', '48': 'PL', '49': 'DE', '51': 'PE', '52': 'MX', '53': 'CU', '54': 'AR',
  '55': 'BR', '56': 'CL', '57': 'CO', '58': 'VE', '60': 'MY', '61': 'AU', '62': 'ID', '63': 'PH',
  '64': 'NZ', '65': 'SG', '66': 'TH', '81': 'JP', '82': 'KR', '84': 'VN', '86': 'CN', '90': 'TR',
  '91': 'IN', '92': 'PK', '93': 'AF', '94': 'LK', '95': 'MM', '98': 'IR', '211': 'SS', '212': 'MA',
  '213': 'DZ', '216': 'TN', '218': 'LY', '220': 'GM', '221': 'SN', '222': 'MR', '223': 'ML',
  '224': 'GN', '225': 'CI', '226': 'BF', '227': 'NE', '228': 'TG', '229': 'BJ', '230': 'MU',
  '231': 'LR', '232': 'SL', '233': 'GH', '234': 'NG', '235': 'TD', '236': 'CF', '237': 'CM',
  '238': 'CV', '239': 'ST', '240': 'GQ', '241': 'GA', '242': 'CG', '243': 'CD', '244': 'AO',
  '245': 'GW', '246': 'IO', '247': 'AC', '248': 'SC', '249': 'SD', '250': 'RW', '251': 'ET',
  '252': 'SO', '253': 'DJ', '254': 'KE', '255': 'TZ', '256': 'UG', '257': 'BI', '258': 'MZ',
  '260': 'ZM', '261': 'MG', '262': 'RE', '263': 'ZW', '264': 'NA', '265': 'MW', '266': 'LS',
  '267': 'BW', '268': 'SZ', '269': 'KM', '290': 'SH', '291': 'ER', '297': 'AW', '298': 'FO',
  '299': 'GL', '350': 'GI', '351': 'PT', '352': 'LU', '353': 'IE', '354': 'IS', '355': 'AL',
  '356': 'MT', '357': 'CY', '358': 'FI', '359': 'BG', '370': 'LT', '371': 'LV', '372': 'EE',
  '373': 'MD', '374': 'AM', '375': 'BY', '376': 'AD', '377': 'MC', '378': 'SM', '379': 'VA',
  '380': 'UA', '381': 'RS', '382': 'ME', '383': 'XK', '385': 'HR', '386': 'SI', '387': 'BA',
  '389': 'MK', '420': 'CZ', '421': 'SK', '423': 'LI', '500': 'FK', '501': 'BZ', '502': 'GT',
  '503': 'SV', '504': 'HN', '505': 'NI', '506': 'CR', '507': 'PA', '508': 'PM', '509': 'HT',
  '590': 'GP', '591': 'BO', '592': 'GY', '593': 'EC', '594': 'GF', '595': 'PY', '596': 'MQ',
  '597': 'SR', '598': 'UY', '599': 'CW', '670': 'TL', '672': 'NF', '673': 'BN', '674': 'NR',
  '675': 'PG', '676': 'TO', '677': 'SB', '678': 'VU', '679': 'FJ', '680': 'PW', '681': 'WF',
  '682': 'CK', '683': 'NU', '685': 'WS', '686': 'KI', '687': 'NC', '688': 'TV', '689': 'PF',
  '690': 'TK', '691': 'FM', '692': 'MH', '850': 'KP', '852': 'HK', '853': 'MO', '855': 'KH',
  '856': 'LA', '880': 'BD', '886': 'TW', '960': 'MV', '961': 'LB', '962': 'JO', '963': 'SY',
  '964': 'IQ', '965': 'KW', '966': 'SA', '967': 'YE', '968': 'OM', '970': 'PS', '971': 'AE',
  '972': 'IL', '973': 'BH', '974': 'QA', '975': 'BT', '976': 'MN', '977': 'NP', '992': 'TJ',
  '993': 'TM', '994': 'AZ', '995': 'GE', '996': 'KG', '998': 'UZ'
};

function getIsoFromRange(range) {
  if (!range) return null;
  // Check 3 digits first
  if (range.length >= 3 && DIALING_CODES[range.substring(0, 3)]) {
    return DIALING_CODES[range.substring(0, 3)];
  }
  // Check 2 digits
  if (range.length >= 2 && DIALING_CODES[range.substring(0, 2)]) {
    return DIALING_CODES[range.substring(0, 2)];
  }
  // Check 1 digit (like US or Russia)
  if (range.length >= 1 && DIALING_CODES[range.substring(0, 1)]) {
    return DIALING_CODES[range.substring(0, 1)];
  }
  return null;
}

const ISO_TO_COUNTRY = {
  'AF': 'Afghanistan', 'AL': 'Albania', 'DZ': 'Algeria', 'AO': 'Angola', 'AR': 'Argentina',
  'AM': 'Armenia', 'AU': 'Australia', 'AT': 'Austria', 'AZ': 'Azerbaijan', 'BH': 'Bahrain',
  'BD': 'Bangladesh', 'BY': 'Belarus', 'BE': 'Belgium', 'BJ': 'Benin', 'BO': 'Bolivia',
  'BR': 'Brazil', 'BF': 'Burkina Faso', 'BI': 'Burundi', 'KH': 'Cambodia', 'CM': 'Cameroon',
  'CA': 'Canada', 'CV': 'Cape Verde', 'CF': 'Central African Republic', 'TD': 'Chad',
  'CL': 'Chile', 'CN': 'China', 'CO': 'Colombia', 'KM': 'Comoros', 'CG': 'Congo',
  'CD': 'DR Congo', 'CR': 'Costa Rica', 'CI': 'Ivory Coast', 'HR': 'Croatia', 'CU': 'Cuba',
  'CY': 'Cyprus', 'CZ': 'Czechia', 'DK': 'Denmark', 'DJ': 'Djibouti', 'DO': 'Dominican Republic',
  'EC': 'Ecuador', 'EG': 'Egypt', 'SV': 'El Salvador', 'GQ': 'Equatorial Guinea', 'ER': 'Eritrea',
  'EE': 'Estonia', 'ET': 'Ethiopia', 'FI': 'Finland', 'FR': 'France', 'GA': 'Gabon',
  'GM': 'Gambia', 'GE': 'Georgia', 'DE': 'Germany', 'GH': 'Ghana', 'GR': 'Greece',
  'GT': 'Guatemala', 'GN': 'Guinea', 'GW': 'Guinea-Bissau', 'GY': 'Guyana', 'HT': 'Haiti',
  'HN': 'Honduras', 'HK': 'Hong Kong', 'HU': 'Hungary', 'IS': 'Iceland', 'IN': 'India',
  'ID': 'Indonesia', 'IR': 'Iran', 'IQ': 'Iraq', 'IE': 'Ireland', 'IL': 'Israel',
  'IT': 'Italy', 'JM': 'Jamaica', 'JP': 'Japan', 'JO': 'Jordan', 'KZ': 'Kazakhstan',
  'KE': 'Kenya', 'KR': 'South Korea', 'KP': 'North Korea', 'KW': 'Kuwait', 'KG': 'Kyrgyzstan',
  'LA': 'Laos', 'LV': 'Latvia', 'LB': 'Lebanon', 'LR': 'Liberia', 'LY': 'Libya',
  'LT': 'Lithuania', 'LU': 'Luxembourg', 'MO': 'Macau', 'MG': 'Madagascar', 'MW': 'Malawi',
  'MY': 'Malaysia', 'MV': 'Maldives', 'ML': 'Mali', 'MT': 'Malta', 'MR': 'Mauritania',
  'MU': 'Mauritius', 'MX': 'Mexico', 'MD': 'Moldova', 'MN': 'Mongolia', 'ME': 'Montenegro',
  'MA': 'Morocco', 'MZ': 'Mozambique', 'MM': 'Myanmar', 'NA': 'Namibia', 'NP': 'Nepal',
  'NL': 'Netherlands', 'NZ': 'New Zealand', 'NI': 'Nicaragua', 'NE': 'Niger', 'NG': 'Nigeria',
  'MK': 'North Macedonia', 'NO': 'Norway', 'OM': 'Oman', 'PK': 'Pakistan', 'PS': 'Palestine',
  'PA': 'Panama', 'PG': 'Papua New Guinea', 'PY': 'Paraguay', 'PE': 'Peru', 'PH': 'Philippines',
  'PL': 'Poland', 'PT': 'Portugal', 'QA': 'Qatar', 'RO': 'Romania', 'RU': 'Russia',
  'RW': 'Rwanda', 'SA': 'Saudi Arabia', 'SN': 'Senegal', 'RS': 'Serbia', 'SL': 'Sierra Leone',
  'SG': 'Singapore', 'SK': 'Slovakia', 'SI': 'Slovenia', 'SO': 'Somalia', 'ZA': 'South Africa',
  'SS': 'South Sudan', 'ES': 'Spain', 'LK': 'Sri Lanka', 'SD': 'Sudan', 'SR': 'Suriname',
  'SZ': 'Eswatini', 'SE': 'Sweden', 'CH': 'Switzerland', 'SY': 'Syria', 'TW': 'Taiwan',
  'TJ': 'Tajikistan', 'TZ': 'Tanzania', 'TH': 'Thailand', 'TG': 'Togo', 'TN': 'Tunisia',
  'TR': 'Turkey', 'TM': 'Turkmenistan', 'UG': 'Uganda', 'UA': 'Ukraine', 'AE': 'UAE',
  'GB': 'United Kingdom', 'US': 'United States', 'UY': 'Uruguay', 'UZ': 'Uzbekistan',
  'VE': 'Venezuela', 'VN': 'Vietnam', 'YE': 'Yemen', 'ZM': 'Zambia', 'ZW': 'Zimbabwe',
  'AD': 'Andorra', 'MC': 'Monaco', 'SM': 'San Marino', 'VA': 'Vatican', 'BA': 'Bosnia',
  'XK': 'Kosovo', 'LI': 'Liechtenstein', 'BG': 'Bulgaria', 'BZ': 'Belize', 'BN': 'Brunei',
  'BT': 'Bhutan', 'BW': 'Botswana', 'LS': 'Lesotho', 'SC': 'Seychelles', 'ST': 'São Tomé',
  'IO': 'BIOT', 'AC': 'Ascension', 'RE': 'Réunion', 'SH': 'Saint Helena', 'AW': 'Aruba',
  'FO': 'Faroe Islands', 'GL': 'Greenland', 'GI': 'Gibraltar', 'FK': 'Falkland Islands',
  'PM': 'Saint Pierre', 'GP': 'Guadeloupe', 'GF': 'French Guiana', 'MQ': 'Martinique',
  'CW': 'Curaçao', 'TL': 'Timor-Leste', 'NF': 'Norfolk Island', 'NR': 'Nauru',
  'TO': 'Tonga', 'SB': 'Solomon Islands', 'VU': 'Vanuatu', 'FJ': 'Fiji', 'PW': 'Palau',
  'WF': 'Wallis & Futuna', 'CK': 'Cook Islands', 'NU': 'Niue', 'WS': 'Samoa',
  'KI': 'Kiribati', 'NC': 'New Caledonia', 'TV': 'Tuvalu', 'PF': 'French Polynesia',
  'TK': 'Tokelau', 'FM': 'Micronesia', 'MH': 'Marshall Islands'
};

function getCountryFromIso(iso) {
  if (!iso) return null;
  return ISO_TO_COUNTRY[iso.toUpperCase()] || null;
}

module.exports = {
  getIsoFromRange,
  getCountryFromIso,
  DIALING_CODES,
  ISO_TO_COUNTRY
};
