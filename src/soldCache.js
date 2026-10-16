'use strict';

/**
 * soldCache.js — 已售成交價 7 天快取（JSON 檔，零依賴）
 * ========================================================
 * 目的：避免重複扣除外部 Sold API（ScrapingDog / SerpApi）額度。
 * 保存「原始成交紀錄 + 計算時間」，7 天內（SOLD_CACHE_TTL_DAYS，預設 7）直接讀本機、
 * 不發任何外部請求；中位數由呼叫端在讀取後重新計算（因此過濾規則更新會立即生效）。
 *
 * 檔案位置：${CACHE_DIR || os.tmpdir()}/sold_cache.json（預設改用系統暫存目錄，
 *            避免 Docker 容器內一般使用者對 /app 根目錄無寫入權限而 EACCES）。
 * 使用「寫入暫存檔再 rename」的原子寫法，避免寫到一半 crash 造成檔案損毀。
 * 寫入失敗（如權限不足）僅輸出警告、不中斷主流程。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TTL_DAYS = 7;
// 預設快取路徑：優先 CACHE_DIR（可自訂），否則用系統暫存目錄。
// 不再寫到專案根目錄，避免 Docker 容器內一般使用者對 /app 無寫入權限（EACCES）。
const CACHE_FILE = path.join(process.env.CACHE_DIR || os.tmpdir(), 'sold_cache.json');

class SoldCache {
  constructor(filePath = CACHE_FILE, ttlDays = DEFAULT_TTL_DAYS) {
    this.filePath = filePath;
    this.ttlDays = Math.max(1, Number(ttlDays) || DEFAULT_TTL_DAYS);
  }

  static normalizeKey(query) {
    return String(query || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (_) {
      return {};
    }
  }

  _save(data) {
    const tmp = `${this.filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      // 寫入防呆降級：權限不足（EACCES）或磁碟異常時僅警告，不中斷主流程。
      const code = err && err.code ? err.code : (err && err.message ? err.message : String(err));
      console.warn(`[soldCache] ⚠ 快取寫入失敗（${code}），本次略過快取：${this.filePath}`);
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
  }

  /** 命中且未過期 → 回傳 entry；無紀錄或已過期 → null。 */
  get(query) {
    const entry = this._load()[SoldCache.normalizeKey(query)];
    if (!entry) return null;
    const ageMs = Date.now() - (entry.computedAt || 0);
    if (ageMs > this.ttlDays * 86400_000) return null;
    return entry;
  }

  /** 寫入（或覆蓋）某查詢的成交紀錄快取。 */
  set(query, { records, currency, source } = {}) {
    const data = this._load();
    data[SoldCache.normalizeKey(query)] = {
      computedAt: Date.now(),
      currency: currency || null,
      source: source || null,
      records: Array.isArray(records) ? records : [],
    };
    this._save(data);
  }

  /** 清除某一查詢；query 為 null/undefined 時清空整個快取。 */
  clear(query) {
    if (query == null) {
      try { fs.unlinkSync(this.filePath); } catch (_) { /* ignore */ }
      try { fs.unlinkSync(`${this.filePath}.tmp`); } catch (_) { /* ignore */ }
      return;
    }
    const data = this._load();
    delete data[SoldCache.normalizeKey(query)];
    this._save(data);
  }

  count() {
    return Object.keys(this._load()).length;
  }
}

module.exports = { SoldCache, DEFAULT_TTL_DAYS, CACHE_FILE };
