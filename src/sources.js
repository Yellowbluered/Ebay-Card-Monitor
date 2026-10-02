'use strict';

const { EbayBrowseApi, EbayApiError } = require('./ebayApi');

/**
 * 可用的爬蟲引擎。
 * 用「延後 require」包起來：沒安裝對應套件時，只有在真的要爬時才會噴安裝提示，
 * 不會讓平常走 API 模式的人一啟動就掛掉。
 */
const SCRAPERS = {
  playwright: {
    label: 'Playwright Chromium',
    load: () => require('./ebayPlaywright'),
  },
  puppeteer: {
    label: 'Puppeteer + puppeteer-extra-plugin-stealth',
    load: () => require('./ebayScraper'),
  },
};

/** 依 --engine / SCRAPER_ENGINE 挑出引擎模組 */
function pickScraper(engine) {
  const name = String(engine || 'playwright').toLowerCase();
  const entry = SCRAPERS[name];
  if (!entry) {
    throw new Error(
      `未知的 --engine："${engine}"（可用：${Object.keys(SCRAPERS).join(' / ')}）`
    );
  }
  return { name, label: entry.label, mod: entry.load() };
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

module.exports = { collectListings, pickScraper };
