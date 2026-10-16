'use strict';

/**
 * soldScraper.js — 模組 C（Node 版）：eBay「已售成交價」抓取（外部 API，零本機瀏覽器）
 * ============================================================================
 * 對齊 Python 版 ebay_sold_scraper.py 的「external」後端：
 *   * ScrapingDog：抓 eBay Sold 頁 HTML（LH_Sold=1&LH_Complete=1），再以本機 regex 解析。
 *   * SerpApi：eBay engine 回傳結構化 JSON。
 *   * 雙 API round-robin 輪替 + 容錯切換（額度耗盡 / 429 / 403 / 阻擋頁 / 網路錯誤 → 自動切另一家）。
 *   * 兩家皆失敗：設熔斷旗標並拋 ExternalQuotaExhaustedError（呼叫端據此降級查在售）。
 *
 * 雲端（Railway / Docker）不需也不應依賴本機 Playwright；此模組只用 Node 內建 fetch。
 */

const {
  domainForMarketplace,
  currencyForMarketplace,
  cleanItemUrl,
  extractItemId,
  parsePrice,
} = require('./parse');

// eBay 以 HTTP 200 回傳的軟性阻擋頁特徵（登入牆 / 驗證頁）
const BLOCK_MARKERS = [
  'pardon our interruption',
  'access denied',
  'robot check',
  'verify you are a human',
  'sign in or register',
  'security check',
];

class ExternalProviderError extends Error {
  constructor(message) { super(message); this.name = 'ExternalProviderError'; }
}

class ScraperBlockedError extends Error {
  constructor(message) { super(message); this.name = 'ScraperBlockedError'; }
}

class ExternalQuotaExhaustedError extends ScraperBlockedError {
  constructor(message) { super(message); this.name = 'ExternalQuotaExhaustedError'; }
}

// 熔斷狀態（跨實例共用）：兩家外部 Sold API 皆額度耗盡時設為 true。
let quotaExhausted = false;

// 外部 Scraper 雙 API round-robin 計數器：讓「每筆查詢」在兩家之間交替起始。
let externalRrCount = 0;

const EXTERNAL_PROVIDERS = ['scrapingdog', 'serpapi'];

function setQuotaExhausted(value) { quotaExhausted = Boolean(value); }
function isQuotaExhausted() { return quotaExhausted; }
function resetQuotaExhausted() { quotaExhausted = false; }

