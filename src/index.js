#!/usr/bin/env node
'use strict';

/**
 * eBay 卡牌價格掃描器 — 單檔版（self-contained）
 * =====================================================================
 * 一支檔案跑完全部功能，不需要任何其他 src/*.js：
 *
 *   1. 市場 / 幣別對照表             （原 src/parse.js）
 *   2. 文字 / 價格解析               （原 src/parse.js）
 *   3. .env 與 CLI 參數              （原 src/config.js）
 *   4. 價格統計（平均 / IQR）         （原 src/stats.js）
 *   5. 報表輸出（表格 / CSV / JSON）   （原 src/report.js）
 *   6. eBay Browse API 客戶端        （原 src/ebayApi.js）
 *   7. 爬蟲共用邏輯                  （原 src/scrapeShared.js）
 *   8. Playwright 爬蟲引擎           （原 src/ebayPlaywright.js）
 *   9. Puppeteer 爬蟲引擎            （原 src/ebayScraper.js）
 *  10. 資料來源選擇                  （原 src/sources.js）
 *  11. 主流程                       （原 src/index.js）
 *
 * 資料來源：--source api（官方 API） / scrape（瀏覽器爬蟲） / auto（預設）
 * 爬蟲引擎：--engine playwright（預設）或 --engine puppeteer
 *
 * 依賴：Node.js >= 18（內建 fetch），API 模式零依賴；
 *      爬蟲模式才需要 optionalDependencies（playwright 或 puppeteer）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** 進度 / 警告訊息一律走 stderr，讓 stdout 只留乾淨的結果（方便管線處理） */
const stderrLog = (msg) => process.stderr.write(`${msg}\n`);

/* ═══════════════════════════════════════════════════════════════════
 * 1. 市場 / 幣別對照表（原 src/parse.js）
 * ═══════════════════════════════════════════════════════════════════ */

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

/** 幣別代碼 → 顯示符號 */
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

/* ═══════════════════════════════════════════════════════════════════
 * 2. 文字 / 價格 / 連結解析（原 src/parse.js）
 *    同時服務 eBay Browse API（結構化）與爬蟲（HTML 文字）兩種來源。
 * ═══════════════════════════════════════════════════════════════════ */

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

/* ═══════════════════════════════════════════════════════════════════
 * 3. .env 載入與 CLI 參數（原 src/config.js）
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * 極簡 .env 解析器（不引入 dotenv，讓 API 模式零依賴即可執行）。
 * 支援：KEY=VALUE、# 註解、單/雙引號包覆、行內 # 註解。
 */
function parseEnvFile(content) {
  const out = {};
  for (const line of String(content).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (!key) continue;

    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/** 載入 .env（已存在的 process.env 優先，不會被覆蓋） */
function loadEnv(envPath = path.join(ROOT, '.env')) {
  if (!fs.existsSync(envPath)) return { loaded: false, path: envPath, keys: [] };
  const parsed = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  const keys = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined || process.env[k] === '') {
      process.env[k] = v;
      keys.push(k);
    }
  }
  return { loaded: true, path: envPath, keys };
}

function camel(name) {
  return name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * 解析 CLI 參數。
 * 支援 --key value / --key=value / --flag / --no-flag（flag 會變成 false）
 */
function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      opts._.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      let key = token.slice(2);
      let value = true;
      const eq = key.indexOf('=');
      if (eq !== -1) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (key.startsWith('no-')) {
        key = key.slice(3);
        value = false;
      } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
        value = argv[i + 1];
        i += 1;
      }
      opts[camel(key)] = value;
    } else if (token.startsWith('-') && token.length > 1 && !/^-\d/.test(token)) {
      opts[camel(token.slice(1))] = true;
    } else {
      opts._.push(token);
    }
  }
  return opts;
}

function num(value, fallback) {
  if (value === undefined || value === null || value === '' || value === true) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return fallback;
}

function str(value, fallback = '') {
  if (value === undefined || value === null || value === true || value === false) return fallback;
  const s = String(value).trim();
  return s === '' ? fallback : s;
}

/** 載入根目錄 presets.json（不存在就回傳 null；解析失敗則拋出明確錯誤） */
function loadPresets() {
  const file = path.join(ROOT, 'presets.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`presets.json 解析失敗：${err.message}`);
  }
}

/**
 * 解析「@別名」或 --preset：回傳 { name, data, extra }。
 * extra = 別名之後額外輸入的關鍵字（例：`@onepiece psa 10` 的 "psa 10"）。
 * 找不到別名時丟出含「可用別名清單」的錯誤。
 */
function resolvePreset(args) {
  const presets = loadPresets();
  let alias = str(args.preset, '');
  const positional = Array.isArray(args._) ? args._ : [];

  if (!alias) {
    for (const token of positional) {
      const m = /^@([A-Za-z0-9_\-]+)$/.exec(token);
      if (m) {
        alias = m[1];
        break;
      }
    }
  }
  if (!alias) return null;

  const data = presets && presets[alias];
  if (!data) {
    const available = presets
      ? Object.keys(presets).filter((k) => !k.startsWith('_')).map((k) => `@${k}`).join(', ')
      : '（尚無 presets.json）';
    throw new Error(
      `找不到預設別名「@${alias}」。可用：${available}\n` +
        `（請在 presets.json 加入你的別名，格式見 README.md「預設別名」；可用 node src/index.js --list-presets 查看）`
    );
  }

  const extra = positional.filter((t) => !/^@/.test(t)).join(' ').trim();
  return { name: alias, data, extra };
}

const DEFAULT_EXCLUDE = ['reprint', 'proxy', 'digital', 'custom art'];

const HELP = `
eBay 卡牌價格掃描器 — 找出「在售（未售出）」且價格 <= 平均價的甜甜價

用法：
  node src/index.js "<搜尋關鍵字>" [選項]
  node src/index.js --demo                 # 用內建範例資料離線示範

資料來源：
  --source api     使用 eBay Browse API（需 .env 填 EBAY_CLIENT_ID / EBAY_CLIENT_SECRET）
  --source scrape  用模擬瀏覽器爬取搜尋頁（需安裝 optionalDependencies）
  --source auto    預設：有 API 憑證走 API，否則自動退回爬蟲
  --engine playwright|puppeteer   爬蟲引擎（預設 playwright）

共通選項：
  --marketplace EBAY_US|EBAY_GB|EBAY_HK|...   市場（預設 EBAY_US）
  --currency USD                              只看某幣別（預設沿用市場幣別）
  --limit 200                                 取幾筆「在售」商品（Browse API 單次上限 200）
  --pages 1                                   API = 抓幾批；scrape = 翻幾頁
  --top 25                                    最多列出幾筆甜甜價（0 = 全部）
  --baseline mean|median|trimmed              平均價基準（預設 mean，且已先濾離群值）
  --trim 0.1                                  baseline=trimmed 時的修剪比例
  --no-outlier-filter                         關閉 IQR 離群值過濾
  --iqr-k 1.5                                 IQR 倍數
  --min-discount 0                            只列「低於平均價至少 N%」的商品
  --min-price / --max-price                   價格區間（濾掉散卡配件、整箱、天價贗品）
  --condition NEW|USED|...                    品相過濾（API 模式）
  --buying fixed|auction|all                  只看直購 / 只看競標 / 全部（預設 fixed）
  --exclude "reprint,proxy"                   標題黑名單關鍵字
  --sort price|newest                         排序（API 模式）
  --out report.csv                            匯出檔案（依副檔名存 CSV 或 JSON）
  --json                                      直接用 JSON 印出結果
  --seller-info                               額外顯示賣家與運費欄位

爬蟲模式選項（--source scrape）：
  --engine playwright|puppeteer               引擎：playwright（預設）或 puppeteer
  --headed                                    顯示瀏覽器視窗（除錯用）
  --browser-channel chrome|msedge             使用本機已安裝的瀏覽器，免下載 Chromium
  --delay 1500                                翻頁間隔（毫秒）

預設別名（更快搵卡，配合 presets.json）：
  node src/index.js @onepiece                 展開別名（@名稱 = 讀 presets.json）
  node src/index.js @onepiece psa 10          別名 + 額外關鍵字
  --preset pokemon                            等同 @pokemon
  --category 183454                           鎖定 eBay 分類（爬蟲 _sacat / API category_ids）
  --list-presets                              列出 presets.json 所有可用別名

成交價基準（--sold-ref，用爬蟲抓「已售出」當基準）：
  node src/index.js "charizard psa 10" --source scrape --sold-ref
  --sold-pages 2                              抓幾頁「已售出」做基準（預設 2）
  --sold-vs 15                                在售價 vs 成交中位數的 貴/合理/抵買 門檻 %（預設 15）

其他：
  --debug                                     印出除錯資訊（HTML 大小、實際請求網址）
  -h, --help                                  顯示本說明
`;

/**
 * 組出最終設定。
 * @param {string[]} argv process.argv.slice(2)
 */
