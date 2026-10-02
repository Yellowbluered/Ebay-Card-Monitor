'use strict';

/**
 * 價格 / 標題 / 連結 的解析工具。
 * 同時服務 eBay Browse API（結構化）與 Puppeteer 爬蟲（HTML 文字）兩種來源。
 */

/** 各市場幣別代碼 ↔ 符號對照（爬蟲模式用來判斷幣別） */
const CURRENCY_SYMBOLS = [
  { symbol: 'US $', code: 'USD' },
  { symbol: 'C $', code: 'CAD' },
  { symbol: 'AU $', code: 'AUD' },
  { symbol: 'HK $', code: 'HKD' },
  { symbol: 'S $', code: 'SGD' },
  { symbol: 'EUR', code: 'EUR' },
  { symbol: '$', code: 'USD' },
  { symbol: '£', code: 'GBP' },
  { symbol: '€', code: 'EUR' },
  { symbol: '¥', code: 'JPY' },
];

/** 市場 ID → 爬蟲用的網域 */
const MARKETPLACE_DOMAINS = {
  EBAY_US: 'www.ebay.com',
  EBAY_GB: 'www.ebay.co.uk',
  EBAY_DE: 'www.ebay.de',
  EBAY_AT: 'www.ebay.at',
  EBAY_AU: 'www.ebay.com.au',
  EBAY_CA: 'www.ebay.ca',
  EBAY_HK: 'www.ebay.com.hk',
  EBAY_SG: 'www.ebay.com.sg',
  EBAY_IE: 'www.ebay.ie',
  EBAY_FR: 'www.ebay.fr',
  EBAY_IT: 'www.ebay.it',
  EBAY_ES: 'www.ebay.es',
};

/** 市場 ID → 預設幣別 */
const MARKETPLACE_CURRENCY = {
  EBAY_US: 'USD',
  EBAY_GB: 'GBP',
  EBAY_DE: 'EUR',
  EBAY_AT: 'EUR',
  EBAY_AU: 'AUD',
  EBAY_CA: 'CAD',
  EBAY_HK: 'HKD',
  EBAY_SG: 'SGD',
  EBAY_IE: 'EUR',
  EBAY_FR: 'EUR',
  EBAY_IT: 'EUR',
  EBAY_ES: 'EUR',
};

const CURRENCY_SIGN = {
  USD: '$',
  CAD: 'C $',
  AUD: 'A $',
  HKD: 'HK $',
  SGD: 'S $',
  GBP: '£',
  EUR: '€',
  JPY: '¥',
};

function domainForMarketplace(marketplaceId) {
  return MARKETPLACE_DOMAINS[marketplaceId] || MARKETPLACE_DOMAINS.EBAY_US;
}

function currencyForMarketplace(marketplaceId) {
  return MARKETPLACE_CURRENCY[marketplaceId] || 'USD';
}

function signForCurrency(code) {
  return CURRENCY_SIGN[code] || `${code} `;
}

/**
 * 從一段文字解析出價格。
 * 支援：US $1,234.56 / C $5.99 / £3.50 / €12,00 / 12.99 / "12.00 to 20.00"
 * @returns {{value: number|null, currency: string|null, isRange: boolean, low: number|null}}
 */
function parsePrice(input) {
  if (input === null || input === undefined) {
    return { value: null, currency: null, isRange: false, low: null };
  }
  const text = String(input).replace(/\u00a0/g, ' ').trim();
  if (!text) return { value: null, currency: null, isRange: false, low: null };

  let currency = null;
  for (const { symbol, code } of CURRENCY_SYMBOLS) {
    if (text.toUpperCase().includes(symbol.toUpperCase())) {
      currency = code;
      break;
    }
  }

  // 抓出所有數字（含千分位與小數）
  const raw = text.match(/\d[\d.,\s]*\d|\d/g);
  const numbers = [];
  if (raw) {
    for (const chunk of raw) {
      const cleaned = chunk.replace(/\s/g, '');
      let normalized;
      const hasComma = cleaned.includes(',');
      const hasDot = cleaned.includes('.');
      if (hasComma && hasDot) {
        // 1,234.56 → 去掉千分位逗號；1.234,56（歐式）→ 逗號是小數點
        normalized =
          cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
            ? cleaned.replace(/\./g, '').replace(',', '.')
            : cleaned.replace(/,/g, '');
      } else if (hasComma) {
        // 12,00（歐式小數）或 1,234（千分位）
        const decimals = cleaned.split(',').pop();
        normalized = decimals.length === 2 ? cleaned.replace(',', '.') : cleaned.replace(/,/g, '');
      } else {
        normalized = cleaned;
      }
      const n = Number.parseFloat(normalized);
      if (Number.isFinite(n)) numbers.push(n);
    }
  }
  if (!numbers.length) return { value: null, currency, isRange: false, low: null };

  const isRange = numbers.length > 1 && /\b(to|-|–|~)\b/i.test(text);
  const low = Math.min(...numbers);
  const high = Math.max(...numbers);
  return {
    value: isRange ? low : numbers[0],
    currency,
    isRange,
    low,
    high,
    // 區間價（如「US $12.00 to US $20.00」）以低價作為比較基準，並標記起來
    rangeHigh: high,
  };
}

/**
 * 清掉 eBay 標題前後常見的雜訊字樣。
 * 例："New Listing2024 Charizard PSA 10" → "2024 Charizard PSA 10"
 */
function cleanTitle(input) {
  if (!input) return '';
  let text = String(input).replace(/\u00a0/g, ' ');
  text = text.replace(/^\s*new listing\s*/i, '');
  text = text.replace(/^\s*sponsored\s*/i, '');
  text = text.replace(/opens in a new window or tab/gi, '');
  text = text.replace(/new listing/gi, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

/** 從 eBay 商品連結取出 itemId */
function extractItemId(url) {
  if (!url) return null;
  const m = String(url).match(/\/itm\/(?:[^/?#]*\/)?(\d{9,15})/) || String(url).match(/[?&]item=(\d{9,15})/);
  return m ? m[1] : null;
}

/** 移除追蹤參數，保留乾淨可分享的連結 */
function cleanItemUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const keep = new URLSearchParams();
    const itemId = extractItemId(url);
    if (itemId) return `https://${u.hostname}/itm/${itemId}`;
    return `https://${u.hostname}${u.pathname}`;
  } catch {
    return String(url);
  }
}

/** 把字串轉成關鍵字陣列（支援逗號分隔、重複呼叫） */
function toKeywordList(value) {
  if (!value) return [];
  const parts = Array.isArray(value) ? value : String(value).split(',');
  return parts.map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** 標題是否命中任何黑名單關鍵字 */
function matchesAnyKeyword(title, keywords) {
  if (!keywords || !keywords.length) return false;
  const haystack = String(title || '').toLowerCase();
  return keywords.some((k) => haystack.includes(k));
}

module.exports = {
  CURRENCY_SYMBOLS,
  MARKETPLACE_DOMAINS,
  MARKETPLACE_CURRENCY,
  domainForMarketplace,
  currencyForMarketplace,
  signForCurrency,
  parsePrice,
  cleanTitle,
  extractItemId,
  cleanItemUrl,
  toKeywordList,
  matchesAnyKeyword,
};
