'use strict';

/**
 * eBay 卡價監測 — Discord Bot（雙向互動 + 甜甜價推播）
 * ---------------------------------------------------------
 * 指令：
 *   !search <關鍵字>   即時搜尋 eBay，回傳最平前 5 筆卡片
 *   !comp <關鍵字>     查詢歷史成交行情（已售成交中位數 + 統計樣本數 + 最近成交前 5 筆）
 *   !rare <關鍵字>     搜尋高稀缺卡片（自動套用稀缺過濾 + 最高價優先）
 *   !add <關鍵字>      加入「本頻道」的背景輪詢監測清單（寫入 presets.json 的 _watchlist[頻道ID]）
 *   !list              顯示目前監測中的關鍵字
 *   !help              顯示說明
 *
 * 背景輪詢：依 DISCORD_POLL_INTERVAL_MIN 間隔，對「每個頻道各自」的 _watchlist 關鍵字跑掃描，
 *           發現低於歷史中位成交價的「甜甜價」就推播 Rich Embed + eBay 連結按鈕到「該關鍵字所屬的頻道」。
 *
 * 需在 .env 設定：DISCORD_TOKEN、DISCORD_CHANNEL_ID（必要，可逗號分隔多個頻道）
 *                DISCORD_POLL_INTERVAL_MIN、DISCORD_MIN_DISCOUNT（選填）
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
} = require('discord.js');

const { loadEnv, buildConfig, ROOT } = require('./config');
const { collectListings, collectSoldListings } = require('./sources');
const { summarize, findDeals } = require('./stats');
const { matchesAnyKeyword, titleHasScarcitySignal, queryIsBase, normalizeKeyword, hasNonCardSignal } = require('./parse');
const { formatMoney, formatPct, truncate } = require('./report');

const PRESETS_FILE = path.join(ROOT, 'presets.json');
const WATCH_KEY = '_watchlist';
const MAX_PUSH_PER_QUERY = 5;
const MAX_LIST_LINES = 20;
const RARE_TERMS = ['/99', '/75', '/50', '/25', '/10', '/5', '1/1'];
const RANGE_PRESETS = {
  cheap: { min: 0, max: 50 },
  mid: { min: 50, max: 500 },
  high: { min: 500, max: 2000 },
  premium: { min: 2000, max: null },
};

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

/* ── 小工具 ─────────────────────────────────────────────── */

function numEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 給 Promise 加上逾時，超時即 reject */
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 等待指定毫秒 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 解析 DISCORD_CHANNEL_ID（支援以逗號分隔多個推播頻道） */
function getChannelIds() {
  const raw = process.env.DISCORD_CHANNEL_ID || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 取得所有可用的推播頻道（找不到的會印警告並略過） */
async function resolveAlertChannels(client) {
  const ids = getChannelIds();
  const channels = [];
  for (const id of ids) {
    const channel = await client.channels.fetch(id).catch(() => null);
    if (channel) channels.push(channel);
    else log(`⚠ 找不到頻道 ${id}，略過此頻道。`);
  }
  return { ids, channels };
}

function dominantCurrency(listings, fallback) {
  const tally = new Map();
  for (const l of listings) {
    if (!l.currency) continue;
    tally.set(l.currency, (tally.get(l.currency) || 0) + 1);
  }
  let best = fallback || null;
  let bestCount = 0;
  for (const [code, count] of tally) {
    if (count > bestCount) { best = code; bestCount = count; }
  }
  return best || 'USD';
}

function applyFilters(listings, cfg, targetCurrency) {
  const counts = { otherCurrencies: 0, excludedByTitle: 0, excludedByPrice: 0, excludedNonCard: 0 };
  const kept = [];
  for (const listing of listings) {
    if (targetCurrency && listing.currency && listing.currency !== targetCurrency) {
      counts.otherCurrencies += 1; continue;
    }
    if (hasNonCardSignal(listing.title)) { counts.excludedNonCard += 1; continue; }
    if (matchesAnyKeyword(listing.title, cfg.exclude)) { counts.excludedByTitle += 1; continue; }
    if (cfg.minPrice != null && listing.price < cfg.minPrice) { counts.excludedByPrice += 1; continue; }
    if (cfg.maxPrice != null && listing.price > cfg.maxPrice) { counts.excludedByPrice += 1; continue; }
    kept.push(listing);
  }
  return { kept, counts };
}

/** 解析價格範圍：$500 → 最高；100-500 → 區間；500+ → 最低；-500 → 最高 */
function parsePriceRange(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let m = s.match(/^\$(\d+(?:\.\d+)?)$/);
  if (m) return { min: null, max: Number(m[1]) };
  m = s.match(/^\$?(\d+(?:\.\d+)?)\s*-\s*\$?(\d+(?:\.\d+)?)$/);
  if (m) return { min: Number(m[1]), max: Number(m[2]) };
  m = s.match(/^(\d+(?:\.\d+)?)\s*\+$/);
  if (m) return { min: Number(m[1]), max: null };
  m = s.match(/^-\s*(\d+(?:\.\d+)?)$/);
  if (m) return { min: null, max: Number(m[1]) };
  return null;
}

/** 把指令參數拆成「關鍵字」與「價格範圍」 */
function splitKeywordAndRange(arg) {
  const tokens = String(arg || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { keyword: '', range: null };
  const last = tokens[tokens.length - 1];
  if (tokens.length >= 2) {
    const preset = RANGE_PRESETS[last.toLowerCase()];
    if (preset) return { keyword: tokens.slice(0, -1).join(' '), range: preset };
    const parsed = parsePriceRange(last);
    if (parsed) return { keyword: tokens.slice(0, -1).join(' '), range: parsed };
  }
  return { keyword: tokens.join(' '), range: null };
}

/** 已售成交日期解析（支援 "Oct 12, 2024" / "12 Oct 2024" / "2024-10-12" / "10/12/2024"）→ epoch ms，無法解析回 null */
const MONTH_INDEX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function parseSoldDate(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  let m = s.match(/^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (m) {
    const mon = MONTH_INDEX[m[1].slice(0, 3).toLowerCase()];
    if (mon) return Date.UTC(Number(m[3]), mon - 1, Number(m[2]));
  }
  m = s.match(/^(\d{1,2})\s+([a-z]{3,9})\.?\s+(\d{4})$/i);
  if (m) {
    const mon = MONTH_INDEX[m[2].slice(0, 3).toLowerCase()];
    if (mon) return Date.UTC(Number(m[3]), mon - 1, Number(m[1]));
  }
  m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  return null;
}

/* ── presets.json 監測清單 ─────────────────────────────── */

function loadPresets() {
  if (!fs.existsSync(PRESETS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')); }
  catch (err) { throw new Error(`presets.json 解析失敗：${err.message}`); }
}

function writePresets(presets) {
  fs.writeFileSync(PRESETS_FILE, `${JSON.stringify(presets, null, 2)}\n`, 'utf8');
}

/** 讀取 per-channel 監測清單：{ 頻道ID: [關鍵字...] } */
function readWatchlist() {
  const presets = loadPresets();
  const raw = presets[WATCH_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [channelId, arr] of Object.entries(raw)) {
    if (Array.isArray(arr)) {
      const list = arr.map((s) => normalizeKeyword(String(s).trim())).filter(Boolean);
      if (list.length) out[channelId] = list;
    }
  }
  return out;
}

/** 讀取指定頻道的監測關鍵字 */
function readWatchlistFor(channelId) {
  return readWatchlist()[channelId] || [];
}

/** 把關鍵字加入指定頻道的監測清單（寫入 presets.json 的 _watchlist[頻道ID]） */
function addWatchKeyword(channelId, keyword) {
  const presets = loadPresets();
  const raw = presets[WATCH_KEY];
  const map = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const list = Array.isArray(map[channelId]) ? map[channelId] : [];
  const normalized = normalizeKeyword(String(keyword).trim());
  const exists = list.includes(normalized);
  if (!exists) {
    list.push(normalized);
    map[channelId] = list;
    presets[WATCH_KEY] = map;
    writePresets(presets);
  }
  return { added: !exists, keyword: normalized, list };
}

/* ── 掃描 ─────────────────────────────────────────────── */

async function scanFor(keyword, opts = {}) {
  const logFn = opts.log || (() => {});
  const cfg = buildConfig(['--limit', '100', '--pages', '1', '--baseline', 'median', String(keyword)]);
  const collected = await collectListings(cfg, logFn);

  let targetCurrency = cfg.currency || dominantCurrency(collected.listings, null);
  let { kept, counts } = applyFilters(collected.listings, cfg, targetCurrency);
  if (cfg.currency && !kept.length && collected.listings.length) {
    const dom = dominantCurrency(collected.listings, null);
    if (dom && dom !== targetCurrency) {
      targetCurrency = dom;
      ({ kept, counts } = applyFilters(collected.listings, cfg, targetCurrency));
    }
  }

  // 普卡防呆：查詢關鍵字本身不含限量/簽名訊號（視為普卡）時，
  // 排除標題含 Auto / Signature / PSA/DNA / PSA Auto 10 / 1/1 / One of One / 低編號 / 平行色 的限量與簽名 listing，
  // 避免把限量卡、簽名卡混入普卡基準價（中位數）而拉高基準。
  if (opts.excludeScarce !== false && queryIsBase(keyword)) {
    const before = kept.length;
    kept = kept.filter((l) => !titleHasScarcitySignal(l.title));
    counts.excludedScarce = before - kept.length;
  }

  const stats = summarize(kept.map((l) => l.price), {
    baseline: cfg.baseline, trim: cfg.trim, outlierFilter: cfg.outlierFilter, iqrK: cfg.iqrK,
  });

  // 「歷史中位價」應以「已售出成交紀錄」為準，而不是在售掛牌（在售價可隨意亂標）。
  // 這裡另外抓已售出清單算出成交中位數；抓不到時才降級用「在售中位價」當參考並在 Embed 標示。
  let soldBaseline = null;
  let soldUsedCount = 0;
  if (opts.useSold !== false) {
    try {
      const soldCollected = await collectSoldListings(cfg, logFn, 2);
      const isBase = queryIsBase(keyword);
      const soldPrices = soldCollected.listings
        .filter((l) => !targetCurrency || !l.currency || l.currency === targetCurrency)
        .filter((l) => !hasNonCardSignal(l.title))
        .filter((l) => !matchesAnyKeyword(l.title, cfg.exclude))
        .filter((l) => !(isBase && titleHasScarcitySignal(l.title)))
        .map((l) => l.price)
        .filter((v) => Number.isFinite(v) && v > 0);
      if (soldPrices.length) {
        const s = summarize(soldPrices, {
          baseline: 'median', outlierFilter: cfg.outlierFilter, iqrK: cfg.iqrK,
        });
        if (s.usedCount > 0 && s.baseline > 0) {
          soldBaseline = s.baseline;
          soldUsedCount = s.usedCount;
        }
      }
      if (soldBaseline == null) logFn('⚠ 找不到可用已售成交價，改用「在售中位價」當參考。');
    } catch (err) {
      logFn(`⚠ 抓取已售成交價失敗，改用「在售中位價」當參考：${err.message}`);
    }
  }

  const baseline = soldBaseline != null ? soldBaseline : stats.baseline;
  const baselineKind = soldBaseline != null ? 'sold' : 'active';

  const minDiscountPct = typeof opts.minDiscountPct === 'number' ? opts.minDiscountPct : 0;
  const top = typeof opts.top === 'number' ? opts.top : 5;
  const deals = baseline > 0 ? findDeals(kept, { ...stats, baseline }, { minDiscountPct, top }) : [];
  const cheapest = [...kept].sort((a, b) => a.price - b.price).slice(0, 5);

  return {
    cfg, collected, targetCurrency, kept, counts, stats, deals, cheapest,
    baseline, baselineKind, soldUsedCount,
  };
}

/** 高稀缺卡片搜尋：多稀缺詞各搜一次 → 合併去重 → 價格區間過濾 → 低於在售中位價過濾 → 依價格最高排序 */
async function scanRare(keyword, opts = {}) {
  const logFn = opts.log || (() => {});
  const top = typeof opts.top === 'number' ? opts.top : 10;
  const priceRange = opts.priceRange || null;
  const base = String(keyword).trim();

  // 1) 收集在售稀缺卡片（合併多個稀缺詞）
  const merged = [];
  const seen = new Set();
  for (const term of RARE_TERMS) {
    const query = `${base} ${term}`;
    const cfg = buildConfig(['--limit', '100', '--pages', '1', '--sort', '-price', query]);
    try {
      const collected = await collectListings(cfg, logFn);
      for (const l of collected.listings) {
        const key = l.itemId || l.url;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        merged.push(l);
      }
    } catch (err) {
      logFn(`⚠ 搜尋「${query}」失敗：${err.message}`);
    }
  }

  // 2) 基礎設定 + 價格區間，做幣別 / 黑名單 / 價格過濾
  const cfg = buildConfig(['--limit', '100', '--pages', '1', '--sort', '-price', base]);
  if (priceRange) {
    if (priceRange.min != null) cfg.minPrice = priceRange.min;
    if (priceRange.max != null) cfg.maxPrice = priceRange.max;
  }

  let targetCurrency = cfg.currency || dominantCurrency(merged, null);
  let { kept, counts } = applyFilters(merged, cfg, targetCurrency);
  if (cfg.currency && !kept.length && merged.length) {
    const dom = dominantCurrency(merged, null);
    if (dom && dom !== targetCurrency) {
      targetCurrency = dom;
      ({ kept, counts } = applyFilters(merged, cfg, targetCurrency));
    }
  }

  // 3) 以「在售中位價」當參考，只留低於中位價者
  let averagePrice = null;
  if (opts.requireBelowAverage !== false && kept.length) {
    const s = summarize(kept.map((l) => l.price), {
      baseline: cfg.baseline, trim: cfg.trim, outlierFilter: cfg.outlierFilter, iqrK: cfg.iqrK,
    });
    if (s.baseline > 0) {
      averagePrice = s.baseline;
      kept = kept.filter((l) => l.price <= averagePrice);
    }
  }

  // 依價格降冪排序，取前 top 筆
  const rare = [...kept].sort((a, b) => b.price - a.price).slice(0, top);

  return { cfg, targetCurrency, kept, counts, rare, query: base, averagePrice, priceRange };
}

/** 歷史成交行情：抓已售成交紀錄 → 嚴格排除（Auto / 1/1 / 低編號 / 平行 / 黑名單 / 幣別）→ IQR 中位數 + 最近成交前 5 筆 */
async function scanComp(keyword, opts = {}) {
  const logFn = opts.log || (() => {});
  const normalized = normalizeKeyword(keyword);
  const cfg = buildConfig(['--limit', '100', '--pages', '1', '--baseline', 'median', normalized]);
  const pages = Math.max(1, Number(opts.pages) || numEnv('SOLD_PAGES', 2));

  const soldCollected = await collectSoldListings(cfg, logFn, pages);
  const listings = soldCollected.listings || [];
  let targetCurrency = cfg.currency || dominantCurrency(listings, null);

  // 嚴格排除：幣別、非卡牌/散卡、黑名單（reprint/proxy/digital/custom art）、稀缺訊號（Auto / 1/1 / 低編號 / 平行色）。
  const kept = listings.filter((l) => {
    if (targetCurrency && l.currency && l.currency !== targetCurrency) return false;
    if (hasNonCardSignal(l.title)) return false;
    if (matchesAnyKeyword(l.title, cfg.exclude)) return false;
    if (titleHasScarcitySignal(l.title)) return false;
    return Number.isFinite(l.price) && l.price > 0;
  });

  const stats = summarize(kept.map((l) => l.price), {
    baseline: 'median', outlierFilter: cfg.outlierFilter, iqrK: cfg.iqrK,
  });

  // 最近成交：依成交日期降冪（無法解析日期的排最後），取前 5 筆。
  const recent = kept
    .slice()
    .sort((a, b) => (parseSoldDate(b.soldDate) || 0) - (parseSoldDate(a.soldDate) || 0))
    .slice(0, 5);

  return {
    cfg,
    keyword: normalized,
    targetCurrency,
    total: listings.length,
    median: stats.baseline,
    usedCount: stats.usedCount,
    removed: stats.removed,
    recent,
    cached: Boolean(soldCollected.cached),
    sourceLabel: soldCollected.sourceLabel,
  };
}

/* ── Embed 建構 ────────────────────────────────────────── */

function buildDealEmbed(query, deal, baseline, currency, opts = {}) {
  const l = deal.listing;
  const soldBased = opts.baselineKind === 'sold';
  const embed = new EmbedBuilder()
    .setColor(soldBased ? 0x2ecc71 : 0xf1c40f)
    .setTitle(soldBased ? '🟢 甜甜價！低於歷史中位成交價' : '🟡 甜甜價！低於在售中位價（僅參考）')
    .setDescription(`**${l.title || '（無標題）'}**`)
    .addFields(
      { name: '搜尋關鍵字', value: query || '（未指定）', inline: false },
      { name: '當前價格', value: formatMoney(deal.price, currency), inline: true },
      { name: soldBased ? '歷史中位成交價' : '在售中位價（參考）', value: formatMoney(baseline, currency), inline: true },
      { name: '折扣幅度', value: `${formatPct(deal.discountPct)}（省 ${formatMoney(deal.delta, currency)}）`, inline: true },
    )
    .setTimestamp();

  if (l.url) embed.setURL(l.url);
  if (l.image) embed.setThumbnail(l.image);

  const components = [];
  if (l.url) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('前往 eBay 查看').setStyle(ButtonStyle.Link).setURL(l.url),
      ),
    );
  }
  return { embeds: [embed], components };
}

function buildSearchEmbed(query, cheapest, stats, currency, totalCount) {
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`🔍 搜尋結果：${query}`)
    .setDescription(`共 ${totalCount} 筆在售商品；在售中位數 ${formatMoney(stats.baseline, currency)}（樣本 ${stats.usedCount} 筆）`)
    .setTimestamp();

  if (!cheapest.length) {
    embed.setDescription('找不到符合條件的卡片。');
    return embed;
  }

  const lines = cheapest.map((l, i) => {
    const title = truncate(l.title || '（無標題）', 70);
    return `${i + 1}. **${formatMoney(l.price, currency)}** — ${l.url ? `[${title}](${l.url})` : title}`;
  });
  embed.addFields({ name: '最平前 5 筆', value: lines.join('\n') });
  return embed;
}

function buildRareEmbed(keyword, rare, currency, totalCount, info = {}) {
  const parts = [];
  if (info.priceRange) {
    const { min, max } = info.priceRange;
    if (min != null && max != null) parts.push(`價格區間 $${min} ~ $${max}`);
    else if (min != null) parts.push(`價格 $${min} 以上`);
    else if (max != null) parts.push(`價格 $${max} 以下`);
  }
  if (info.averagePrice) parts.push(`在售中位價 ${formatMoney(info.averagePrice, currency)}（僅顯示低於中位價者）`);
  parts.push(`共 ${totalCount} 筆符合（依價格最高排序）`);

  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle(`💎 高稀缺卡片：${keyword}`)
    .setDescription(parts.join('；'))
    .setTimestamp();

  if (!rare.length) {
    embed.setDescription('找不到符合條件的卡片（可能被價格區間／中位價過濾掉）。');
    return embed;
  }

  const lines = rare.map((l, i) => {
    const title = truncate(l.title || '（無標題）', 70);
    return `${i + 1}. **${formatMoney(l.price, currency)}** — ${l.url ? `[${title}](${l.url})` : title}`;
  });
  embed.addFields({ name: '前 10 筆高稀缺卡片', value: lines.join('\n') });
  return embed;
}

/** 歷史成交行情 Embed（綠色）：歷史成交中位數、統計樣本數、最近成交前 5 筆記錄與價格 */
function buildCompEmbed(keyword, res) {
  const currency = res.targetCurrency || 'USD';
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`📊 歷史成交行情：${keyword}`)
    .setTimestamp();

  if (!res.usedCount || !res.recent.length) {
    embed.setDescription(`找不到符合條件的已售成交記錄（共抓取 ${res.total} 筆，可能全被排除詞／幣別／稀缺訊號濾掉）。`);
    return embed;
  }

  embed.addFields(
    { name: '歷史成交中位數', value: formatMoney(res.median, currency), inline: true },
    { name: '統計樣本數', value: `${res.usedCount} 筆${res.removed ? `（剔除離群值 ${res.removed} 筆）` : ''}`, inline: true },
  );

  const lines = res.recent.map((l, i) => {
    const title = truncate(l.title || '（無標題）', 60);
    const date = l.soldDate ? ` ・ ${l.soldDate}` : '';
    return `${i + 1}. **${formatMoney(l.price, currency)}** — ${l.url ? `[${title}](${l.url})` : title}${date}`;
  });
  embed.addFields({ name: `最近成交前 ${res.recent.length} 筆`, value: lines.join('\n') });

  if (res.cached) embed.setFooter({ text: '資料來源：7 天成交價快取' });
  else if (res.sourceLabel) embed.setFooter({ text: `資料來源：${res.sourceLabel}` });
  return embed;
}