function buildConfig(argv) {
  const envInfo = loadEnv();
  const args = parseArgs(argv);
  const preset = resolvePreset(args);
  const p = preset ? preset.data : {};

  // 查詢字串：CLI --query 優先；其次 preset.query（再串上別名後的額外關鍵字）；最後才是位置參數
  const positionalQuery = args._.join(' ').trim();
  let query = str(args.query, '');
  if (!query && preset) {
    query = [str(p.query, ''), preset.extra].filter(Boolean).join(' ').trim();
  }
  if (!query) query = positionalQuery;

  const marketplace = str(args.marketplace, str(p.marketplace, process.env.EBAY_MARKETPLACE || 'EBAY_US')).toUpperCase();
  const source = str(args.source, str(p.source, 'auto')).toLowerCase();
  const hasApiCreds = Boolean(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET);

  let resolvedSource = source;
  if (source === 'auto') resolvedSource = hasApiCreds ? 'api' : 'scrape';

  // 黑名單：CLI --exclude 完全取代預設；preset.exclude 則「併入」預設（而非取代）
  let exclude = DEFAULT_EXCLUDE;
  if (args.exclude !== undefined) {
    exclude =
      args.exclude === '' || args.exclude === false
        ? []
        : str(args.exclude)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
  } else if (p.exclude !== undefined) {
    exclude = Array.from(new Set([...DEFAULT_EXCLUDE, ...toKeywordList(p.exclude)]));
  }

  const minPriceFromPreset = p.minPrice != null ? num(p.minPrice, null) : null;
  const maxPriceFromPreset = p.maxPrice != null ? num(p.maxPrice, null) : null;

  return {
    argv,
    envInfo,
    preset: preset ? preset.name : null,
    help: Boolean(args.help || args.h),
    listPresets: Boolean(args.listPresets),
    demo: Boolean(args.demo),
    query,
    source,
    resolvedSource,
    hasApiCreds,
    marketplace,
    currency: str(args.currency, str(p.currency, str(process.env.EBAY_CURRENCY, ''))) || null,
    limit: Math.max(1, Math.min(num(args.limit, num(p.limit, 200)), 200)),
    pages: Math.max(1, num(args.pages, num(p.pages, 1))),
    top: Math.max(0, num(args.top, 25)),
    baseline: str(args.baseline, 'mean').toLowerCase(),
    trim: num(args.trim, 0.1),
    outlierFilter: bool(args.outlierFilter, true),
    iqrK: num(args.iqrK, 1.5),
    minDiscount: num(args.minDiscount, 0),
    minPrice: args.minPrice === undefined ? minPriceFromPreset : num(args.minPrice, null),
    maxPrice: args.maxPrice === undefined ? maxPriceFromPreset : num(args.maxPrice, null),
    condition: str(args.condition, str(p.condition, '')) || null,
    buying: str(args.buying, str(p.buying, 'fixed')).toLowerCase(),
    sort: str(args.sort, str(p.sort, 'price')).toLowerCase(),
    exclude,
    category: str(args.category, str(p.category, '')),
    out: str(args.out, '') || null,
    json: Boolean(args.json),
    sellerInfo: Boolean(args.sellerInfo),
    debug: Boolean(args.debug),
    // 爬蟲相關
    scraperEngine: str(args.engine, str(process.env.SCRAPER_ENGINE, 'playwright')).toLowerCase(),
    headed: Boolean(args.headed),
    browserChannel: str(args.browserChannel, str(process.env.SCRAPER_CHANNEL, '')) || null,
    delayMs: num(args.delay, num(process.env.SCRAPER_DELAY_MS, 1500)),
    scraperHeadless: bool(process.env.SCRAPER_HEADLESS, true),
    // 成交價基準（爬蟲版）
    soldRef: bool(args.soldRef, false),
    soldVsPct: num(args.soldVs, num(process.env.SOLD_VS_PCT, 15)),
    soldPages: Math.max(1, num(args.soldPages, num(process.env.SOLD_PAGES, 2))),
    // API 相關
    ebayEnv: str(process.env.EBAY_ENV, 'production').toLowerCase(),
  };
}

/* ═══════════════════════════════════════════════════════════════════
 * 4. 價格統計（原 src/stats.js）
 *    平均價、中位數、修剪平均、IQR 離群值過濾。
 *    集換式卡牌價格分布非常偏斜（同一張卡可以 $20 也可以 $5000），
 *    所以預設先用 Tukey IQR 濾掉極端值，再算平均價，避免平均價被灌水。
 * ═══════════════════════════════════════════════════════════════════ */

function sum(values) {
  return values.reduce((acc, v) => acc + v, 0);
}

function mean(values) {
  return values.length ? sum(values) / values.length : 0;
}

/** 分位數（線性插值），values 必須是「已升冪排序」的陣列 */
function quantileSorted(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function quantile(values, p) {
  return quantileSorted([...values].sort((a, b) => a - b), p);
}

function median(values) {
  return quantile(values, 0.5);
}

/** 樣本標準差 */
function stddev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(sum(values.map((v) => (v - m) ** 2)) / (values.length - 1));
}

/** 修剪平均（頭尾各去掉 trim 比例） */
function trimmedMean(values, trim = 0.1) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * Math.min(Math.max(trim, 0), 0.49));
  const kept = sorted.slice(cut, sorted.length - cut);
  return mean(kept.length ? kept : sorted);
}

/** Tukey IQR 上下界 */
function iqrBounds(values, k = 1.5) {
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantileSorted(sorted, 0.25);
  const q3 = quantileSorted(sorted, 0.75);
  const iqr = q3 - q1;
  return { q1, q3, iqr, lower: q1 - k * iqr, upper: q3 + k * iqr };
}

/**
 * @param {number[]} values 價格陣列
 * @param {object} options
 * @param {'mean'|'median'|'trimmed'} [options.baseline] 用哪個當「平均價」基準
 * @param {number} [options.trim] 修剪比例（baseline=trimmed 時使用）
 * @param {boolean} [options.outlierFilter] 是否用 IQR 濾離群值
 * @param {number} [options.iqrK] IQR 倍數，預設 1.5
 */
function summarize(values, options = {}) {
  const { baseline = 'mean', trim = 0.1, outlierFilter = true, iqrK = 1.5 } = options;

  const all = values.filter((v) => Number.isFinite(v) && v > 0);
  const bounds = iqrBounds(all, iqrK);
  const used = outlierFilter ? all.filter((v) => v >= bounds.lower && v <= bounds.upper) : all;
  const effective = used.length ? used : all;

  if (!effective.length) {
    return {
      count: all.length,
      usedCount: 0,
      removed: 0,
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      trimmedMean: 0,
      stddev: 0,
      q1: 0,
      q3: 0,
      iqr: 0,
      bounds,
      baseline: 0,
      baselineKind: baseline,
      usedValues: [],
    };
  }

  const sorted = [...effective].sort((a, b) => a - b);
  const avg = mean(effective);
  const med = median(effective);
  const trimmed = trimmedMean(effective, trim);

  let base;
  if (baseline === 'median') base = med;
  else if (baseline === 'trimmed') base = trimmed;
  else base = avg;

  return {
    count: all.length,
    usedCount: effective.length,
    removed: all.length - effective.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: avg,
    median: med,
    trimmedMean: trimmed,
    stddev: stddev(effective),
    q1: bounds.q1,
    q3: bounds.q3,
    iqr: bounds.iqr,
    bounds,
    baseline: base,
    baselineKind: baseline,
    usedValues: effective,
  };
}

/** 相對基準價的折扣百分比（正值 = 比平均便宜） */
function discountPercent(price, baseline) {
  if (!Number.isFinite(price) || !Number.isFinite(baseline) || baseline <= 0) return 0;
  return ((baseline - price) / baseline) * 100;
}

/**
 * 篩出「甜甜價」：價格 <= 基準價 * (1 - minDiscount/100)
 * 依價格升冪排序（最便宜在前）。
 */
function findDeals(listings, stats, options = {}) {
  const { minDiscountPct = 0, top = 25, priceAccessor } = options;
  const getPrice = priceAccessor || ((l) => l.price);
  const baseline = stats.baseline;
  if (!(baseline > 0)) return [];

  const threshold = baseline * (1 - minDiscountPct / 100);

  return listings
    .map((l) => ({ listing: l, price: getPrice(l) }))
    .filter(({ price }) => Number.isFinite(price) && price > 0 && price <= threshold)
    .map(({ listing, price }) => ({
      listing,
      price,
      discountPct: discountPercent(price, baseline),
      delta: baseline - price,
    }))
    .sort((a, b) => a.price - b.price)
    .slice(0, top > 0 ? top : undefined);
}

/* ═══════════════════════════════════════════════════════════════════
 * 5. 報表輸出：表格 / 摘要 / CSV / JSON（原 src/report.js）
 * ═══════════════════════════════════════════════════════════════════ */

