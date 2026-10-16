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

/** 簽名標記（含 Signature / Signed / Sign / Sig、PSA/DNA 認證等變體） */
const AUTO_MARKERS = ['auto', 'autograph', 'autographed', "auto'd", 'signature', 'signed', 'sign', 'sig', 'dna', 'psa/dna'];

/** 簽名/認證多字片語（需整段字串比對，避免只靠 token 拆解而漏判，如 PSA AUTO 10） */
const AUTO_PHRASE_MARKERS = ['psa auto', 'auto 10'];

/** 「One of One / 1 of 1」極稀缺平行（等同 1/1） */
const ONE_OF_ONE_RE = /\b(?:one\s*of\s*one|1\s*of\s*1|one\s*of\s*1|1\s*of\s*one)\b/i;

/** 常見「/N 限量編號」分母集合（對齊 Python 版 SERIAL_PRINT_RUNS，含中高編號平行，補齊 /199 /299 /399 …） */
const SERIAL_PRINT_RUNS = new Set([
  1, 5, 10, 15, 20, 25, 35, 45, 49, 50, 65, 75, 99, 100, 125, 149,
  150, 175, 199, 200, 250, 299, 300, 350, 399, 400, 500,
]);

/**
 * 平行 / 顏色 / 樣式「單一 token」稀缺標記（第二道防呆）。
 * 注意：不含「base」——base 正是普卡本體，不是稀缺訊號。
 */
const PARALLEL_MARKERS = new Set([
  'refractor', 'x-fractor', 'fractor', 'silver', 'gold', 'holo', 'holofoil',
  'reverse', 'mojo', 'pulsar', 'velocity', 'disco', 'hyper', 'wave', 'atomic',
  'sepia', 'negative', 'pink', 'blue', 'green', 'red', 'purple', 'orange',
  'yellow', 'teal', 'cracked', 'ice', 'diamond', 'rainbow', 'checkerboard',
  'numbered', 'serial', 'jersey', 'relic', 'patch', 'tiger', 'zebra',
  'galactic', 'nebula', 'shimmer', 'sparkle', 'retro', 'throwback', 'logo',
  'variation', 'sp', 'ssp', 'insert', 'stained', 'glass', 'white',
]);

/**
 * 以「原始標題文字」判斷是否含限量 / 簽名訊號（防呆）。
 * 涵蓋：Auto / Signature / Signed / Sign / Sig、PSA/DNA、PSA Auto 10、
 *       1/1 / One of One / 1 of 1、低編號 /5 /10 /25 /199 …、
 *       平行/顏色/樣式（Refractor / Silver / Gold / Red / Mojo / Rainbow …）。
 */
function titleHasScarcitySignal(title) {
  if (!title) return false;
  const lower = String(title).toLowerCase();
  const tokens = lower.match(/[a-z0-9'/]+/g) || [];
  if (tokens.some((t) => AUTO_MARKERS.includes(t))) return true;
  if (tokens.some((t) => PARALLEL_MARKERS.has(t))) return true;
  if (AUTO_PHRASE_MARKERS.some((p) => lower.includes(p))) return true;
  if (ONE_OF_ONE_RE.test(lower)) return true;
  const serials = lower.match(/\/(\d{1,4})/g) || [];
  for (const s of serials) {
    const denom = parseInt(s.slice(1), 10);
    if (SERIAL_PRINT_RUNS.has(denom)) return true;
  }
  return false;
}

/**
 * 查詢關鍵字本身不含限量/簽名訊號時，視為普卡查詢。
 * 會先移除 eBay 負向排除詞（-auto、-/10 …），因為那代表「排除」而非「我要找」。
 */
function queryIsBase(query) {
  const positive = String(query || '')
    .split(/\s+/)
    .filter((t) => t && !t.startsWith('-'))
    .join(' ');
  return !titleHasScarcitySignal(positive);
}

/* ── 關鍵字正規化（防呆） ───────────────────────────────── */

/** 評級機構別名 → 正規化大寫（對齊 Python 版 GRADING_COMPANIES） */
const GRADING_COMPANIES = {
  psa: 'PSA',
  bgs: 'BGS',
  beckett: 'BGS',
  cgc: 'CGC',
  sgc: 'SGC',
  csg: 'CSG',
  ksa: 'KSA',
};

/** 連寫評級詞（psa10、bgs9.5、cgc10 …）→ 分開 + 大寫（PSA 10、BGS 9.5、CGC 10 …） */
const GRADING_CONCAT_RE = /\b(psa|bgs|beckett|cgc|sgc|csg|ksa)(\d+(?:\.\d+)?)(?![.\d])/gi;

/** 連寫卡號（js1、rc1、op01 …）→ 帶連字號標準格式（JS-1、RC-1、OP-01 …）；單字母前綴（如 f1）不處理以免誤傷搜尋詞 */
const CARD_NUMBER_RE = /\b([a-z]{2,4})(\d{1,4})\b(?!-)/gi;

/**
 * 關鍵字自動正規化（防呆），在送給 eBay / 外部 API 前先跑：
 *   1. 評級詞補空格：psa10 → PSA 10、psa9 → PSA 9、bgs9.5 → BGS 9.5、cgc10 → CGC 10。
 *   2. 卡號標準化：js1 / rc1 等連寫卡號 → JS-1 / RC-1（eBay 搜尋不區分大小寫）。
 *   3. 收斂多餘空白。
 * 此函式冪等（重複套用結果不變）。
 */
function normalizeKeyword(input) {
  if (input === null || input === undefined) return '';
  let text = String(input).replace(/\u00a0/g, ' ').trim();
  if (!text) return '';
  text = text.replace(GRADING_CONCAT_RE, (match, co, grade) => {
    const canon = GRADING_COMPANIES[String(co).toLowerCase()] || String(co).toUpperCase();
    return `${canon} ${grade}`;
  });
  text = text.replace(CARD_NUMBER_RE, (match, letters, digits) => `${String(letters).toUpperCase()}-${digits}`);
  return text.replace(/\s+/g, ' ').trim();
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
  titleHasScarcitySignal,
  queryIsBase,
  normalizeKeyword,
  GRADING_COMPANIES,
};
