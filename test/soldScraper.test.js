'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  EbaySoldScraper,
  ExternalQuotaExhaustedError,
  isQuotaExhausted,
  resetQuotaExhausted,
} = require('../src/soldScraper');

const SOLD_HTML = `
<ul class="srp-results">
  <li class="s-item s-item--watch-at-corner">
    <div class="s-item__info clearfix">
      <a class="s-item__link" href="https://www.ebay.com/itm/123456789012">
        <div class="s-item__title"><span role="heading" aria-level="3">2024 Panini Instant Jannik Sinner PSA 10</span></div>
      </a>
      <span class="s-item__price">US $125.00</span>
      <span class="s-item__shipping">+US $4.99 shipping</span>
      <span class="s-item__caption">Sold Oct 12, 2024</span>
    </div>
  </li>
  <li class="s-item">
    <a class="s-item__link" href="https://www.ebay.com/itm/987654321098">
      <div class="s-item__title"><span role="heading">2024 Panini Instant Jannik Sinner Red /199 PSA 10</span></div>
    </a>
    <span class="s-item__price">US $310.00</span>
    <span class="s-item__caption">Sold Oct 11, 2024</span>
  </li>
  <li class="s-item">
    <div class="s-item__title"><span role="heading">Shop on eBay</span></div>
    <span class="s-item__price">US $1.00</span>
  </li>
</ul>
`;

function fakeResponse({ status = 200, headers = {}, body = '', json = null }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (k) => (headers[k.toLowerCase()] !== undefined ? headers[k.toLowerCase()] : null),
    },
    text: async () => body,
    json: async () => (json !== null && json !== undefined ? json : JSON.parse(body || '{}')),
  };
}

test('buildUrl 帶 LH_Sold=1 & LH_Complete=1', () => {
  const s = new EbaySoldScraper({ marketplace: 'EBAY_US' });
  const url = s.buildUrl('x psa 10', 1);
  assert.match(url, /LH_Sold=1/);
  assert.match(url, /LH_Complete=1/);
  assert.match(url, /_nkw=x%20psa%2010/);
});

test('_parseHtml 解析 eBay Sold 頁並跳過 Shop on eBay', () => {
  const s = new EbaySoldScraper({ marketplace: 'EBAY_US' });
  const recs = s._parseHtml(SOLD_HTML, 'EBAY_US');
  assert.strictEqual(recs.length, 2);
  assert.strictEqual(recs[0].title, '2024 Panini Instant Jannik Sinner PSA 10');
  assert.strictEqual(recs[0].price, 125);
  assert.strictEqual(recs[0].currency, 'USD');
  assert.strictEqual(recs[0].itemId, '123456789012');
  assert.strictEqual(recs[0].soldDate, 'Oct 12, 2024');
  assert.strictEqual(recs[0].source, 'scrapingdog');
  assert.strictEqual(recs[1].price, 310);
});

test('_parseSerpApi 解析 organic_results', () => {
  const s = new EbaySoldScraper({ marketplace: 'EBAY_US' });
  const data = {
    organic_results: [
      {
        title: '2024 Panini Instant Jannik Sinner PSA 10',
        link: 'https://www.ebay.com/itm/111111111111',
        price: { raw: '$120.00', extracted: 120 },
        shipping: { raw: '+$4.00', extracted: 4 },
        sold_date: 'Oct 1, 2024',
      },
      { title: '' }, // 無標題 → 略過
    ],
  };
  const recs = s._parseSerpApi(data, 'EBAY_US');
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].price, 120);
  assert.strictEqual(recs[0].shipping, 4);
  assert.strictEqual(recs[0].itemId, '111111111111');
  assert.strictEqual(recs[0].source, 'serpapi');
});

test('_dedupe 依 itemId/url 去重', () => {
  const s = new EbaySoldScraper({});
  const recs = [
    { itemId: '1', title: 'A', price: 1 },
    { itemId: '1', title: 'A dup', price: 1 },
    { itemId: null, url: 'https://www.ebay.com/itm/2', title: 'B', price: 2 },
    { itemId: null, url: 'https://www.ebay.com/itm/2', title: 'B dup', price: 2 },
  ];
  assert.strictEqual(s._dedupe(recs).length, 2);
});

test('_looksBlocked 偵測阻擋頁', () => {
  const s = new EbaySoldScraper({});
  assert.strictEqual(s._looksBlocked('<html>Pardon Our Interruption</html>'), true);
  assert.strictEqual(s._looksBlocked('<html>normal ebay</html>'), false);
});

test('fetchSold：一家失敗時 failover 到另一家', async () => {
  resetQuotaExhausted();
  const s = new EbaySoldScraper({
    marketplace: 'EBAY_US',
    scrapingdogApiKey: 'dog',
    serpapiApiKey: 'serp',
    scraperDelayMin: 0,
    scraperDelayMax: 0,
    fetchImpl: async (url) => {
      if (url.includes('scrapingdog.com')) {
        return fakeResponse({ status: 429, headers: { 'content-type': 'application/json' }, json: { message: 'quota' } });
      }
      if (url.includes('serpapi.com')) {
        return fakeResponse({
          json: {
            organic_results: [
              { title: 'X PSA 10', link: 'https://www.ebay.com/itm/111111111111', price: { raw: '$120.00', extracted: 120 } },
            ],
          },
        });
      }
      throw new Error('unexpected url ' + url);
    },
  });
  const recs = await s.fetchSold('x psa 10', 1);
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].source, 'serpapi');
  assert.strictEqual(isQuotaExhausted(), false);
});

test('fetchSold：兩家皆失敗 → ExternalQuotaExhaustedError + 熔斷', async () => {
  resetQuotaExhausted();
  const s = new EbaySoldScraper({
    marketplace: 'EBAY_US',
    scrapingdogApiKey: 'dog',
    serpapiApiKey: 'serp',
    scraperDelayMin: 0,
    scraperDelayMax: 0,
    fetchImpl: async () => fakeResponse({ status: 402, headers: { 'content-type': 'application/json' }, json: {} }),
  });
  await assert.rejects(() => s.fetchSold('x psa 10', 1), ExternalQuotaExhaustedError);
  assert.strictEqual(isQuotaExhausted(), true);
  resetQuotaExhausted();
});