/* ── 指令處理 ──────────────────────────────────────────── */

async function handleSearch(message, keyword, client) {
  if (!keyword) {
    await message.reply('用法：`!search <關鍵字>`，例：`!search charizard psa 10`');
    return;
  }
  const loading = await message.reply(`🔎 正在搜尋「${keyword}」…`);
  try {
    const res = await scanFor(keyword, { top: 5, useSold: false });
    if (!res.stats.usedCount || !res.kept.length) {
      await loading.edit(`⚠ 搜尋「${keyword}」沒有可用結果（可能全被黑名單／價格區間／幣別濾掉）。`);
      return;
    }
    const embed = buildSearchEmbed(keyword, res.cheapest, res.stats, res.targetCurrency, res.kept.length);
    await loading.edit({ content: null, embeds: [embed] });

    // 若搜尋發現低於在售中位價的甜甜價，即時回覆指令所在的頻道
    if (res.deals.length) {
      const dealsToShow = res.deals.slice(0, 3);
      for (const deal of dealsToShow) {
        const d = buildDealEmbed(keyword, deal, res.baseline, res.targetCurrency, { baselineKind: res.baselineKind });
        await message.channel.send({ embeds: d.embeds, components: d.components });
      }
    }
  } catch (err) {
    await loading.edit(`❌ 搜尋失敗：${err.message}`).catch(() => {});
  }
}