/** 中日韓全形字算 2 寬，讓表格在終端能對齊 */
function displayWidth(str) {
  let width = 0;
  for (const ch of String(str ?? '')) {
    const code = ch.codePointAt(0);
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3041 && code <= 0x33ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xa000 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff);
    width += wide ? 2 : 1;
  }
  return width;
}

function truncate(str, max) {
  const text = String(str ?? '');
  if (!max || max <= 0) return text;
  if (displayWidth(text) <= max) return text;
  let out = '';
  let width = 0;
  for (const ch of text) {
    const w = displayWidth(ch);
    if (width + w > max - 1) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
}

function padEnd(str, width) {
  const diff = width - displayWidth(str);
  return diff > 0 ? String(str) + ' '.repeat(diff) : String(str);
}

function padStart(str, width) {
  const diff = width - displayWidth(str);
  return diff > 0 ? ' '.repeat(diff) + String(str) : String(str);
}

/** 表格渲染（自動依內容決定欄寬，並套用欄位上限） */
function renderTable(headers, rows, maxWidths = []) {
  const widths = headers.map((h, i) => {
    const cap = maxWidths[i] || 0;
    let w = displayWidth(h);
    for (const row of rows) w = Math.max(w, displayWidth(row[i] ?? ''));
    return cap ? Math.min(w, cap) : w;
  });

  const line = (cells) =>
    cells.map((c, i) => padEnd(truncate(c ?? '', widths[i] || 0), widths[i])).join('  ');

  const out = [];
  out.push(line(headers));
  out.push(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of rows) out.push(line(row));
  return out.join('\n');
}

function formatMoney(value, currency = 'USD') {
  if (!Number.isFinite(value)) return '-';
  const sign = signForCurrency(currency);
  const fixed = Math.abs(value) >= 1000 ? value.toFixed(2) : value.toFixed(2);
  return `${sign}${Number(fixed).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPct(value, digits = 1) {
  if (!Number.isFinite(value)) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

/** 主摘要區塊 */
function renderSummary({ cfg, stats, meta }) {
  const cur = meta.currency || cfg.currency || 'USD';
  const lines = [];
  lines.push('═'.repeat(72));
  lines.push('  eBay 卡牌價格掃描 — 找出在售且低於平均價的甜甜價');
  lines.push('═'.repeat(72));
  lines.push(`  搜尋關鍵字   : ${cfg.query}`);
  lines.push(`  資料來源     : ${meta.sourceLabel}`);
  lines.push(`  市場 / 幣別  : ${meta.marketplace} / ${cur}`);
  if (meta.filter) lines.push(`  API filter   : ${meta.filter}`);
  lines.push(`  在售商品數   : ${meta.totalListings} 筆${meta.apiTotal ? `（eBay 回報總數 ${meta.apiTotal}）` : ''}`);
  if (meta.excludedByTitle) lines.push(`  標題黑名單剔除: ${meta.excludedByTitle} 筆`);
  if (meta.excludedByPrice) lines.push(`  價格區間剔除 : ${meta.excludedByPrice} 筆`);
  if (meta.otherCurrencies) lines.push(`  其他幣別略過 : ${meta.otherCurrencies} 筆`);
  lines.push('');
  lines.push(`  有效樣本     : ${stats.usedCount} 筆${stats.removed ? `（IQR 濾除 ${stats.removed} 筆離群值）` : ''}`);
  lines.push(`  ── 平均價基準（${stats.baselineKind === 'mean' ? '平均價' : stats.baselineKind === 'median' ? '中位數' : '修剪平均'}）: ${formatMoney(stats.baseline, cur)}`);
  lines.push(`  平均價       : ${formatMoney(stats.mean, cur)}`);
  lines.push(`  中位數       : ${formatMoney(stats.median, cur)}`);
  lines.push(`  修剪平均     : ${formatMoney(stats.trimmedMean, cur)}`);
  lines.push(`  標準差       : ${formatMoney(stats.stddev, cur)}`);
  lines.push(`  IQR 正常範圍 : ${formatMoney(stats.bounds.lower, cur)} ~ ${formatMoney(stats.bounds.upper, cur)}`);
  lines.push(`  價格區間     : ${formatMoney(stats.min, cur)} ~ ${formatMoney(stats.max, cur)}`);
  if (meta.soldBenchmark) {
    const sb = meta.soldBenchmark;
    lines.push('');
    lines.push(`  ── 近期成交價基準（已售出 ${sb.count} 筆，中位數）: ${formatMoney(sb.baseline, cur)}`);
    lines.push(`  成交中位數   : ${formatMoney(sb.median, cur)}`);
    lines.push(`  成交平均價   : ${formatMoney(sb.mean, cur)}`);
    lines.push(`  成交範圍     : ${formatMoney(sb.min, cur)} ~ ${formatMoney(sb.max, cur)}`);
    lines.push(`  判定門檻     : ±${sb.thresholdPct}%（在售價 vs 成交中位數）`);
  }
  lines.push('');
  lines.push(
    `  ✅ 符合「<= 平均價${cfg.minDiscount > 0 ? ` 且低於 ${cfg.minDiscount}% 以上` : ''}」: ${meta.dealCount} 筆`
  );
  lines.push('═'.repeat(72));
  return lines.join('\n');
}

/** 甜甜價清單（標題 / 價格 / 折扣 / 連結） */
function renderDeals(deals, stats, cfg) {
  const cur = cfg.currency || deals[0]?.listing.currency || 'USD';
  if (!deals.length) {
    return '\n（沒有找到 <= 平均價的商品，可嘗試放寬 --min-price/--max-price 或加大 --limit。）\n';
  }

  const showSold = deals.some((d) => Number.isFinite(d.listing.soldVsPct));

  const headers = ['#', '標題', '價格', '折扣', '比平均便宜', '商品連結'];
  if (cfg.sellerInfo) headers.push('賣家', '運費');
  if (showSold) headers.push('vs 成交');

  const rows = deals.map((deal, index) => {
    const row = [
      String(index + 1),
      truncate(deal.listing.title, 62),
      formatMoney(deal.price, deal.listing.currency || cur),
      formatPct(-deal.discountPct, 1),
      `-${formatMoney(deal.delta, cur).replace(/^-/, '')}`,
      deal.listing.url,
    ];
    if (cfg.sellerInfo) {
      row.push(deal.listing.seller || '-');
      row.push(
        deal.listing.shipping === null || deal.listing.shipping === undefined
          ? '未知'
          : deal.listing.shipping === 0
            ? '免運'
            : formatMoney(deal.listing.shipping, deal.listing.currency || cur)
      );
    }
    if (showSold) {
      row.push(`${formatPct(deal.listing.soldVsPct, 0)}${deal.listing.soldVerdict ? `（${deal.listing.soldVerdict}）` : ''}`);
    }
    return row;
  });

  const maxWidths = [4, 62, 12, 9, 12, 0, 16, 10];
  return `\n${renderTable(headers, rows, maxWidths)}\n`;
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 甜甜價 → CSV（開頭加 BOM，Excel 開中文不亂碼） */
function toCsv(deals, stats, cfg) {
  const showSold = deals.some((d) => Number.isFinite(d.listing.soldVsPct));
  const headers = [
    'rank',
    'title',
    'price',
    'currency',
    'discount_pct',
    'delta_vs_average',
    'average_price',
    'item_id',
    'seller',
    'shipping',
    'condition',
    'url',
  ];
  if (showSold) headers.push('sold_vs_pct');
  const lines = [headers.join(',')];
  deals.forEach((deal, index) => {
    const l = deal.listing;
    lines.push(
      [
        index + 1,
        l.title,
        deal.price.toFixed(2),
        l.currency || cfg.currency || '',
        deal.discountPct.toFixed(2),
        deal.delta.toFixed(2),
        stats.baseline.toFixed(2),
        l.itemId || '',
        l.seller || '',
        l.shipping === null || l.shipping === undefined ? '' : l.shipping.toFixed(2),
        l.condition || '',
        l.url,
        ...(showSold ? [Number.isFinite(l.soldVsPct) ? l.soldVsPct.toFixed(2) : ''] : []),
      ]
        .map(csvCell)
        .join(',')
    );
  });
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** 完整結果 → 可程式處理的 JSON 物件 */
function buildResult({ cfg, stats, meta, deals, listings }) {
  return {
    generatedAt: new Date().toISOString(),
    query: cfg.query,
    source: meta.source,
    marketplace: meta.marketplace,
    currency: meta.currency,
    soldBenchmark: meta.soldBenchmark || null,
    options: {
      limit: cfg.limit,
      pages: cfg.pages,
      baseline: cfg.baseline,
      outlierFilter: cfg.outlierFilter,
      iqrK: cfg.iqrK,
      minDiscount: cfg.minDiscount,
      minPrice: cfg.minPrice,
      maxPrice: cfg.maxPrice,
      condition: cfg.condition,
      buying: cfg.buying,
      exclude: cfg.exclude,
    },
    summary: {
      apiTotal: meta.apiTotal || null,
      totalListings: meta.totalListings,
      sampleCount: stats.usedCount,
      outliersRemoved: stats.removed,
      average: round2(stats.mean),
      median: round2(stats.median),
      trimmedMean: round2(stats.trimmedMean),
      stddev: round2(stats.stddev),
      min: round2(stats.min),
      max: round2(stats.max),
      iqrLower: round2(stats.bounds.lower),
      iqrUpper: round2(stats.bounds.upper),
      baselineKind: stats.baselineKind,
      baseline: round2(stats.baseline),
      dealCount: deals.length,
    },
    deals: deals.map((d) => ({
      rank: 0,
      title: d.listing.title,
      price: round2(d.price),
      currency: d.listing.currency,
      discountPct: round2(d.discountPct),
      deltaVsAverage: round2(d.delta),
      soldVsPct: round2(d.listing.soldVsPct),
      soldVerdict: d.listing.soldVerdict || null,
      itemId: d.listing.itemId,
      seller: d.listing.seller,
      shipping: d.listing.shipping === null ? null : round2(d.listing.shipping),
      condition: d.listing.condition,
      url: d.listing.url,
    })).map((d, i) => ({ ...d, rank: i + 1 })),
    listings: (listings || []).map((l) => ({
      itemId: l.itemId,
      title: l.title,
      price: round2(l.price),
      currency: l.currency,
      soldVsPct: round2(l.soldVsPct),
      soldVerdict: l.soldVerdict || null,
      url: l.url,
      seller: l.seller,
      condition: l.condition,
    })),
  };
}

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** 依副檔名寫出 CSV 或 JSON */
function writeOutput(filePath, { result, csv }) {
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const ext = path.extname(absolute).toLowerCase();
  if (ext === '.csv') {
    fs.writeFileSync(absolute, csv, 'utf8');
  } else {
    fs.writeFileSync(absolute, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  return absolute;
}

/* ═══════════════════════════════════════════════════════════════════
 * 6. eBay Browse API 客戶端（原 src/ebayApi.js）
 *
 * 官方、合法、穩定。流程：
 *   1. POST /identity/v1/oauth2/token（grant_type=client_credentials + Basic Auth）
 *   2. GET  /buy/browse/v1/item_summary/search → 只回「仍在售」的商品
 *
 * 注意：Browse API 只回傳 active（未售出）listing，完全符合本次需求。
 * ═══════════════════════════════════════════════════════════════════ */

const BASES = {
  production: {
    token: 'https://api.ebay.com/identity/v1/oauth2/token',
    api: 'https://api.ebay.com',
    scope: 'https://api.ebay.com/oauth/api_scope',
  },
  sandbox: {
    token: 'https://api.sandbox.ebay.com/identity/v1/oauth2/token',
    api: 'https://api.sandbox.ebay.com',
    scope: 'https://api.ebay.com/oauth/api_scope',
  },
};

const MAX_OFFSET = 10000;
const MAX_LIMIT = 200;

class EbayApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'EbayApiError';
    this.status = status;
    this.body = body;
  }
}

class EbayBrowseApi {
  /**
   * @param {object} opts
   * @param {string} opts.clientId     EBAY_CLIENT_ID (App ID)
   * @param {string} opts.clientSecret EBAY_CLIENT_SECRET (Cert ID)
   * @param {'production'|'sandbox'} [opts.env]
   * @param {string} [opts.marketplace] 例：EBAY_US
   */
  constructor(opts) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.env = opts.env === 'sandbox' ? 'sandbox' : 'production';
    this.marketplace = opts.marketplace || 'EBAY_US';
    this.base = BASES[this.env];
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  get isSandbox() {
    return this.env === 'sandbox';
  }

  /** 取得（並快取）OAuth access token */
  async getToken(force = false) {
    const now = Date.now();
    if (!force && this.token && now < this.tokenExpiresAt - 60_000) return this.token;
    if (!this.clientId || !this.clientSecret) {
      throw new EbayApiError(
        '缺少 eBay API 憑證。請在 .env 設定 EBAY_CLIENT_ID 與 EBAY_CLIENT_SECRET（申請方式見 README.md）。'
      );
    }

    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`, 'utf8').toString('base64');
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: this.base.scope,
    }).toString();

    const res = await fetch(this.base.token, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new EbayApiError(`取得 token 失敗（HTTP ${res.status}）：${text.slice(0, 300)}`, {
        status: res.status,
        body: text,
      });
    }

    if (!res.ok || !json.access_token) {
      throw new EbayApiError(
        `取得 token 失敗（HTTP ${res.status}）：${json.error_description || json.error || text.slice(0, 300)}`,
        { status: res.status, body: json }
      );
    }

    this.token = json.access_token;
    this.tokenExpiresAt = now + Number(json.expires_in || 7200) * 1000;
    return this.token;
  }

  /**
   * 組出 Browse API 的 filter 字串。
   * @param {object} cfg
   */
  static buildFilter(cfg) {
    const filters = [];

    if (cfg.buying === 'fixed') filters.push('buyingOptions:{FIXED_PRICE}');
    else if (cfg.buying === 'auction') filters.push('buyingOptions:{AUCTION}');

    if (cfg.condition) filters.push(`conditions:{${String(cfg.condition).toUpperCase()}}`);

    if (cfg.minPrice != null || cfg.maxPrice != null) {
      const lo = cfg.minPrice != null ? cfg.minPrice : '';
      const hi = cfg.maxPrice != null ? cfg.maxPrice : '';
      filters.push(`price:[${lo}..${hi}]`);
      if (cfg.currency) filters.push(`priceCurrency:${cfg.currency}`);
    }
    return filters.join(',');
  }

  /**
   * 搜尋單一批次。
   * @param {object} params
   * @param {string} params.query
   * @param {number} [params.limit]
   * @param {number} [params.offset]
   * @param {string} [params.filter]
   * @param {string} [params.sort]
   */
  async searchOnce({ query, limit = MAX_LIMIT, offset = 0, filter = '', sort = 'price', category = '' }) {
    const token = await this.getToken();
    const url = new URL(`${this.base.api}/buy/browse/v1/item_summary/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(Math.min(limit, MAX_LIMIT)));
    url.searchParams.set('offset', String(Math.min(offset, MAX_OFFSET)));
    if (sort) url.searchParams.set('sort', sort);
    if (filter) url.searchParams.set('filter', filter);
    if (category) url.searchParams.set('category_ids', category);

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': this.marketplace,
      },
      signal: AbortSignal.timeout(45_000),
    });

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new EbayApiError(`搜尋回應無法解析（HTTP ${res.status}）：${text.slice(0, 300)}`, {
        status: res.status,
        body: text,
      });
    }

    if (res.status === 401) {
      this.token = null; // token 可能失效，清掉快取讓下次重取
      throw new EbayApiError('存取被拒（401）：憑證無效或 token 過期，請檢查 .env。', {
        status: res.status,
        body: json,
      });
    }
    if (!res.ok) {
      const detail = (json.errors || []).map((e) => `${e.errorId}: ${e.message}`).join(' | ');
      throw new EbayApiError(
        `搜尋失敗（HTTP ${res.status}）：${detail || json.message || text.slice(0, 300)}`,
        { status: res.status, body: json }
      );
    }

    return {
      total: Number(json.total || 0),
      items: Array.isArray(json.itemSummaries) ? json.itemSummaries : [],
      raw: json,
    };
  }

  /** 依 pages 連續抓取多批，自動去重 */
  async searchAll(cfg, log = () => {}) {
    const filter = EbayBrowseApi.buildFilter(cfg);
    const sort = cfg.sort === 'newest' ? 'newlyListed' : cfg.sort;

    const seen = new Set();
    const out = [];
    let total = 0;

    for (let page = 0; page < cfg.pages; page += 1) {
      const offset = page * cfg.limit;
      if (offset >= MAX_OFFSET) break;

      log(
        `  [API] 第 ${page + 1}/${cfg.pages} 批：offset=${offset}, limit=${cfg.limit}` +
          (filter ? `, filter=${filter}` : '')
      );
      const { total: t, items } = await this.searchOnce({
        query: cfg.query,
        limit: cfg.limit,
        offset,
        filter,
        sort,
        category: cfg.category,
      });
      total = t || total;

      if (!items.length) break;
      for (const item of items) {
        const normalized = EbayBrowseApi.normalize(item);
        if (!normalized) continue;
        const key = normalized.itemId || normalized.url;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(normalized);
      }
      if (out.length >= total) break;
    }

    return { total, listings: out, source: 'api', filter, marketplace: this.marketplace };
  }

  /** 把 Browse API 的 itemSummary 轉成統一的 listing 結構 */
  static normalize(item) {
    const price = Number.parseFloat(item?.price?.value);
    if (!Number.isFinite(price)) return null;

    const currency = item.price?.currency || null;
    const shippingOption = Array.isArray(item.shippingOptions) ? item.shippingOptions[0] : null;
    const shippingRaw = shippingOption?.shippingCost?.value;
    const shipping = shippingRaw == null ? null : Number.parseFloat(shippingRaw);

    return {
      source: 'api',
      itemId: item.itemId || extractItemId(item.itemWebUrl),
      title: cleanTitle(item.title),
      price,
      currency,
      shipping: Number.isFinite(shipping) ? shipping : null,
      shippingType: shippingOption?.shippingCostType || null,
      totalPrice: Number.isFinite(shipping) ? price + shipping : price,
      condition: item.condition || '',
      buyingOptions: Array.isArray(item.buyingOptions) ? item.buyingOptions : [],
      url: cleanItemUrl(item.itemWebUrl || item.itemAffiliateWebUrl),
      seller: item.seller?.username || '',
      sellerFeedbackPct: item.seller?.feedbackPercentage || '',
      image: item.image?.imageUrl || '',
      itemLocation: item.itemLocation?.country || '',
      listingDate: item.itemCreationDate || null,
    };
  }
}

/* ═══════════════════════════════════════════════════════════════════
 * 7. 爬蟲共用邏輯（原 src/scrapeShared.js）
 *
 * 這裡只放「與瀏覽器驅動無關」的部分：搜尋網址組裝、反爬偵測、HTML → listing 正規化。
 * 這些程式碼在 Playwright 與 Puppeteer 上行為完全一致
 * （page.evaluate / page.content 等 API 語意相同），共用可避免兩份實作各自漂移。
 * ═══════════════════════════════════════════════════════════════════ */

/** 真實 Chrome User-Agent（與 Playwright 送出的 sec-ch-ua 版本號保持一致） */
const REAL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 爬蟲套件缺失 / 被反爬阻擋時丟出的錯誤（主流程會原樣顯示訊息） */
class ScraperUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScraperUnavailableError';
  }
}

/** 延遲 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 組出搜尋頁網址。sold=true 時切換成「已售出」（LH_Sold=1 & LH_Complete=1），否則只要「在售」。 */
function buildSearchUrl({ query, marketplace, pageNumber = 1, buyItNowOnly = true, perPage = 240, category = '', sold = false }) {
  const domain = domainForMarketplace(marketplace);
  const url = new URL(`https://${domain}/sch/i.html`);
  url.searchParams.set('_nkw', query);
  url.searchParams.set('_sacat', String(category || '0'));
  url.searchParams.set('_ipg', String(perPage));
  url.searchParams.set('_pgn', String(pageNumber));
  url.searchParams.set('rt', 'nc');
  if (sold) {
    // 只看「已售出」：已完成 + 已售（成交價基準用）
    url.searchParams.set('LH_Complete', '1');
    url.searchParams.set('LH_Sold', '1');
  } else {
    // 只取「在售」：不要已完成 / 已售出
    url.searchParams.set('LH_Complete', '0');
    url.searchParams.set('LH_Sold', '0');
    if (buyItNowOnly) url.searchParams.set('LH_BIN', '1');
  }
  return url.toString();
}

/** 判斷是否被反爬擋住 */
function looksBlocked(html, title) {
  const t = String(title || '').toLowerCase();
  if (t.includes('robot') || t.includes('access denied') || t.includes('pardon our interruption')) return true;
  const h = String(html || '');
  if (h.length < 20000 && /Access Denied|Reference #\d|edgesuite\.net|akamai/i.test(h)) return true;
  return false;
}

/**
 * 在瀏覽器內解析搜尋結果（同時支援舊版 .s-item 與新版 .s-card 版型）。
 * 用 page.evaluate 執行，Playwright 與 Puppeteer 皆可照用。
 */
function extractListings(page) {
  return page.evaluate(() => {
    const pickText = (el, selectors) => {
      for (const sel of selectors) {
        const node = el.querySelector(sel);
        const value = node && node.textContent ? node.textContent.trim() : '';
        if (value) return value;
      }
      return '';
    };
    const pickAttr = (el, selectors, attrName) => {
      for (const sel of selectors) {
        const node = el.querySelector(sel);
        const value = node && node.getAttribute(attrName);
        if (value) return value;
      }
      return '';
    };

    const nodes = document.querySelectorAll('.srp-results li.s-item, li.s-item, li.s-card, .s-item, .s-card');
    const out = [];
    nodes.forEach((el) => {
      const title = pickText(el, [
        '.s-item__title span[role="heading"]',
        '.s-item__title',
        '.s-card__title',
        'h3',
      ]);
      const priceText = pickText(el, ['.s-item__price', '.s-card__price', '.s-card__price-row .su-styled-text']);
      if (!title || !priceText) return;

      out.push({
        title,
        priceText,
        href: pickAttr(el, ['a.s-item__link', 'a.su-link', 'a[href*="/itm/"]'], 'href'),
        seller: pickText(el, ['.s-item__seller-info-text', '.s-card__seller']),
        shippingText: pickText(el, ['.s-item__shipping', '.s-item__logisticsCost']),
        subtitle: pickText(el, ['.s-item__subtitle', '.s-card__subtitle']),
        image: pickAttr(el, ['img.s-item__image-img', 'img'], 'src'),
      });
    });
    return out;
  });
}

/**
 * 把 href 補成絕對網址。
 * eBay 舊版 .s-item 給的是絕對網址，但部分新版版型 / 某些市場會給相對路徑
 * （例如 "/itm/1234567890"）；若不補齊，cleanItemUrl 會因為 new URL() 沒有 base
 * 而直接回傳原字串，最後寫出一條無法點擊的死連結。
 */
function absoluteItemUrl(href, marketplace) {
  const raw = String(href === null || href === undefined ? '' : href).trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return `https://${domainForMarketplace(marketplace)}${raw}`;
  return ''; // javascript: / mailto: / 其他怪東西一律丟棄
}

/** 把爬蟲抓到的原始資料轉成統一 listing 結構（兩種引擎共用同一套規則） */
function normalizeScraped(raw, cfg) {
  const title = cleanTitle(raw.title);
  if (!title || /^shop on ebay$/i.test(title)) return null;

  const parsed = parsePrice(raw.priceText);
  if (!Number.isFinite(parsed.value)) return null;

  const shippingParsed = parsePrice(raw.shippingText);
  const href = absoluteItemUrl(raw.href, cfg.marketplace);
  const url = cleanItemUrl(href);
  // 必須留下可用的絕對連結，且指向商品頁（/itm/）；否則丟棄，避免死連結進到報表
  if (!href || !/\/itm\//.test(href)) return null;

  return {
    source: 'scrape',
    itemId: extractItemId(href) || null,
    title,
    price: parsed.value,
    currency: parsed.currency || currencyForMarketplace(cfg.marketplace),
    shipping: Number.isFinite(shippingParsed.value) ? shippingParsed.value : null,
    shippingType: null,
    totalPrice: Number.isFinite(shippingParsed.value) ? parsed.value + shippingParsed.value : parsed.value,
    condition: raw.subtitle && !/^(new listing|sponsored)$/i.test(raw.subtitle) ? raw.subtitle : '',
    buyingOptions: [],
    url,
    seller: raw.seller || '',
    sellerFeedbackPct: '',
    image: raw.image || '',
    itemLocation: '',
    listingDate: null,
    priceIsRange: Boolean(parsed.isRange),
  };
}

/* ═══════════════════════════════════════════════════════════════════
 * 8. 爬蟲引擎 A：Playwright（原 src/ebayPlaywright.js）
 *
 * 為什麼需要爬蟲：直接對 ebay.com/sch 發普通 HTTP 請求會被 Akamai 反爬擋成 403，
 * 所以改用真正的 Chromium 執行 JS，並帶上完整瀏覽器指紋與 headers。
 *
 * 與引擎 B（Puppeteer）的差異：
 *   - Playwright 不需第三方 stealth 外掛，這裡手動補上常見指紋修補（見 STEALTH_INIT）。
 *   - 以 browser.newContext() 一次性帶入 UA / viewport / locale / timezone / headers。
 *   - 以 ignoreDefaultArgs 拿掉 --enable-automation，並覆寫 navigator.webdriver 雙重保險。
 *
 * 只回傳「在售（未售出）」listing：URL 明確帶 LH_Sold=0&LH_Complete=0。
 * ═══════════════════════════════════════════════════════════════════ */

/** 懶載入 playwright，缺少時給出可操作的安裝指令 */
function loadPlaywright() {
  try {
    return require('playwright');
  } catch (err) {
    throw new ScraperUnavailableError(
      'Playwright 爬蟲模式需要額外套件，請執行：\n' +
        '  npm install playwright\n' +
        '  npx playwright install chromium               # 下載 Playwright 專用 Chromium\n' +
        '  npx playwright install chromium --with-deps   # Linux 缺系統依賴時\n' +
        '本機已安裝 Chrome / Edge 時，可改加 --browser-channel chrome 免下載。\n' +
        `\n原始錯誤：${err.message}`
    );
  }
}

/**
 * 每個新頁面開始前注入的指紋修補腳本。
 * 注意：此函式會被序列化後在瀏覽器端執行，不可引用外部變數。
 */
const STEALTH_INIT = () => {
  // 1) 自動化最明顯的痕跡（搭配 --disable-blink-features=AutomationControlled 雙重保險）
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });

  // 2) 語言 / 硬體資訊（headless 的預設值會露餡）
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true });

  // 3) 補上 plugins（headless 下長度為 0，且 .length 仍要正常）
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    ],
    configurable: true,
  });

  // 4) window.chrome（只有真 Chrome 才有這個物件）
  if (!window.chrome) {
    Object.defineProperty(window, 'chrome', { value: {}, configurable: true });
  }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {};
  }

  // 5) Notification 權限查詢在 headless 下會回 'denied'，改回合理值
  const permissionsProto = window.Permissions && window.Permissions.prototype;
  if (permissionsProto && permissionsProto.query) {
    const originalQuery = permissionsProto.query;
    permissionsProto.query = function patchedQuery(params) {
      if (params && params.name === 'notifications') {
        return Promise.resolve({ state: 'default', onchange: null });
      }
      return originalQuery.call(this, params);
    };
  }

  // 6) WebGL 廠商字串（headless 預設字串太樣板）
  const glProto = window.WebGLRenderingContext && window.WebGLRenderingContext.prototype;
  if (glProto && glProto.getParameter) {
    const originalGetParameter = glProto.getParameter;
    glProto.getParameter = function patchedGetParameter(p) {
      if (p === 37445) return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
      if (p === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
      return originalGetParameter.call(this, p);
    };
  }
};

