'use strict';

/**
 * 爬蟲引擎 B：Playwright。
 *
 * 為什麼需要爬蟲：直接對 ebay.com/sch 發普通 HTTP 請求會被 Akamai 反爬擋成 403，
 * 所以改用真正的 Chromium 執行 JS，並帶上完整瀏覽器指紋與 headers。
 *
 * 與引擎 A（Puppeteer，見 ebayScraper.js）的差異：
 *   - Playwright 不需第三方 stealth 外掛，這裡手動補上常見指紋修補（見 STEALTH_INIT）。
 *   - 以 browser.newContext() 一次性帶入 UA / viewport / locale / timezone / headers。
 *   - 以 ignoreDefaultArgs 拿掉 --enable-automation，並覆寫 navigator.webdriver 雙重保險。
 *
 * 只回傳「在售（未售出）」listing：URL 明確帶 LH_Sold=0&LH_Complete=0。
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
async function scrapeSearch(cfg, log = () => {}) {
  const { chromium } = loadPlaywright();
  const started = Date.now();
  const seen = new Set();
  const listings = [];
  let browser = null;
  let context = null;

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

    for (let pageNumber = 1; pageNumber <= cfg.pages; pageNumber += 1) {
      const url = buildSearchUrl({
        query: cfg.query,
        marketplace: cfg.marketplace,
        pageNumber,
        buyItNowOnly: cfg.buying !== 'all' && cfg.buying !== 'auction',
      });
      log(`  [Playwright] 第 ${pageNumber}/${cfg.pages} 頁：${url}`);

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
        listings.push(listing);
        added += 1;
      }
      log(`  [Playwright] 新增 ${added} 筆（累計 ${listings.length} 筆）`);

      if (added === 0) break; // 沒有新東西就不用再翻
      if (pageNumber < cfg.pages) await sleep(cfg.delayMs);
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
    elapsedMs: Date.now() - started,
    marketplace: cfg.marketplace,
  };
}

module.exports = {
  ScraperUnavailableError,
  buildSearchUrl,
  launchOptionsFor,
  contextOptionsFor,
  scrapeSearch,
  normalizeScraped,
  looksBlocked,
  extractListings,
  REAL_UA,
  STEALTH_INIT,
};
