'use strict';

/**
 * 爬蟲引擎 A：Puppeteer + puppeteer-extra-plugin-stealth。
 *
 * 為什麼需要爬蟲：直接對 ebay.com/sch 發普通 HTTP 請求會被 Akamai 反爬擋成 403，
 * 所以改用真正的 Headless Chrome 執行 JS、帶上完整瀏覽器指紋與 headers。
 *
 * 只回傳「在售（未售出）」listing：URL 明確帶 LH_Sold=0&LH_Complete=0。
 * 與引擎無關的共用邏輯（搜尋網址組裝、反爬偵測、HTML 解析）放在 ./scrapeShared，
 * 讓 Puppeteer 與 Playwright 兩個引擎的解析結果保持一致。
 */

const fs = require('fs');
const path = require('path');

const {
  REAL_UA,
  ScraperUnavailableError,
  sleep,
  buildSearchUrl,
  looksBlocked,
  extractListings,
  normalizeScraped,
} = require('./scrapeShared');
const { domainForMarketplace } = require('./parse');

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

// buildSearchUrl / looksBlocked 已移至 ./scrapeShared（兩個引擎共用同一套規則）

/** 啟動瀏覽器（stealth + 真實指紋） */
async function launchBrowser(puppeteer, cfg) {
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

// extractListings / normalizeScraped 已移至 ./scrapeShared（兩個引擎共用同一套規則）

/**
 * 主流程：開瀏覽器 → 逐頁抓「在售」listing → 去重 → 正規化
 * @param {object} cfg 由 buildConfig() 產生
 * @param {(msg: string) => void} log
 */
async function scrapeSearch(cfg, log = () => {}) {
  const puppeteer = loadPuppeteerStack();
  const started = Date.now();
  const seen = new Set();
  const listings = [];
  let browser = null;

  log(
    `  [Scrape] 啟動 ${cfg.browserChannel || 'puppeteer 內建 Chromium'}（${cfg.headed ? '有視窗' : 'headless'}）…`
  );
  browser = await launchBrowser(puppeteer, cfg);

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

    for (let pageNumber = 1; pageNumber <= cfg.pages; pageNumber += 1) {
      const url = buildSearchUrl({
        query: cfg.query,
        marketplace: cfg.marketplace,
        pageNumber,
        buyItNowOnly: cfg.buying !== 'all' && cfg.buying !== 'auction',
      });
      log(`  [Scrape] 第 ${pageNumber}/${cfg.pages} 頁：${url}`);

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
        listings.push(listing);
        added += 1;
      }
      log(`  [Scrape] 新增 ${added} 筆（累計 ${listings.length} 筆）`);

      if (added === 0) break; // 沒東西了，不用再翻
      if (pageNumber < cfg.pages) await sleep(cfg.delayMs);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return {
    total: listings.length,
    listings,
    source: 'scrape',
    elapsedMs: Date.now() - started,
    marketplace: cfg.marketplace,
  };
}

module.exports = {
  ScraperUnavailableError,
  buildSearchUrl,
  scrapeSearch,
  normalizeScraped,
  looksBlocked,
  extractListings,
  REAL_UA,
};