/** 瀏覽器（process）層級啟動參數 */
function launchOptionsFor(cfg) {
  const options = {
    headless: cfg.headed ? false : cfg.scraperHeadless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-notifications',
      '--window-size=1440,900',
      '--lang=en-US,en',
    ],
    // Playwright 預設會帶 --enable-automation（使 navigator.webdriver = true），拿掉它
    ignoreDefaultArgs: ['--enable-automation'],
  };
  if (cfg.browserChannel) options.channel = cfg.browserChannel;
  return options;
}

/** context 層級參數（等同 Puppeteer 的 setUserAgent / setViewport / setExtraHTTPHeaders） */
function contextOptionsFor() {
  return {
    userAgent: REAL_UA,
    viewport: { width: 1440, height: 900 },
    screen: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    colorScheme: 'light',
    javaScriptEnabled: true,
    bypassCSP: true,
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      // 必須與 REAL_UA 的 Chrome/131 一致，否則指紋自相矛盾反而更容易被標記
      'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  };
}

/** 捲到底，觸發圖片與卡片 lazy-load */
async function scrollToBottom(page) {
  await page
    .evaluate(async () => {
      const step = window.innerHeight;
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    })
    .catch(() => {});
}

/**
 * 主流程：開 Chromium → 暖身取得 cookie → 逐頁抓「在售」listing → 去重 → 正規化
 * @param {object} cfg 由 buildConfig() 產生
 * @param {(msg: string) => void} log
 */
async function scrapeWithPlaywright(cfg, log = () => {}, options = {}) {
  const { chromium } = loadPlaywright();
  const started = Date.now();
  const seen = new Set();
  const listings = [];
  let browser = null;
  let context = null;
  const sold = Boolean(options.sold);
  const pages = options.pages != null ? options.pages : cfg.pages;

  log(
    `  [Playwright] 啟動 ${cfg.browserChannel || 'playwright 內建 Chromium'}（${
      cfg.headed ? '有視窗' : 'headless'
    }）…`
  );

  try {
    browser = await chromium.launch(launchOptionsFor(cfg));
  } catch (err) {
    const hints = ['請確認：', '  1. 已下載瀏覽器：npx playwright install chromium'];
    if (cfg.browserChannel) {
      hints.push(
        `  2. --browser-channel "${cfg.browserChannel}" 指定的瀏覽器已安裝在本機（或移除該參數改用內建 Chromium）`
      );
    }
    hints.push(`  ${hints.length}. Node.js 版本須為 18 以上`);
    throw new ScraperUnavailableError(`Playwright 無法啟動瀏覽器：${err.message}\n${hints.join('\n')}`);
  }

  try {
    context = await browser.newContext(contextOptionsFor());
    await context.addInitScript(STEALTH_INIT);

    const page = await context.newPage();
    page.setDefaultTimeout(45_000);
    page.setDefaultNavigationTimeout(60_000);

    // 先造訪首頁累積 cookie（可明顯降低被擋機率）
    log('  [Playwright] 先暖身取得 cookie…');
    await page
      .goto(`https://${domainForMarketplace(cfg.marketplace)}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      })
      .catch(() => {});
    await sleep(Math.max(cfg.delayMs, 800));

    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const url = buildSearchUrl({
        query: cfg.query,
        marketplace: cfg.marketplace,
        pageNumber,
        buyItNowOnly: sold ? false : cfg.buying !== 'all' && cfg.buying !== 'auction',
        category: cfg.category,
        sold,
      });
      log(`  [Playwright] 第 ${pageNumber}/${pages} 頁：${url}`);

      let status = 0;
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        status = response ? response.status() : 0;
      } catch (err) {
        log(`  [Playwright] 導覽失敗（略過本頁）：${String(err.message).split('\n')[0]}`);
      }

      await page
        .waitForSelector('li.s-item, li.s-card, .s-item, .s-card', { state: 'attached', timeout: 20_000 })
        .catch(() => {});

      await scrollToBottom(page);

      const html = await page.content();
      const docTitle = await page.title().catch(() => '');

      if (cfg.debug) {
        const dir = path.join(__dirname, '..', '_debug');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `playwright-page-${pageNumber}.html`);
        fs.writeFileSync(file, html, 'utf8');
        log(`  [Playwright] 已寫出除錯 HTML：${file}（${html.length} bytes, HTTP ${status}）`);
      }

      if (status === 403 || status === 429 || looksBlocked(html, docTitle)) {
        throw new ScraperUnavailableError(
          `被 eBay 反爬阻擋（HTTP ${status}${docTitle ? `, title="${docTitle}"` : ''}）。\n` +
            '建議依序嘗試：\n' +
            '  1. 優先用官方 API：在 .env 填 EBAY_CLIENT_ID / EBAY_CLIENT_SECRET，再加 --source api\n' +
            '  2. 換引擎交叉測試：--engine puppeteer（兩種驅動指紋不同，可能只有一個過關）\n' +
            `  3. 開視窗觀察：node src/index.js "${cfg.query}" --source scrape --headed --debug\n` +
            '  4. 拉長間隔：--delay 4000；或用 --browser-channel chrome 走本機已安裝的 Chrome\n' +
            '  5. 若你的 IP（公司／機房／VPN）已被 eBay 列入黑名單，請換網路或改用 API 方案'
        );
      }

      const raw = await extractListings(page);
      log(`  [Playwright] 本頁解析到 ${raw.length} 張卡片（HTML ${html.length} bytes）`);

      let added = 0;
      for (const item of raw) {
        const listing = normalizeScraped(item, cfg);
        if (!listing) continue;
        const key = listing.itemId || listing.url;
        if (seen.has(key)) continue;
        seen.add(key);
        listing.sold = sold;
        listings.push(listing);
        added += 1;
      }
      log(`  [Playwright] 新增 ${added} 筆（累計 ${listings.length} 筆）`);

      if (added === 0) break; // 沒有新東西就不用再翻
      if (pageNumber < pages) await sleep(cfg.delayMs);
    }
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  return {
    total: listings.length,
    listings,
    source: 'scrape',
    engine: 'playwright',
    sold,
    elapsedMs: Date.now() - started,
    marketplace: cfg.marketplace,
  };
}

/* ═══════════════════════════════════════════════════════════════════
 * 9. 爬蟲引擎 B：Puppeteer + puppeteer-extra-plugin-stealth
 *    （原 src/ebayScraper.js）
 *
 * 為什麼需要爬蟲：直接對 ebay.com/sch 發普通 HTTP 請求會被 Akamai 反爬擋成 403，
 * 所以改用真正的 Headless Chrome 執行 JS、帶上完整瀏覽器指紋與 headers。
 *
 * 只回傳「在售（未售出）」listing：URL 明確帶 LH_Sold=0&LH_Complete=0。
 * 與引擎無關的共用邏輯（搜尋網址組裝、反爬偵測、HTML 解析）見上方 §7，
 * 讓 Puppeteer 與 Playwright 兩個引擎的解析結果保持一致。
 *
 * 用 --engine puppeteer 切換到本引擎。兩種驅動的指紋不同，被擋時可交叉測試。
 * ═══════════════════════════════════════════════════════════════════ */

/** 懶載入 optionalDependencies，缺少時給出可操作的安裝指令 */
function loadPuppeteerStack() {
  let puppeteerExtra;
  let StealthPlugin;
  try {
    puppeteerExtra = require('puppeteer-extra');
    StealthPlugin = require('puppeteer-extra-plugin-stealth');
  } catch (err) {
    throw new ScraperUnavailableError(
      '爬蟲模式需要額外套件（puppeteer / puppeteer-extra / puppeteer-extra-plugin-stealth）。\n' +
        '請執行：\n' +
        '  npm install\n' +
        '  npx puppeteer browsers install chrome      # 或改用 --browser-channel chrome 使用本機 Chrome\n' +
        `\n原始錯誤：${err.message}`
    );
  }
  try {
    // 需要 puppeteer 才能拿到瀏覽器
    require.resolve('puppeteer');
  } catch (err) {
    throw new ScraperUnavailableError(
      '找不到 puppeteer。請執行 npm install（會下載 Chromium），或安裝後用 --browser-channel chrome。\n' +
        `原始錯誤：${err.message}`
    );
  }

  puppeteerExtra.use(StealthPlugin());
  return puppeteerExtra;
}

/** 啟動瀏覽器（stealth + 真實指紋） */
async function launchPuppeteerBrowser(puppeteer, cfg) {
  const launchOptions = {
    headless: cfg.headed ? false : cfg.scraperHeadless,
    defaultViewport: { width: 1440, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-notifications',
      '--window-size=1440,900',
      '--lang=en-US,en',
    ],
  };
  if (cfg.browserChannel) launchOptions.channel = cfg.browserChannel;
  return puppeteer.launch(launchOptions);
}

/**
 * 主流程：開瀏覽器 → 逐頁抓「在售」listing → 去重 → 正規化
 * @param {object} cfg 由 buildConfig() 產生
 * @param {(msg: string) => void} log
 */
async function scrapeWithPuppeteer(cfg, log = () => {}, options = {}) {
  const puppeteer = loadPuppeteerStack();
  const started = Date.now();
  const seen = new Set();
  const listings = [];
  let browser = null;
  const sold = Boolean(options.sold);
  const pages = options.pages != null ? options.pages : cfg.pages;

  log(
    `  [Scrape] 啟動 ${cfg.browserChannel || 'puppeteer 內建 Chromium'}（${cfg.headed ? '有視窗' : 'headless'}）…`
  );
  browser = await launchPuppeteerBrowser(puppeteer, cfg);

  try {
    const page = await browser.newPage();
    await page.setUserAgent(REAL_UA);
    await page.setViewport({ width: 1440, height: 900 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    });
    await page.emulateTimezone('America/New_York').catch(() => {});
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    });

    // 先造訪首頁累積 cookie（stealth 模式下可明顯降低 403 機率）
    log('  [Scrape] 先暖身取得 cookie…');
    await page
      .goto(`https://${domainForMarketplace(cfg.marketplace)}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      })
      .catch(() => {});
    await sleep(Math.max(cfg.delayMs, 800));

    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const url = buildSearchUrl({
        query: cfg.query,
        marketplace: cfg.marketplace,
        pageNumber,
        buyItNowOnly: sold ? false : cfg.buying !== 'all' && cfg.buying !== 'auction',
        category: cfg.category,
        sold,
      });
      log(`  [Scrape] 第 ${pageNumber}/${pages} 頁：${url}`);

      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const status = response ? response.status() : 0;

      await page.waitForSelector('li.s-item, li.s-card, .s-item, .s-card', { timeout: 20_000 }).catch(() => {});

      // 捲到底觸發圖片與卡片 lazy-load
      await page
        .evaluate(async () => {
          const step = window.innerHeight;
          for (let y = 0; y < document.body.scrollHeight; y += step) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 120));
          }
          window.scrollTo(0, 0);
        })
        .catch(() => {});

      const html = await page.content();
      const docTitle = await page.title().catch(() => '');

      if (cfg.debug) {
        const dir = path.join(__dirname, '..', '_debug');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `page-${pageNumber}.html`);
        fs.writeFileSync(file, html, 'utf8');
        log(`  [Scrape] 已寫出除錯 HTML：${file}（${html.length} bytes, HTTP ${status}）`);
      }

      if (status === 403 || status === 429 || looksBlocked(html, docTitle)) {
        throw new ScraperUnavailableError(
          `被 eBay 反爬阻擋（HTTP ${status}${docTitle ? `, title="${docTitle}"` : ''}）。\n` +
            '建議：\n' +
            '  1. 優先用官方 API：在 .env 填 EBAY_CLIENT_ID / EBAY_CLIENT_SECRET，然後加 --source api\n' +
            '  2. 爬蟲模式改跑有視窗的瀏覽器觀察：node src/index.js "' +
            cfg.query +
            '" --source scrape --headed\n' +
            '  3. 加長間隔：--delay 4000，或改用 --browser-channel chrome 走本機 Chrome 指紋\n' +
            '  4. 若你的網路環境（公司/機房 IP）被列入黑名單，請改用住宅網路或 API 方案'
        );
      }

      const raw = await extractListings(page);
      log(`  [Scrape] 本頁解析到 ${raw.length} 張卡片（HTML ${html.length} bytes）`);

      let added = 0;
      for (const item of raw) {
        const listing = normalizeScraped(item, cfg);
        if (!listing) continue;
        const key = listing.itemId || listing.url;
        if (seen.has(key)) continue;
        seen.add(key);
        listing.sold = sold;
        listings.push(listing);
        added += 1;
      }
      log(`  [Scrape] 新增 ${added} 筆（累計 ${listings.length} 筆）`);

      if (added === 0) break; // 沒東西了，不用再翻
      if (pageNumber < pages) await sleep(cfg.delayMs);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return {
    total: listings.length,
    listings,
    source: 'scrape',
    sold,
    elapsedMs: Date.now() - started,
    marketplace: cfg.marketplace,
  };
}

