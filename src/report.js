'use strict';

const fs = require('fs');
const path = require('path');
const { signForCurrency } = require('./parse');

/** 中日韓全形字算 2 寬，讓表格在終端能對齊 */
function displayWidth(str) {
  let width = 0;
  for (const ch of String(str ?? '')) {
    const code = ch.codePointAt(0);
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3041 && code <= 0x33ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xa000 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff);
    width += wide ? 2 : 1;
  }
  return width;
}

function truncate(str, max) {
  const text = String(str ?? '');
  if (!max || max <= 0) return text;
  if (displayWidth(text) <= max) return text;
  let out = '';
  let width = 0;
  for (const ch of text) {
    const w = displayWidth(ch);
    if (width + w > max - 1) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
}

function padEnd(str, width) {
  const diff = width - displayWidth(str);
  return diff > 0 ? String(str) + ' '.repeat(diff) : String(str);
}

function padStart(str, width) {
  const diff = width - displayWidth(str);
  return diff > 0 ? ' '.repeat(diff) + String(str) : String(str);
}

/** 表格渲染（自動依內容決定欄寬，並套用欄位上限） */
function renderTable(headers, rows, maxWidths = []) {
  const widths = headers.map((h, i) => {
    const cap = maxWidths[i] || 0;
    let w = displayWidth(h);
    for (const row of rows) w = Math.max(w, displayWidth(row[i] ?? ''));
    return cap ? Math.min(w, cap) : w;
  });

  const line = (cells) =>
    cells.map((c, i) => padEnd(truncate(c ?? '', widths[i] || 0), widths[i])).join('  ');

  const out = [];
  out.push(line(headers));
  out.push(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of rows) out.push(line(row));
  return out.join('\n');
}

function formatMoney(value, currency = 'USD') {
  if (!Number.isFinite(value)) return '-';
  const sign = signForCurrency(currency);
  const fixed = Math.abs(value) >= 1000 ? value.toFixed(2) : value.toFixed(2);
  return `${sign}${Number(fixed).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPct(value, digits = 1) {
  if (!Number.isFinite(value)) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

/** 主摘要區塊 */
function renderSummary({ cfg, stats, meta }) {
  const cur = meta.currency || cfg.currency || 'USD';
  const lines = [];
  lines.push('═'.repeat(72));
  lines.push('  eBay 卡牌價格掃描 — 找出在售且低於平均價的甜甜價');
  lines.push('═'.repeat(72));
  lines.push(`  搜尋關鍵字   : ${cfg.query}`);
  lines.push(`  資料來源     : ${meta.sourceLabel}`);
  lines.push(`  市場 / 幣別  : ${meta.marketplace} / ${cur}`);
  if (meta.filter) lines.push(`  API filter   : ${meta.filter}`);
  lines.push(`  在售商品數   : ${meta.totalListings} 筆${meta.apiTotal ? `（eBay 回報總數 ${meta.apiTotal}）` : ''}`);
  if (meta.excludedByTitle) lines.push(`  標題黑名單剔除: ${meta.excludedByTitle} 筆`);
  if (meta.excludedByPrice) lines.push(`  價格區間剔除 : ${meta.excludedByPrice} 筆`);
  if (meta.otherCurrencies) lines.push(`  其他幣別略過 : ${meta.otherCurrencies} 筆`);
  lines.push('');
  lines.push(`  有效樣本     : ${stats.usedCount} 筆${stats.removed ? `（IQR 濾除 ${stats.removed} 筆離群值）` : ''}`);
  lines.push(`  ── 平均價基準（${stats.baselineKind === 'mean' ? '平均價' : stats.baselineKind === 'median' ? '中位數' : '修剪平均'}）: ${formatMoney(stats.baseline, cur)}`);
  lines.push(`  平均價       : ${formatMoney(stats.mean, cur)}`);
  lines.push(`  中位數       : ${formatMoney(stats.median, cur)}`);
  lines.push(`  修剪平均     : ${formatMoney(stats.trimmedMean, cur)}`);
  lines.push(`  標準差       : ${formatMoney(stats.stddev, cur)}`);
  lines.push(`  IQR 正常範圍 : ${formatMoney(stats.bounds.lower, cur)} ~ ${formatMoney(stats.bounds.upper, cur)}`);
  lines.push(`  價格區間     : ${formatMoney(stats.min, cur)} ~ ${formatMoney(stats.max, cur)}`);
  lines.push('');
  lines.push(
    `  ✅ 符合「<= 平均價${cfg.minDiscount > 0 ? ` 且低於 ${cfg.minDiscount}% 以上` : ''}」: ${meta.dealCount} 筆`
  );
  lines.push('═'.repeat(72));
  return lines.join('\n');
}

/** 甜甜價清單（標題 / 價格 / 折扣 / 連結） */
function renderDeals(deals, stats, cfg) {
  const cur = cfg.currency || deals[0]?.listing.currency || 'USD';
  if (!deals.length) {
    return '\n（沒有找到 <= 平均價的商品，可嘗試放寬 --min-price/--max-price 或加大 --limit。）\n';
  }

  const headers = ['#', '標題', '價格', '折扣', '比平均便宜', '商品連結'];
  if (cfg.sellerInfo) headers.push('賣家', '運費');

  const rows = deals.map((deal, index) => {
    const row = [
      String(index + 1),
      truncate(deal.listing.title, 62),
      formatMoney(deal.price, deal.listing.currency || cur),
      formatPct(-deal.discountPct, 1),
      `-${formatMoney(deal.delta, cur).replace(/^-/, '')}`,
      deal.listing.url,
    ];
    if (cfg.sellerInfo) {
      row.push(deal.listing.seller || '-');
      row.push(
        deal.listing.shipping === null || deal.listing.shipping === undefined
          ? '未知'
          : deal.listing.shipping === 0
            ? '免運'
            : formatMoney(deal.listing.shipping, deal.listing.currency || cur)
      );
    }
    return row;
  });

  const maxWidths = [4, 62, 12, 9, 12, 0, 16, 10];
  return `\n${renderTable(headers, rows, maxWidths)}\n`;
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 甜甜價 → CSV（開頭加 BOM，Excel 開中文不亂碼） */
function toCsv(deals, stats, cfg) {
  const headers = [
    'rank',
    'title',
    'price',
    'currency',
    'discount_pct',
    'delta_vs_average',
    'average_price',
    'item_id',
    'seller',
    'shipping',
    'condition',
    'url',
  ];
  const lines = [headers.join(',')];
  deals.forEach((deal, index) => {
    const l = deal.listing;
    lines.push(
      [
        index + 1,
        l.title,
        deal.price.toFixed(2),
        l.currency || cfg.currency || '',
        deal.discountPct.toFixed(2),
        deal.delta.toFixed(2),
        stats.baseline.toFixed(2),
        l.itemId || '',
        l.seller || '',
        l.shipping === null || l.shipping === undefined ? '' : l.shipping.toFixed(2),
        l.condition || '',
        l.url,
      ]
        .map(csvCell)
        .join(',')
    );
  });
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** 完整結果 → 可程式處理的 JSON 物件 */
function buildResult({ cfg, stats, meta, deals, listings }) {
  return {
    generatedAt: new Date().toISOString(),
    query: cfg.query,
    source: meta.source,
    marketplace: meta.marketplace,
    currency: meta.currency,
    options: {
      limit: cfg.limit,
      pages: cfg.pages,
      baseline: cfg.baseline,
      outlierFilter: cfg.outlierFilter,
      iqrK: cfg.iqrK,
      minDiscount: cfg.minDiscount,
      minPrice: cfg.minPrice,
      maxPrice: cfg.maxPrice,
      condition: cfg.condition,
      buying: cfg.buying,
      exclude: cfg.exclude,
    },
    summary: {
      apiTotal: meta.apiTotal || null,
      totalListings: meta.totalListings,
      sampleCount: stats.usedCount,
      outliersRemoved: stats.removed,
      average: round2(stats.mean),
      median: round2(stats.median),
      trimmedMean: round2(stats.trimmedMean),
      stddev: round2(stats.stddev),
      min: round2(stats.min),
      max: round2(stats.max),
      iqrLower: round2(stats.bounds.lower),
      iqrUpper: round2(stats.bounds.upper),
      baselineKind: stats.baselineKind,
      baseline: round2(stats.baseline),
      dealCount: deals.length,
    },
    deals: deals.map((d) => ({
      rank: 0,
      title: d.listing.title,
      price: round2(d.price),
      currency: d.listing.currency,
      discountPct: round2(d.discountPct),
      deltaVsAverage: round2(d.delta),
      itemId: d.listing.itemId,
      seller: d.listing.seller,
      shipping: d.listing.shipping === null ? null : round2(d.listing.shipping),
      condition: d.listing.condition,
      url: d.listing.url,
    })).map((d, i) => ({ ...d, rank: i + 1 })),
    listings: (listings || []).map((l) => ({
      itemId: l.itemId,
      title: l.title,
      price: round2(l.price),
      currency: l.currency,
      url: l.url,
      seller: l.seller,
      condition: l.condition,
    })),
  };
}

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** 依副檔名寫出 CSV 或 JSON */
function writeOutput(filePath, { result, csv }) {
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const ext = path.extname(absolute).toLowerCase();
  if (ext === '.csv') {
    fs.writeFileSync(absolute, csv, 'utf8');
  } else {
    fs.writeFileSync(absolute, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  return absolute;
}

module.exports = {
  displayWidth,
  truncate,
  padEnd,
  padStart,
  renderTable,
  formatMoney,
  formatPct,
  renderSummary,
  renderDeals,
  toCsv,
  buildResult,
  writeOutput,
  round2,
};
