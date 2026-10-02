'use strict';

const { cleanTitle, cleanItemUrl, extractItemId } = require('./parse');

/**
 * eBay Browse API 客戶端（官方、合法、穩定）。
 *
 * 流程：
 *   1. POST /identity/v1/oauth2/token（grant_type=client_credentials + Basic Auth）
 *   2. GET  /buy/browse/v1/item_summary/search → 只回「仍在售」的商品
 *
 * 注意：Browse API 只回傳 active（未售出）listing，完全符合本次需求。
 */

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
  async searchOnce({ query, limit = MAX_LIMIT, offset = 0, filter = '', sort = 'price' }) {
    const token = await this.getToken();
    const url = new URL(`${this.base.api}/buy/browse/v1/item_summary/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(Math.min(limit, MAX_LIMIT)));
    url.searchParams.set('offset', String(Math.min(offset, MAX_OFFSET)));
    if (sort) url.searchParams.set('sort', sort);
    if (filter) url.searchParams.set('filter', filter);

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

module.exports = { EbayBrowseApi, EbayApiError, BASES };