/* ═══════════════════════════════════════════════════════════════════
 * 10. 資料來源選擇（原 src/sources.js）
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * 可用的爬蟲引擎。
 * 單檔版中兩個引擎都已經在本檔案內定義好，真正的「重量級載入」
 * （require('playwright') / require('puppeteer-extra')）仍然延後到
 * 真的要爬的那一刻才發生（見 loadPlaywright / loadPuppeteerStack），
 * 所以平常走 API 模式的人不會因為沒裝爬蟲套件而一啟動就掛掉。
 */
const SCRAPERS = {
  playwright: {
    label: 'Playwright Chromium',
    mod: { scrapeSearch: scrapeWithPlaywright },
  },
  puppeteer: {
    label: 'Puppeteer + puppeteer-extra-plugin-stealth',
    mod: { scrapeSearch: scrapeWithPuppeteer },
  },
};

/** 依 --engine / SCRAPER_ENGINE 挑出引擎 */
function pickScraper(engine) {
  const name = String(engine || 'playwright').toLowerCase();
  const entry = SCRAPERS[name];
  if (!entry) {
    throw new Error(
      `未知的 --engine："${engine}"（可用：${Object.keys(SCRAPERS).join(' / ')}）`
    );
  }
  return { name, label: entry.label, mod: entry.mod };
}

