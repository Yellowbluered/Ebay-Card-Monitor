'use strict';

/**
 * 兩個爬蟲引擎（Puppeteer / Playwright）共用的邏輯。
 *
 * 這裡只放「與瀏覽器驅動無關」的部分：搜尋網址組裝、反爬偵測、HTML → listing 正規化。
 * 這些程式碼在 Puppeteer 與 Playwright 上行為完全一致（page.evaluate / page.content
 * 等 API 語意相同），抽出來共用可避免兩份實作各自漂移。
 *
 * 引擎各自專屬的部分留在：
 *   - src/ebayPlaywright.js  啟動 Chromium、context 偽裝、注入指紋修補
 *   - src/ebayScraper.js     啟動 Puppeteer + puppeteer-extra-plugin-stealth
 */

const {
  cleanTitle,
  cleanItemUrl,
  extractItemId,
  parsePrice,
  domainForMarketplace,
  currencyForMarketplace,
} = require('./parse');

/** 真實 Chrome User-Agent（與 Playwright 送出的 sec-ch-ua 版本號保持一致） */
const REAL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 爬蟲套件缺失 / 被反爬阻擋時丟出的錯誤（index.js 會原樣顯示訊息） */
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

/** 組出「在售商品」搜尋頁網址（LH_Sold=0 & LH_Complete=0 保證只要未售出） */
function buildSearchUrl({ query, marketplace, pageNumber = 1, buyItNowOnly = true, perPage = 240 }) {
  const domain = domainForMarketplace(marketplace);
  const url = new URL(`https://${domain}/sch/i.html`);
  url.searchParams.set('_nkw', query);
  url.searchParams.set('_sacat', '0');
  url.searchParams.set('_ipg', String(perPage));
  url.searchParams.set('_pgn', String(pageNumber));
  url.searchParams.set('rt', 'nc');
  // 只取「在售」：不要已完成 / 已售出
  url.searchParams.set('LH_Complete', '0');
  url.searchParams.set('LH_Sold', '0');
  if (buyItNowOnly) url.searchParams.set('LH_BIN', '1');
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
 * 用 page.evaluate 執行，Puppeteer 與 Playwright 皆可照用。
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

module.exports = {
  REAL_UA,
  ScraperUnavailableError,
  sleep,
  buildSearchUrl,
  looksBlocked,
  extractListings,
  normalizeScraped,
  absoluteItemUrl,
};