/** 把甜甜價結果同步推送到所有 DISCORD_CHANNEL_ID（方案 B）；excludeChannelId 會被略過 */
async function pushDealsToAlertChannel(client, keyword, deals, stats, currency, excludeChannelId) {
  if (!client) return;
  const { ids, channels } = await resolveAlertChannels(client);
  if (!ids.length) return;
  const targets = channels.filter((c) => c.id !== excludeChannelId);
  if (!targets.length) return;
  for (const deal of deals) {
    const d = buildDealEmbed(keyword, deal, stats.baseline, currency);
    for (const channel of targets) {
      await channel.send({ embeds: d.embeds, components: d.components });
    }
    log(`  📣 同步推播至監測頻道：${deal.listing.title}`);
  }
}

async function handleRare(message, arg) {
  const { keyword, range } = splitKeywordAndRange(arg);
  if (!keyword) {
    await message.reply('用法：`!rare <關鍵字> [價格範圍]`\n例：`!rare charizard`、`!rare charizard 100-500`、`!rare charizard 500+`、`!rare charizard -500`（或 `cheap`/`mid`/`high`/`premium`）');
    return;
  }
  const loading = await message.reply(`💎 正在搜尋高稀缺卡片「${keyword}」…`);
  try {
    const res = await scanRare(keyword, { top: 10, priceRange: range });
    const embed = buildRareEmbed(keyword, res.rare, res.targetCurrency, res.kept.length, {
      priceRange: res.priceRange,
      averagePrice: res.averagePrice,
    });
    await loading.edit({ content: null, embeds: [embed] });
  } catch (err) {
    await loading.edit(`❌ 搜尋失敗：${err.message}`).catch(() => {});
  }
}

