'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { normalizeKeyword } = require('../src/parse');

test('評級詞自動補空格', () => {
  assert.strictEqual(normalizeKeyword('psa10'), 'PSA 10');
  assert.strictEqual(normalizeKeyword('psa9'), 'PSA 9');
  assert.strictEqual(normalizeKeyword('bgs9.5'), 'BGS 9.5');
  assert.strictEqual(normalizeKeyword('bgs10'), 'BGS 10');
  assert.strictEqual(normalizeKeyword('cgc10'), 'CGC 10');
  assert.strictEqual(normalizeKeyword('beckett9.5'), 'BGS 9.5');
});

test('已分開的評級詞不重複處理（冪等）', () => {
  assert.strictEqual(normalizeKeyword('PSA 10'), 'PSA 10');
  assert.strictEqual(normalizeKeyword('charizard psa 10'), 'charizard psa 10');
});

test('卡號自動標準化為帶連字號格式', () => {
  assert.strictEqual(normalizeKeyword('js1'), 'JS-1');
  assert.strictEqual(normalizeKeyword('rc1'), 'RC-1');
  assert.strictEqual(normalizeKeyword('op01'), 'OP-01');
});

test('單字母前綴（如 f1）不受影響', () => {
  assert.strictEqual(normalizeKeyword('f1 psa 10'), 'f1 psa 10');
});

test('不誤傷關鍵字與負向排除詞', () => {
  assert.strictEqual(
    normalizeKeyword('"jannik sinner" "panini instant" "psa 10" -auto -patch -/10 -/25'),
    '"jannik sinner" "panini instant" "psa 10" -auto -patch -/10 -/25'
  );
  assert.strictEqual(normalizeKeyword('charizard psa10 holo'), 'charizard PSA 10 holo');
});

test('空值與空白收斂', () => {
  assert.strictEqual(normalizeKeyword(''), '');
  assert.strictEqual(normalizeKeyword(null), '');
  assert.strictEqual(normalizeKeyword('  charizard   psa10   '), 'charizard PSA 10');
});
