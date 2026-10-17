'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { titleHasScarcitySignal, queryIsBase, hasNonCardSignal } = require('../src/parse');

test('普卡標題不視為稀缺', () => {
  assert.strictEqual(titleHasScarcitySignal('2024 Panini Instant Jannik Sinner PSA 10'), false);
});

test('Auto / PSA AUTO / PSA DNA 會被排除', () => {
  assert.strictEqual(titleHasScarcitySignal('2024 Panini Instant Jannik Sinner Auto PSA 10'), true);
  assert.strictEqual(titleHasScarcitySignal('2024 Panini Instant Jannik Sinner PSA AUTO 10'), true);
  assert.strictEqual(titleHasScarcitySignal('2024 Panini Instant Jannik Sinner PSA/DNA 10'), true);
  assert.strictEqual(titleHasScarcitySignal('2024 Panini Instant Jannik Sinner DNA PSA 10'), true);
  assert.strictEqual(titleHasScarcitySignal('2024 Panini Instant Jannik Sinner Signed PSA 10'), true);
});

test('1/1 / One of One 會被排除', () => {
  assert.strictEqual(titleHasScarcitySignal('2024 Panini Instant Jannik Sinner 1/1 PSA 10'), true);
  assert.strictEqual(titleHasScarcitySignal('2024 Panini Instant Jannik Sinner One of One PSA 10'), true);
  assert.strictEqual(titleHasScarcitySignal('2024 Panini Instant Jannik Sinner 1 of 1 PSA 10'), true);
});

test('低編號 / 中高編號平行會被排除', () => {
  const titles = [
    '2024 Panini Instant Jannik Sinner Gold /10 PSA 10',
    '2024 Panini Instant Jannik Sinner /49 PSA 10',
    '2024 Panini Instant Jannik Sinner Red /99 PSA 10',
    '2024 Panini Instant Jannik Sinner Green /25 PSA 10',
    '2024 Panini Instant Jannik Sinner /199 PSA 10',
    '2024 Panini Instant Jannik Sinner /299 PSA 10',
    '2024 Panini Instant Jannik Sinner /399 PSA 10',
  ];
  for (const t of titles) {
    assert.strictEqual(titleHasScarcitySignal(t), true, t);
  }
});

test('無編號平行（顏色/樣式）會被排除', () => {
  const titles = [
    '2024 Panini Instant Jannik Sinner Silver PSA 10',
    '2024 Panini Instant Jannik Sinner Refractor PSA 10',
    '2024 Panini Instant Jannik Sinner Rainbow PSA 10',
    '2024 Panini Instant Jannik Sinner Cracked Ice PSA 10',
    '2024 Panini Instant Jannik Sinner Mojo PSA 10',
    '2024 Panini Instant Jannik Sinner Gold PSA 10',
  ];
  for (const t of titles) {
    assert.strictEqual(titleHasScarcitySignal(t), true, t);
  }
});

test('queryIsBase 正確判斷普卡/限量查詢', () => {
  assert.strictEqual(queryIsBase('"jannik sinner" "panini instant" "psa 10" -auto -patch -/10 -/25'), true);
  assert.strictEqual(queryIsBase('jannik sinner gold psa 10'), false);
  assert.strictEqual(queryIsBase('jannik sinner auto psa 10'), false);
});

test('散卡自選下拉清單會被攔截', () => {
  const titles = [
    'Choose Your Card Marvel PMG Red Spider-Man',
    'Pick Your Card - 2024 Topps Chrome Max Verstappen',
    'Complete Your Set - 1990 Marvel Masterpieces',
    'You Pick 1 Card From The Set',
    'Cards To Choose From',
    'Pick A Card',
  ];
  for (const t of titles) {
    assert.strictEqual(hasNonCardSignal(t), true, t);
  }
});

test('實體周邊與非卡牌會被攔截', () => {
  const titles = [
    '8x10 Signed Photo Jannik Sinner',
    'Roger Federer Signed Photo',
    'Tennis Photo Novak Djokovic',
    'Picture / Poster Magazine',
    'Autographed Hockey Puck',
    'Game Used Ball',
    'Marvel Masterpieces Poster',
  ];
  for (const t of titles) {
    assert.strictEqual(hasNonCardSignal(t), true, t);
  }
});

test('正常卡牌標題不視為非卡牌', () => {
  const titles = [
    '2024 Panini Instant Jannik Sinner PSA 10',
    '2024 Topps Chrome Max Verstappen Card',
    '1995 Marvel Masterpieces Spider-Man PMG Red',
    '2023 Topps Chrome Lewis Hamilton Card',
  ];
  for (const t of titles) {
    assert.strictEqual(hasNonCardSignal(t), false, t);
  }
});