async function handleComp(message, arg) {
  const keyword = normalizeKeyword(arg);
  if (!keyword) {
    await message.reply('用法：`!comp <關鍵字>`，例：`!comp charizard psa10`（評級詞會自動補空格）');
    return;
  }
  const loading = await message.reply(`📊 正在查詢「${keyword}」的歷史成交行情…`);
  try {
    const res = await scanComp(keyword, { log });
    const embed = buildCompEmbed(keyword, res);
    await loading.edit({ content: null, embeds: [embed] });
  } catch (err) {
    await loading.edit(`❌ 查詢失敗：${err.message}`).catch(() => {});
  }
}

function formatWatchSummary(list) {
  const shown = list.slice(0, MAX_LIST_LINES);
  const lines = shown.map((k, i) => `${i + 1}. ${k}`);
  if (list.length > shown.length) lines.push(`…共 ${list.length} 筆`);
  return lines.join('\n');
}

async function handleAdd(message, keyword) {
  if (!keyword) {
    await message.reply('用法：`!add <關鍵字>`，例：`!add charizard psa 10`');
    return;
  }
  try {
    const { added, keyword: kw, list } = addWatchKeyword(message.channel.id, keyword);
    const summary = list.length
      ? `\n\n📋 本頻道監測清單（${list.length} 筆）：\n${formatWatchSummary(list)}`
      : '\n\n📋 本頻道監測清單為空。';
    await message.reply(`${added ? '✅ 已加入' : 'ℹ 已存在'}本頻道監測清單：**${kw}**${summary}`);
  } catch (err) {
    await message.reply(`❌ 加入失敗：${err.message}`);
  }
}

