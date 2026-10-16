'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SoldCache } = require('../src/soldCache');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soldcache-'));
  return path.join(dir, 'cache.json');
}

test('set/get 往返保存 records（key 大小寫/空白不敏感）', () => {
  const c = new SoldCache(tmpFile(), 7);
  c.set('X PSA 10', { records: [{ title: 'X PSA 10', price: 100 }], currency: 'USD', source: 'serpapi' });
  const got = c.get('x   psa   10');
  assert.ok(got);
  assert.strictEqual(got.records.length, 1);
  assert.strictEqual(got.records[0].price, 100);
  assert.strictEqual(c.count(), 1);
});

test('超過 TTL 回傳 null', () => {
  const f = tmpFile();
  const c = new SoldCache(f, 7);
  c.set('X PSA 10', { records: [{ title: 'X', price: 1 }] });
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  data[SoldCache.normalizeKey('X PSA 10')].computedAt = Date.now() - 8 * 86400_000;
  fs.writeFileSync(f, JSON.stringify(data), 'utf8');
  assert.strictEqual(c.get('X PSA 10'), null);
});

test('clear(query) 只清指定查詢；clear() 清空全部', () => {
  const c = new SoldCache(tmpFile(), 7);
  c.set('A', { records: [{ title: 'A', price: 1 }] });
  c.set('B', { records: [{ title: 'B', price: 2 }] });
  assert.strictEqual(c.count(), 2);
  c.clear('A');
  assert.strictEqual(c.count(), 1);
  assert.strictEqual(c.get('A'), null);
  assert.ok(c.get('B'));
  c.clear();
  assert.strictEqual(c.count(), 0);
});
