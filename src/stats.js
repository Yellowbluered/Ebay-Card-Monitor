'use strict';

/**
 * 價格統計：平均價、中位數、修剪平均、IQR 離群值過濾。
 * 集換式卡牌價格分布非常偏斜（同一張卡可以 $20 也可以 $5000），
 * 所以預設先用 Tukey IQR 濾掉極端值，再算平均價，避免平均價被灌水。
 */

function sum(values) {
  return values.reduce((acc, v) => acc + v, 0);
}

function mean(values) {
  return values.length ? sum(values) / values.length : 0;
}

/** 分位數（線性插值），values 必須是「已升冪排序」的陣列 */
function quantileSorted(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function quantile(values, p) {
  return quantileSorted([...values].sort((a, b) => a - b), p);
}

function median(values) {
  return quantile(values, 0.5);
}

/** 樣本標準差 */
function stddev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(sum(values.map((v) => (v - m) ** 2)) / (values.length - 1));
}

/** 修剪平均（頭尾各去掉 trim 比例） */
function trimmedMean(values, trim = 0.1) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * Math.min(Math.max(trim, 0), 0.49));
  const kept = sorted.slice(cut, sorted.length - cut);
  return mean(kept.length ? kept : sorted);
}

/** Tukey IQR 上下界 */
function iqrBounds(values, k = 1.5) {
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantileSorted(sorted, 0.25);
  const q3 = quantileSorted(sorted, 0.75);
  const iqr = q3 - q1;
  return { q1, q3, iqr, lower: q1 - k * iqr, upper: q3 + k * iqr };
}

/**
 * @param {number[]} values 價格陣列
 * @param {object} options
 * @param {'mean'|'median'|'trimmed'} [options.baseline] 用哪個當「平均價」基準
 * @param {number} [options.trim] 修剪比例（baseline=trimmed 時使用）
 * @param {boolean} [options.outlierFilter] 是否用 IQR 濾離群值
 * @param {number} [options.iqrK] IQR 倍數，預設 1.5
 */
function summarize(values, options = {}) {
  const { baseline = 'mean', trim = 0.1, outlierFilter = true, iqrK = 1.5 } = options;

  const all = values.filter((v) => Number.isFinite(v) && v > 0);
  const bounds = iqrBounds(all, iqrK);
  const used = outlierFilter ? all.filter((v) => v >= bounds.lower && v <= bounds.upper) : all;
  const effective = used.length ? used : all;

  if (!effective.length) {
    return {
      count: all.length,
      usedCount: 0,
      removed: 0,
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      trimmedMean: 0,
      stddev: 0,
      q1: 0,
      q3: 0,
      iqr: 0,
      bounds,
      baseline: 0,
      baselineKind: baseline,
      usedValues: [],
    };
  }

  const sorted = [...effective].sort((a, b) => a - b);
  const avg = mean(effective);
  const med = median(effective);
  const trimmed = trimmedMean(effective, trim);

  let base;
  if (baseline === 'median') base = med;
  else if (baseline === 'trimmed') base = trimmed;
  else base = avg;

  return {
    count: all.length,
    usedCount: effective.length,
    removed: all.length - effective.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: avg,
    median: med,
    trimmedMean: trimmed,
    stddev: stddev(effective),
    q1: bounds.q1,
    q3: bounds.q3,
    iqr: bounds.iqr,
    bounds,
    baseline: base,
    baselineKind: baseline,
    usedValues: effective,
  };
}

/** 相對基準價的折扣百分比（正值 = 比平均便宜） */
function discountPercent(price, baseline) {
  if (!Number.isFinite(price) || !Number.isFinite(baseline) || baseline <= 0) return 0;
  return ((baseline - price) / baseline) * 100;
}

/**
 * 篩出「甜甜價」：價格 <= 基準價 * (1 - minDiscount/100)
 * 依價格升冪排序（最便宜在前）。
 */
function findDeals(listings, stats, options = {}) {
  const { minDiscountPct = 0, top = 25, priceAccessor } = options;
  const getPrice = priceAccessor || ((l) => l.price);
  const baseline = stats.baseline;
  if (!(baseline > 0)) return [];

  const threshold = baseline * (1 - minDiscountPct / 100);

  return listings
    .map((l) => ({ listing: l, price: getPrice(l) }))
    .filter(({ price }) => Number.isFinite(price) && price > 0 && price <= threshold)
    .map(({ listing, price }) => ({
      listing,
      price,
      discountPct: discountPercent(price, baseline),
      delta: baseline - price,
    }))
    .sort((a, b) => a.price - b.price)
    .slice(0, top > 0 ? top : undefined);
}

module.exports = {
  sum,
  mean,
  quantile,
  median,
  stddev,
  trimmedMean,
  iqrBounds,
  summarize,
  discountPercent,
  findDeals,
};
