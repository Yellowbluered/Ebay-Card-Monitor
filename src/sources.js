'use strict';

const { EbayBrowseApi, EbayApiError } = require('./ebayApi');
const { EbaySoldScraper, ExternalQuotaExhaustedError, isQuotaExhausted } = require('./soldScraper');
const { SoldCache } = require('./soldCache');

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

/** 抓「已售出」清單，供「歷史中位成交價」基準用（外部 API + 7 天快取，零本機瀏覽器） */
async function collectSoldListings(cfg, log = () => {}, pages = 2) {
  const cache = new SoldCache(undefined, cfg.soldCacheTtlDays || 7);

  // 熔斷：兩家外部 Sold API 額度皆耗盡 → 直接拋出，讓呼叫端降級查在售
  if (isQuotaExhausted()) {
    throw new ExternalQuotaExhaustedError('外部 Sold API 額度已耗盡（熔斷中），本次略過。');
  }

  const cached = cache.get(cfg.query || '');
  if (cached && Array.isArray(cached.records)) {
    log(`  [成交基準] 命中 7 天成交價快取（${cached.records.length} 筆），不發外部請求。`);
    return {
      listings: cached.records,
      total: cached.records.length,
      source: 'cache',
      sourceLabel: `已售成交價快取（marketplace=${cfg.marketplace}）`,
      cached: true,
      engine: 'external',
    };
  }

  const scraper = new EbaySoldScraper(cfg, log);
  log(`  [成交基準] 外部 API（ScrapingDog / SerpApi 輪替 + 容錯切換，抓 ${pages} 頁已售出商品）`);
  const listings = await scraper.fetchSold(cfg.query, pages);

  cache.set(cfg.query || '', { records: listings, currency: cfg.currency || null, source: 'external' });
  return {
    listings,
    total: listings.length,
    source: 'external',
    sourceLabel: `外部 Scraper（已售出，marketplace=${cfg.marketplace}）`,
    cached: false,
    engine: 'external',
  };
}

module.exports = { collectListings, collectSoldListings, pickScraper };