async function handleList(message) {
  const list = readWatchlistFor(message.channel.id);
  if (!list.length) {
    await message.reply('本頻道目前沒有監測中的關鍵字。用 `!add <關鍵字>` 加入。');
    return;
  }
  await message.reply(`📋 本頻道目前監測的關鍵字（${list.length} 筆）：\n${formatWatchSummary(list)}`);
}

async function handleHelp(message) {
  await message.reply([
    '**eBay 卡價監測 Bot 指令**',
    '`!search <關鍵字>` — 即時搜尋 eBay，回傳最平前 5 筆卡片',
    '`!comp <關鍵字>` — 查詢歷史成交行情（已售成交中位數 + 統計樣本數 + 最近成交前 5 筆）',
    '`!rare <關鍵字> [價格範圍]` — 搜尋 /99 以下高稀缺卡片，且低於在售中位價；範圍可用 100-500 / 500+ / -500 或 cheap/mid/high/premium',
    '`!add <關鍵字>` — 把關鍵字加入「本頻道」的背景輪詢監測清單（寫入 presets.json）',
    '`!list` — 顯示目前監測中的關鍵字清單',
    '`!help` — 顯示本說明',
  ].join('\n'));
}

async function handleCommand(message, client) {
  if (message.author.bot) return;
  if (!message.content || !message.content.startsWith('!')) return;
  const [rawCmd, ...rest] = message.content.slice(1).trim().split(/\s+/);
  const cmd = (rawCmd || '').toLowerCase();
  const arg = normalizeKeyword(rest.join(' ').trim());

  if (cmd === 'search') return handleSearch(message, arg, client);
  if (cmd === 'comp') return handleComp(message, arg);
  if (cmd === 'rare') return handleRare(message, arg);
  if (cmd === 'add') return handleAdd(message, arg);
  if (cmd === 'list') return handleList(message);
  if (cmd === 'help') return handleHelp(message);
  return undefined;
}