/**
 * 依設定挑選資料來源，回傳統一格式的結果。
 *
 * 優先順序（--source auto）：
 *   1. .env 有 EBAY_CLIENT_ID / EBAY_CLIENT_SECRET → eBay Browse API（官方、穩定）
 *   2. 否則 → 爬蟲（預設 Playwright，可用 --engine puppeteer 切換）
 */
async function collectListings(cfg, log = () => {}) {
  if (cfg.resolvedSource === 'api') {
    if (!cfg.hasApiCreds) {
      throw new EbayApiError(
        '指定了 --source api，但 .env 裡沒有 EBAY_CLIENT_ID / EBAY_CLIENT_SECRET。\n' +
          '請參考 README.md「如何申請 eBay Client ID / Secret」，或改用 --source scrape。'
      );
    }
    const api = new EbayBrowseApi({
      clientId: process.env.EBAY_CLIENT_ID,
      clientSecret: process.env.EBAY_CLIENT_SECRET,
      env: cfg.ebayEnv,
      marketplace: cfg.marketplace,
    });

    log(`  [API] 取得 OAuth token（${cfg.ebayEnv}）…`);
    await api.getToken();
    log('  [API] token 取得成功');

    const result = await api.searchAll(cfg, log);
    return {
      ...result,
      apiTotal: result.total,
      sourceLabel: `eBay Browse API（${cfg.ebayEnv}，marketplace=${cfg.marketplace}）`,
    };
  }

  if (cfg.resolvedSource !== 'scrape') {
    throw new Error(`未知的 --source："${cfg.source}"（可用：auto / api / scrape）`);
  }

  const { name, label, mod } = pickScraper(cfg.scraperEngine);
  log(`  [Scrape] 引擎：${label}`);
  const result = await mod.scrapeSearch(cfg, log);
  return {
    ...result,
    apiTotal: null,
    engine: name,
    sourceLabel: `${label}（marketplace=${cfg.marketplace}）`,
  };
}

