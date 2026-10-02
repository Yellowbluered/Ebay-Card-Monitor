'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

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

  const positionalQuery = args._.join(' ').trim();
  const query = str(args.query, positionalQuery);

  const marketplace = str(args.marketplace, process.env.EBAY_MARKETPLACE || 'EBAY_US').toUpperCase();
  const source = str(args.source, 'auto').toLowerCase();
  const hasApiCreds = Boolean(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET);

  let resolvedSource = source;
  if (source === 'auto') resolvedSource = hasApiCreds ? 'api' : 'scrape';

  let exclude = DEFAULT_EXCLUDE;
  if (args.exclude !== undefined) {
    exclude =
      args.exclude === '' || args.exclude === false
        ? []
        : str(args.exclude)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
  }

  return {
    argv,
    envInfo,
    help: Boolean(args.help || args.h),
    demo: Boolean(args.demo),
    query,
    source,
    resolvedSource,
    hasApiCreds,
    marketplace,
    currency: str(args.currency, str(process.env.EBAY_CURRENCY, '')) || null,
    limit: Math.max(1, Math.min(num(args.limit, 200), 200)),
    pages: Math.max(1, num(args.pages, 1)),
    top: Math.max(0, num(args.top, 25)),
    baseline: str(args.baseline, 'mean').toLowerCase(),
    trim: num(args.trim, 0.1),
    outlierFilter: bool(args.outlierFilter, true),
    iqrK: num(args.iqrK, 1.5),
    minDiscount: num(args.minDiscount, 0),
    minPrice: args.minPrice === undefined ? null : num(args.minPrice, null),
    maxPrice: args.maxPrice === undefined ? null : num(args.maxPrice, null),
    condition: str(args.condition, '') || null,
    buying: str(args.buying, 'fixed').toLowerCase(),
    sort: str(args.sort, 'price').toLowerCase(),
    exclude,
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
    // API 相關
    ebayEnv: str(process.env.EBAY_ENV, 'production').toLowerCase(),
  };
}

module.exports = {
  ROOT,
  HELP,
  DEFAULT_EXCLUDE,
  parseEnvFile,
  loadEnv,
  parseArgs,
  buildConfig,
  bool,
  num,
  str,
};