/* ── 甜甜價推播（背景輪詢） ────────────────────────────── */

const alertedIds = new Set();

async function runPoll(client) {
  const { ids, channels } = await resolveAlertChannels(client);
  if (!ids.length) { log('⚠ 未設定 DISCORD_CHANNEL_ID，略過甜甜價推播。'); return; }
  if (!channels.length) { log('⚠ 所有推播頻道都找不到，略過推播。'); return; }

  const watch = readWatchlist();
  const minDiscountPct = numEnv('DISCORD_MIN_DISCOUNT', 0);

  // 每個頻道只掃自己嘅監測關鍵字，並只推回自己嘅頻道
  for (const channel of channels) {
    const list = watch[channel.id] || [];
    if (!list.length) {
      log(`ℹ 頻道 ${channel.id} 沒有監測關鍵字，略過（用 !add 加入）。`);
      continue;
    }
    for (const keyword of list) {
      try {
        log(`▶ 輪詢「${keyword}」→ 頻道 ${channel.id} …`);
        const res = await scanFor(keyword, { minDiscountPct, top: MAX_PUSH_PER_QUERY, log });
        const fresh = res.deals.filter((d) => {
          const id = d.listing.itemId || d.listing.url;
          return id && !alertedIds.has(id);
        });
        for (const deal of fresh.slice(0, MAX_PUSH_PER_QUERY)) {
          const id = deal.listing.itemId || deal.listing.url;
          if (id) alertedIds.add(id);
          const d = buildDealEmbed(keyword, deal, res.baseline, res.targetCurrency, { baselineKind: res.baselineKind });
          await channel.send({ embeds: d.embeds, components: d.components });
          log(`  🔔 推播甜甜價至頻道 ${channel.id}：${deal.listing.title}`);
        }
        if (alertedIds.size > 5000) {
          const keep = [...alertedIds].slice(-2000);
          alertedIds.clear();
          for (const id of keep) alertedIds.add(id);
        }
      } catch (err) {
        log(`⚠ 輪詢「${keyword}」失敗：${err.message}`);
      }
    }
  }
}

/* ── 啟動 ─────────────────────────────────────────────── */