/** HTML entity 解碼 + 去除標籤（對齊 BeautifulSoup 的 get_text）。 */
function _stripTags(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

class EbaySoldScraper {
  constructor(settings = {}, log = () => {}) {
    this.settings = settings;
    this.log = log;
    // 可注入 fetch 供單元測試；預設使用 Node 18+ 內建 fetch。
    this.fetchImpl = settings.fetchImpl || ((url, init) => fetch(url, init));
  }

  buildUrl(query, page = 1) {
    const domain = domainForMarketplace(this.settings.marketplace || 'EBAY_US');
    return (
      `https://${domain}/sch/i.html?_nkw=${encodeURIComponent(query)}` +
      `&_sacat=0&_ipg=240&_pgn=${page}&LH_Sold=1&LH_Complete=1&rt=nc`
    );
  }

  _sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  async _sleepBetweenPages() {
    const min = Number(this.settings.scraperDelayMin ?? 1);
    const max = Number(this.settings.scraperDelayMax ?? 2);
    const sec = min + Math.random() * Math.max(0, max - min);
    await this._sleep(Math.round(sec * 1000));
  }

  /* ---- 主流程 ---- */

  async fetchSold(query, pages) {
    pages = pages || this.settings.scraperPages || 1;
    return this._fetchExternal(query, pages);
  }

  _externalProviderEnabled(name) {
    if (name === 'scrapingdog') return Boolean(this.settings.scrapingdogApiKey);
    if (name === 'serpapi') return Boolean(this.settings.serpapiApiKey);
    return false;
  }

  async _fetchExternal(query, pages) {
    const start = externalRrCount % 2;
    externalRrCount += 1;

    let names = EXTERNAL_PROVIDERS.filter((n) => this._externalProviderEnabled(n));
    if (start === 1) names = [...names].reverse();

    let lastError = null;
    for (const name of names) {
      try {
        const records = await this._fetchProvider(name, query, pages);
        if (records && records.length) return this._dedupe(records);
        lastError = new ExternalProviderError(`${name} 回傳 0 筆（可能被擋或解析失敗）`);
      } catch (err) {
        if (err instanceof ExternalProviderError) { lastError = err; continue; }
        throw err;
      }
    }

    // 通用 EXTERNAL_SCRAPER_URL 兜底（選填，保留向後相容）
    if (this.settings.externalScraperUrl) {
      try {
        return this._dedupe(await this._fetchGenericExternal(query, pages));
      } catch (err) {
        if (err instanceof ExternalProviderError) lastError = err;
      }
    }

    if (!names.length) {
      throw new ScraperBlockedError(
        '未設定 SCRAPINGDOG_API_KEY 或 SERPAPI_API_KEY（或 EXTERNAL_SCRAPER_URL），無法抓取已售成交價。'
      );
    }

    setQuotaExhausted(true);
    throw new ExternalQuotaExhaustedError(
      `外部 Scraper（ScrapingDog / SerpApi）皆額度耗盡或請求失敗：${lastError ? lastError.message : 'unknown'}`
    );
  }

  _fetchProvider(name, query, pages) {
    if (name === 'scrapingdog') return this._fetchScrapingDog(query, pages);
    if (name === 'serpapi') return this._fetchSerpApi(query, pages);
    throw new ExternalProviderError(`未知外部 provider：${name}`);
  }

  /* ---- ScrapingDog ---- */

  async _fetchScrapingDog(query, pages) {
    const records = [];
    for (let page = 1; page <= pages; page += 1) {
      const url = this.buildUrl(query, page);
      const apiUrl =
        `https://api.scrapingdog.com/scrape?api_key=${encodeURIComponent(this.settings.scrapingdogApiKey)}` +
        `&url=${encodeURIComponent(url)}`;

      let resp;
      try {
        resp = await this.fetchImpl(apiUrl);
      } catch (err) {
        throw new ExternalProviderError(`ScrapingDog 請求失敗：${err.message}`);
      }

      const ctype = String(resp.headers.get('Content-Type') || '').toLowerCase();
      if ([401, 402, 403, 429].includes(resp.status) || ctype.includes('json') || resp.status >= 400) {
        let msg = '';
        try {
          const payload = await resp.json();
          msg = payload.message || payload.error || '';
        } catch (_) { /* ignore */ }
        throw new ExternalProviderError(`ScrapingDog 失敗（HTTP ${resp.status}）：${msg || resp.statusText || 'unknown'}`);
      }

      const html = await resp.text();
      if (this._looksBlocked(html)) {
        throw new ExternalProviderError('ScrapingDog 回傳 eBay 阻擋頁（登入牆/驗證頁）');
      }

      const pageRecords = this._parseHtml(html, this.settings.marketplace);
      if (!pageRecords.length) break;
      records.push(...pageRecords);
      if (page < pages) await this._sleepBetweenPages();
    }
    return records;
  }

  /* ---- SerpApi ---- */

  async _fetchSerpApi(query, pages) {
    const records = [];
    for (let page = 1; page <= pages; page += 1) {
      const params = new URLSearchParams({
        engine: 'ebay',
        _nkw: query,
        _pgn: String(page),
        LH_Sold: '1',
        LH_Complete: '1',
        api_key: this.settings.serpapiApiKey,
      });

      let resp;
      try {
        resp = await this.fetchImpl(`https://serpapi.com/search.json?${params.toString()}`);
      } catch (err) {
        throw new ExternalProviderError(`SerpApi 請求失敗：${err.message}`);
      }

      if ([401, 402, 403, 429].includes(resp.status) || resp.status >= 400) {
        let body = '';
        try { body = await resp.text(); } catch (_) { /* ignore */ }
        throw new ExternalProviderError(`SerpApi 失敗（HTTP ${resp.status}）：${body.slice(0, 200)}`);
      }

      let data;
      try {
        data = await resp.json();
      } catch (err) {
        throw new ExternalProviderError(`SerpApi 回應非 JSON：${err.message}`);
      }

      if (data.error) throw new ExternalProviderError(`SerpApi 錯誤：${data.error}`);

      const pageRecords = this._parseSerpApi(data, this.settings.marketplace);
      if (!pageRecords.length) break;
      records.push(...pageRecords);
      if (page < pages) await this._sleepBetweenPages();
    }
    return records;
  }

  /* ---- 通用外部 Scraper（選填兜底） ---- */

  async _fetchGenericExternal(query, pages) {
    try {
      const resp = await this.fetchImpl(this.settings.externalScraperUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, pages, sold: true }),
      });
      if (!resp.ok) throw new ExternalProviderError(`通用外部 Scraper 失敗（HTTP ${resp.status}）`);
      const data = await resp.json();
      const out = [];
      for (const item of data.items || []) {
        const price = Number(item.price);
        if (!Number.isFinite(price)) continue;
        out.push({
          itemId: item.item_id ? String(item.item_id) : null,
          title: String(item.title || ''),
          price,
          currency: item.currency || currencyForMarketplace(this.settings.marketplace || 'EBAY_US'),
          shipping: item.shipping != null ? Number(item.shipping) : null,
          soldDate: item.sold_date ? String(item.sold_date) : null,
          url: cleanItemUrl(item.url || ''),
          source: 'external',
        });
      }
      return out;
    } catch (err) {
      if (err instanceof ExternalProviderError) throw err;
      throw new ExternalProviderError(`通用外部 Scraper 失敗：${err.message}`);
    }
  }

  /* ---- 解析（ScrapingDog 的 eBay HTML） ---- */

  _parseHtml(html, marketplace) {
    const currencyDefault = currencyForMarketplace(marketplace || 'EBAY_US');
    const out = [];
    // 以 </li> 切出每張卡片，再挑出帶 s-item class 的卡片
    const chunks = String(html || '').split(/<\/li>/i);
    for (const chunk of chunks) {
      if (!/class="[^"]*s-item\b/i.test(chunk)) continue;

      const title = this._extractTitle(chunk);
      if (!title || /^shop on ebay$/i.test(title)) continue;

      const priceText = this._extractByClass(chunk, 's-item__price');
      const parsed = parsePrice(priceText);
      if (parsed.value == null) continue;

      const href = this._extractHref(chunk);
      const shipping = parsePrice(this._extractByClass(chunk, 's-item__(?:shipping|logisticsCost)')).value;
      const soldDate = this._extractSoldDate(chunk);

      out.push({
        itemId: extractItemId(href) || null,
        title,
        price: parsed.value,
        currency: parsed.currency || currencyDefault,
        shipping,
        soldDate,
        url: cleanItemUrl(href),
        source: 'scrapingdog',
      });
    }
    return out;
  }

  _extractTitle(chunk) {
    let m = chunk.match(/<span[^>]*role="heading"[^>]*>([\s\S]*?)<\/span>/i);
    if (m) return _stripTags(m[1]);
    m = chunk.match(/<[^>]+class="[^"]*s-item__title[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (m) return _stripTags(m[1]);
    m = chunk.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (m) return _stripTags(m[1]);
    return '';
  }

  _extractHref(chunk) {
    const m = chunk.match(/<a\b[^>]*href="([^"]*\/itm\/[^"]*)"/i);
    return m ? m[1] : '';
  }

  _extractByClass(chunk, className) {
    const re = new RegExp(`<[^>]+class="[^"]*${className}[^"]*"[^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i');
    const m = chunk.match(re);
    return m ? _stripTags(m[1]) : '';
  }

  _extractSoldDate(chunk) {
    for (const cls of ['s-item__title--tag', 's-item__caption', 's-item__endedDate', 's-item__subtitle']) {
      const re = new RegExp(`<[^>]+class="[^"]*${cls}[^"]*"[^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i');
      const m = chunk.match(re);
      if (!m) continue;
      const text = _stripTags(m[1]);
      const d = text.match(/(?:sold|ended)[^\d]{0,12}(\d{1,2}\s+[a-z]{3,9}\.?\s+\d{4}|[a-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/i);
      if (d) return d[1];
    }
    return null;
  }

  /* ---- 解析（SerpApi 結構化 JSON） ---- */

  _parseSerpApi(data, marketplace) {
    const currencyDefault = currencyForMarketplace(marketplace || 'EBAY_US');
    const out = [];
    for (const item of data.organic_results || []) {
      const title = String(item.title || '').trim();
      if (!title) continue;

      const link = item.link || '';
      const priceRaw = item.price;
      let extracted = null;
      let priceText = '';
      if (priceRaw && typeof priceRaw === 'object') {
        extracted = priceRaw.extracted;
        priceText = String(priceRaw.raw || priceRaw.value || '');
      } else {
        priceText = String(priceRaw || '');
      }
      const parsed = parsePrice(priceText);
      const price = extracted != null ? Number(extracted) : parsed.value;
      if (price == null || !Number.isFinite(price)) continue;

      const shipRaw = item.shipping;
      const shipText =
        shipRaw && typeof shipRaw === 'object'
          ? String(shipRaw.raw || shipRaw.value || '')
          : String(shipRaw || '');
      const shipping = parsePrice(shipText).value;

      const soldDate = item.sold_date || item.ended_date || null;

      out.push({
        itemId: extractItemId(link) || null,
        title,
        price: Number(price),
        currency: parsed.currency || currencyDefault,
        shipping,
        soldDate: soldDate ? String(soldDate) : null,
        url: cleanItemUrl(link),
        source: 'serpapi',
      });
    }
    return out;
  }

  _dedupe(records) {
    const seen = new Set();
    const out = [];
    for (const rec of records) {
      const key = rec.itemId || rec.url;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      out.push(rec);
    }
    return out;
  }

  _looksBlocked(html) {
    const lower = String(html || '').toLowerCase();
    return BLOCK_MARKERS.some((m) => lower.includes(m));
  }
}

module.exports = {
  EbaySoldScraper,
  ExternalProviderError,
  ScraperBlockedError,
  ExternalQuotaExhaustedError,
  setQuotaExhausted,
  isQuotaExhausted,
  resetQuotaExhausted,
  EXTERNAL_PROVIDERS,
  BLOCK_MARKERS,
};