/** 抓「已售出」清單，供成交價基準用（爬蟲版，獨立於在售資料來源） */
async function collectSoldListings(cfg, log = () => {}) {
  const { name, label, mod } = pickScraper(cfg.scraperEngine);
  log(`  [成交基準] 引擎：${label}（抓 ${cfg.soldPages} 頁已售出商品）`);
  const result = await mod.scrapeSearch(cfg, log, { sold: true, pages: cfg.soldPages });
  return {
    ...result,
    engine: name,
    sourceLabel: `${label}（已售出，marketplace=${cfg.marketplace}）`,
  };
}

/* ═══════════════════════════════════════════════════════════════════
 * 11. 主流程（原 src/index.js）
 *     ① buildConfig → ② collectListings（API / 爬蟲 / demo）
 *     → ③ 幣別 + 黑名單 + 價格區間過濾 → ④ IQR 統計 → ⑤ 找甜甜價
 *     → ⑥ 終端表格 / JSON / CSV 匯出
 * ═══════════════════════════════════════════════════════════════════ */


/** 依幣別 / 黑名單 / 價格區間過濾，並統計各項剔除數量 */
function applyFilters(listings, cfg, targetCurrency) {
  const counts = { otherCurrencies: 0, excludedByTitle: 0, excludedByPrice: 0 };
  const kept = [];

  for (const listing of listings) {
    if (targetCurrency && listing.currency && listing.currency !== targetCurrency) {
      counts.otherCurrencies += 1;
      continue;
    }
    if (matchesAnyKeyword(listing.title, cfg.exclude)) {
      counts.excludedByTitle += 1;
      continue;
    }
    if (cfg.minPrice != null && listing.price < cfg.minPrice) {
      counts.excludedByPrice += 1;
      continue;
    }
    if (cfg.maxPrice != null && listing.price > cfg.maxPrice) {
      counts.excludedByPrice += 1;
      continue;
    }
    kept.push(listing);
  }
  return { kept, counts };
}