async function main() {
  loadEnv();
  // 去除前後空白：在 Render 手動貼 token 時很容易夾帶換行或空白，導致登入失敗。
  const token = (process.env.DISCORD_TOKEN || '').trim();
  if (!token) {
    console.error('❌ 未設定 DISCORD_TOKEN。請在 .env 加入 DISCORD_TOKEN 與 DISCORD_CHANNEL_ID，再執行 npm run bot。');
    process.exitCode = 1;
    return;
  }

  // Render 免費方案只有「Web Service」（不含 Background Worker），
  // 所以要率先啟動 Health Check 伺服器監聽 PORT（預設 10000），
  // 讓 Render 健康檢查能第一時間回傳 200 通過，之後先至登入 Discord。
  const port = Number(process.env.PORT) || 10000;
  let server = null;
  const serverReady = new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('HTTP 200 OK - Bot is alive');
    });
    server.once('error', reject);
    server.listen(port, () => {
      log(`[HealthCheck] Server is listening on port ${port}`);
      resolve();
    });
  });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    // REST / WebSocket 逾時與重試設定（避免登入死等）
    rest: {
      timeout: 15_000, // REST 請求逾時（毫秒）
      retries: 3,      // 遇到 429 限流時自動重試次數
    },
    closeTimeout: 10_000,     // WebSocket 關閉前的等待時間
    waitGuildTimeout: 15_000, // 等待 guild 資料的逾時
  });

  client.once(Events.ClientReady, async (c) => {
    log(`✅ Discord Bot 已上線：${c.user.tag}`);
    await runPoll(client).catch((err) => log(`⚠ 初始輪詢失敗：${err.message}`));
    const intervalMin = Math.max(1, numEnv('DISCORD_POLL_INTERVAL_MIN', 120));
    setInterval(() => {
      runPoll(client).catch((err) => log(`⚠ 輪詢失敗：${err.message}`));
    }, intervalMin * 60_000);
    log(`⏱ 背景輪詢每 ${intervalMin} 分鐘執行一次。`);
  });

  client.on(Events.MessageCreate, (message) => {
    handleCommand(message, client).catch((err) => log(`⚠ 指令處理失敗：${err.message}`));
  });

  // 詳盡 Log：debug 較多輸出，可用環境變數 DISCORD_DEBUG=1 開啟
  client.on(Events.Debug, (info) => {
    if (process.env.DISCORD_DEBUG === '1') log(`🐞 ${info}`);
  });
  client.on(Events.Warn, (warn) => log(`⚠️ ${warn}`));
  client.on(Events.Error, (err) => {
    console.error('❌ Discord Client Error：');
    console.error(err && err.stack ? err.stack : String(err));
    if (err && err.code) console.error(`   code   = ${err.code}`);
    if (err && err.httpStatus) console.error(`   status = ${err.httpStatus}`);
  });
  client.on(Events.ShardError, (err, shardId) => {
    console.error(`❌ Shard ${shardId} Error：`);
    console.error(err && err.stack ? err.stack : String(err));
    if (err && err.code) console.error(`   code   = ${err.code}`);
  });
  client.on(Events.ShardDisconnect, (closeEvent, shardId) => {
    log(`⚠️ Shard ${shardId} 斷線：code=${closeEvent && closeEvent.code} reason=${closeEvent && closeEvent.reason}`);
  });
  client.on(Events.ShardReconnecting, (shardId) => log(`🔄 Shard ${shardId} 重新連線中…`));

  // 等 Health Check 伺服器成功啟動後，先至登入 Discord。
  await serverReady;

  // 登入自動重試：每次最多等 LOGIN_TIMEOUT_MS，失敗後等 LOGIN_RETRY_DELAY_MS 再重試（最多 MAX_LOGIN_ATTEMPTS 次）。
  const MAX_LOGIN_ATTEMPTS = 3;
  const LOGIN_TIMEOUT_MS = 20_000;
  const LOGIN_RETRY_DELAY_MS = 5_000;

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt += 1) {
    try {
      log(`🔐 嘗試登入 Discord（第 ${attempt}/${MAX_LOGIN_ATTEMPTS} 次）…`);
      await withTimeout(
        client.login(token),
        LOGIN_TIMEOUT_MS,
        `Discord 登入逾時（${LOGIN_TIMEOUT_MS / 1000} 秒）。請確認 DISCORD_TOKEN 正確、且伺服器能連到 gateway.discord.gg。`
      );
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      console.error(`❌ 第 ${attempt} 次登入失敗：`);
      console.error(err && err.stack ? err.stack : String(err));
      if (err && err.code) console.error(`   code   = ${err.code}`);
      if (err && err.httpStatus) console.error(`   status = ${err.httpStatus}`);
      // 先 destroy，確保下一個循環可以重新 login
      try { client.destroy(); } catch (_) { /* ignore */ }
      if (attempt < MAX_LOGIN_ATTEMPTS) {
        log(`⏳ ${LOGIN_RETRY_DELAY_MS / 1000} 秒後重試登入…`);
        await sleep(LOGIN_RETRY_DELAY_MS);
      }
    }
  }

  if (lastError) {
    console.error('❌ Discord Bot 登入失敗（已重試多次），將結束程序。');
    try { client.destroy(); } catch (_) { /* ignore */ }
    if (server) server.close();
    process.exitCode = 1;
    // 保險：若仍有其他 handle 讓事件迴圈無法自然結束，5 秒後強制結束。
    setTimeout(() => process.exit(1), 5000).unref();
    return;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`❌ 啟動失敗：${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  });
}

module.exports = {
  scanFor,
  scanRare,
  scanComp,
  readWatchlist,
  addWatchKeyword,
  loadPresets,
  buildDealEmbed,
  buildSearchEmbed,
  buildRareEmbed,
  buildCompEmbed,
  pushDealsToAlertChannel,
  parsePriceRange,
  splitKeywordAndRange,
  parseSoldDate,
  applyFilters,
  dominantCurrency,
};