/** 找出最常見的幣別（爬蟲模式可能混幣） */
function dominantCurrency(listings, fallback) {
  const tally = new Map();
  for (const l of listings) {
    if (!l.currency) continue;
    tally.set(l.currency, (tally.get(l.currency) || 0) + 1);
  }
  let best = fallback || null;
  let bestCount = 0;
  for (const [code, count] of tally) {
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }
  return best || 'USD';
}

/** --demo：載入內建範例資料，離線驗證整條流程 */
function loadDemoListings() {
  const file = path.join(ROOT, 'fixtures', 'sample-listings.json');
  if (!fs.existsSync(file)) {
    throw new Error(`找不到示範資料：${file}`);
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    total: 0,
    apiTotal: null,
    listings: data.listings,
    source: 'demo',
    query: data.query || '',
    sourceLabel: `內建範例資料（${path.relative(ROOT, file)}）`,
  };
}

async function main() {
  const cfg = buildConfig(process.argv.slice(2));

  if (cfg.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  if (cfg.listPresets) {
    const presets = loadPresets();
    if (!presets || !Object.keys(presets).length) {
      process.stderr.write('目前沒有 presets.json 或內容為空。\n');
    } else {
      process.stdout.write('可用的預設別名：\n');
      for (const [name, d] of Object.entries(presets)) {
        if (name.startsWith('_')) continue;
        const desc = d.query || '(僅設定過濾條件)';
        process.stdout.write(`  @${name}  →  ${desc}${d.note ? `  [${d.note}]` : ''}\n`);
      }
    }
    return 0;
  }

  const log = stderrLog;

  let collected;
  if (cfg.demo) {
    log('  [Demo] 使用內建範例資料，不連網。');
    collected = loadDemoListings();
    if (!cfg.query && collected.query) cfg.query = collected.query;
  } else {
    if (!cfg.query) {
      process.stderr.write('錯誤：請提供搜尋關鍵字，例如：\n  node src/index.js "charizard psa 10"\n\n');
      process.stdout.write(`${HELP}\n`);
      return 2;
    }
    log(`▶ 搜尋「${cfg.query}」（來源：${cfg.resolvedSource}，市場：${cfg.marketplace}）`);
    if (cfg.envInfo.loaded) log(`  已載入 ${path.relative(ROOT, cfg.envInfo.path)}`);
    collected = await collectListings(cfg, log);
  }

  let targetCurrency = cfg.currency || dominantCurrency(collected.listings, null);
  let { kept, counts } = applyFilters(collected.listings, cfg, targetCurrency);

  // 安全網：若「明確指定」的幣別把所有商品都濾光了，但結果中其實有其他幣別，
  // 就自動改用實際佔多數的幣別並提示，避免切換市場後拿到 0 筆卻找不到原因。
  if (cfg.currency && !kept.length && collected.listings.length) {
    const dominant = dominantCurrency(collected.listings, null);
    if (dominant && dominant !== targetCurrency) {
      log(
        `⚠ 指定幣別 ${targetCurrency} 查不到可用商品（此市場多為 ${dominant}），已自動改用 ${dominant}。`
      );
      targetCurrency = dominant;
      ({ kept, counts } = applyFilters(collected.listings, cfg, targetCurrency));
    }
  }

  const stats = summarize(
    kept.map((l) => l.price),
    {
      baseline: cfg.baseline,
      trim: cfg.trim,
      outlierFilter: cfg.outlierFilter,
      iqrK: cfg.iqrK,
    }
  );

  if (!stats.usedCount) {
    process.stderr.write(
      '\n⚠ 沒有可用的價格樣本（可能被黑名單／價格區間全部濾掉，或對方沒有回傳任何商品）。\n' +
        `  原始取得 ${collected.listings.length} 筆；標題剔除 ${counts.excludedByTitle} 筆、價格剔除 ${counts.excludedByPrice} 筆、其他幣別 ${counts.otherCurrencies} 筆。\n`
    );
    return 1;
  }

  let soldBenchmark = null;
  if (cfg.soldRef && !cfg.demo) {
    if (cfg.resolvedSource !== 'scrape') {
      log('⚠ --sold-ref 目前以爬蟲抓取「已售出」當基準；你正走 API 模式，仍會另外開爬蟲抓成交價（需已裝 playwright/puppeteer）。');
    }
    try {
      const soldCollected = await collectSoldListings(cfg, log);
      const soldPrices = soldCollected.listings
        .filter((l) => !targetCurrency || !l.currency || l.currency === targetCurrency)
        .filter((l) => !matchesAnyKeyword(l.title, cfg.exclude))
        .map((l) => l.price)
        .filter((v) => Number.isFinite(v) && v > 0);
      if (soldPrices.length) {
        const s = summarize(soldPrices, { baseline: 'median', outlierFilter: true, iqrK: cfg.iqrK });
        if (s.baseline > 0) {
          soldBenchmark = {
            count: s.usedCount,
            total: soldPrices.length,
            median: s.median,
            mean: s.mean,
            min: s.min,
            max: s.max,
            baseline: s.baseline,
            thresholdPct: cfg.soldVsPct,
          };
          for (const l of kept) {
            const vs = ((l.price - s.baseline) / s.baseline) * 100;
            l.soldVsPct = vs;
            l.soldVerdict = vs <= -cfg.soldVsPct ? '抵買' : vs >= cfg.soldVsPct ? '偏貴' : '合理';
          }
        } else {
          log('⚠ 成交價基準無有效樣本，已略過。');
        }
      } else {
        log('⚠ 找不到可用的已售出成交價（可能被反爬或該關鍵字沒有成交紀錄），已略過。');
      }
    } catch (err) {
      log(`⚠ 抓取成交價基準失敗，已略過：${err.message}`);
    }
  }

  const deals = findDeals(kept, stats, { minDiscountPct: cfg.minDiscount, top: cfg.top });

  const meta = {
    source: collected.source,
    sourceLabel: collected.sourceLabel,
    marketplace: collected.marketplace || cfg.marketplace,
    currency: targetCurrency,
    apiTotal: collected.apiTotal,
    totalListings: collected.listings.length,
    filter: collected.filter || null,
    dealCount: deals.length,
    soldBenchmark,
    ...counts,
  };

  const result = buildResult({ cfg, stats, meta, deals, listings: kept });

  if (cfg.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderSummary({ cfg, stats, meta })}\n`);
    process.stdout.write(renderDeals(deals, stats, cfg));
  }

  if (cfg.out) {
    const written = writeOutput(cfg.out, { result, csv: toCsv(deals, stats, cfg) });
    process.stderr.write(`\n已匯出報告：${written}\n`);
  }

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`\n❌ ${err.name || 'Error'}: ${err.message}\n`);
    if (process.env.DEBUG_STACK === '1') process.stderr.write(`${err.stack}\n`);
    process.exitCode = 1;
  });
