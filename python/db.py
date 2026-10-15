# -*- coding: utf-8 -*-
"""
db.py — 模組 B：本地 SQLite 記憶庫（防封鎖 + 節省請求）
=====================================================
設計三張表：

  1. cards          卡牌特徵（以 fingerprint 唯一識別一款卡）
  2. sold_records   歷史成交紀錄（爬蟲抓回來就存，供日後重複使用）
  3. baseline_cache 已算好的「歷史中位價」快取（含 computed_at 做 TTL 判斷）

查詢流程（見 price_engine.py）：
  先查 baseline_cache，若在 TTL（預設 7 天）內 → 直接讀本機、不發外部請求；
  若無紀錄或已過期 → 才呼叫成交價爬蟲，算完後寫回 sold_records + baseline_cache。
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from dataclasses import asdict
from typing import List, Optional

from models import CardFeature, SoldRecord

_SCHEMA = """
CREATE TABLE IF NOT EXISTS cards (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint   TEXT    NOT NULL UNIQUE,
    features_json TEXT    NOT NULL,
    display_name  TEXT    NOT NULL,
    created_at    REAL    NOT NULL,
    updated_at    REAL    NOT NULL
);

CREATE TABLE IF NOT EXISTS sold_records (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id    INTEGER NOT NULL,
    item_id    TEXT,
    title      TEXT,
    price      REAL    NOT NULL,
    currency   TEXT,
    shipping   REAL,
    sold_date  TEXT,
    url        TEXT,
    source     TEXT,
    scraped_at REAL    NOT NULL,
    UNIQUE(card_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_sold_card ON sold_records(card_id);

CREATE TABLE IF NOT EXISTS baseline_cache (
    card_id      INTEGER PRIMARY KEY,
    median_price REAL NOT NULL,
    currency     TEXT,
    sample_count INTEGER NOT NULL,
    used_count   INTEGER NOT NULL,
    computed_at  REAL NOT NULL
);

-- 「商品 item_id → 卡牌特徵」對照：貼網址查價時可「零網絡」直接命中快取
CREATE TABLE IF NOT EXISTS item_index (
    item_id       TEXT PRIMARY KEY,
    card_id       INTEGER NOT NULL,
    fingerprint   TEXT NOT NULL,
    title         TEXT,
    features_json TEXT NOT NULL,
    updated_at    REAL NOT NULL
);
"""


class CardDatabase:
    """SQLite 封裝：建表、查卡、快取、成交紀錄讀寫。

    使用單一連線 + RLock 保護，讓 Discord 的非同步排程與多執行緒呼叫都安全。
    """

    def __init__(self, db_path: str):
        self.db_path = str(db_path)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.commit()

    @staticmethod
    def _now() -> float:
        return time.time()

    # ---- 卡牌特徵 -------------------------------------------------------

    def find_card_id(self, fingerprint: str) -> Optional[int]:
        with self._lock:
            row = self._conn.execute(
                "SELECT id FROM cards WHERE fingerprint = ?", (fingerprint,)
            ).fetchone()
            return row["id"] if row else None

    def insert_card(self, feature: CardFeature) -> int:
        """插入卡牌特徵（若已存在則回傳既有 id）。"""
        fingerprint = feature.fingerprint()
        now = self._now()
        with self._lock:
            self._conn.execute(
                "INSERT OR IGNORE INTO cards "
                "(fingerprint, features_json, display_name, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    fingerprint,
                    json.dumps(asdict(feature), ensure_ascii=False),
                    feature.display_name(),
                    now,
                    now,
                ),
            )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT id FROM cards WHERE fingerprint = ?", (fingerprint,)
            ).fetchone()
            return row["id"]

    # ---- 基準價快取 -----------------------------------------------------

    def get_cached_baseline(self, card_id: int, ttl_days: int) -> Optional[dict]:
        """讀取基準價快取；若不存在或超過 TTL 天數則回傳 None。"""
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM baseline_cache WHERE card_id = ?", (card_id,)
            ).fetchone()
        if not row:
            return None
        age = self._now() - row["computed_at"]
        if age > ttl_days * 86400:
            return None
        return dict(row)

    def save_baseline(self, card_id: int, median_price: float, currency: str,
                      sample_count: int, used_count: int) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO baseline_cache "
                "(card_id, median_price, currency, sample_count, used_count, computed_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (card_id, median_price, currency, sample_count, used_count, self._now()),
            )
            self._conn.commit()

    # ---- 成交紀錄 -------------------------------------------------------

    def save_sold_records(self, card_id: int, records: List[SoldRecord]) -> int:
        """寫入成交紀錄（以 card_id + item_id 去重），回傳實際新增筆數。"""
        now = self._now()
        inserted = 0
        with self._lock:
            for rec in records:
                cur = self._conn.execute(
                    "INSERT OR IGNORE INTO sold_records "
                    "(card_id, item_id, title, price, currency, shipping, sold_date, "
                    "url, source, scraped_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        card_id,
                        rec.item_id,
                        rec.title,
                        rec.price,
                        rec.currency,
                        rec.shipping,
                        rec.sold_date,
                        rec.url,
                        rec.source,
                        now,
                    ),
                )
                inserted += cur.rowcount
            self._conn.commit()
        return inserted

    def get_recent_sold(self, card_id: int, limit: int = 20) -> List[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM sold_records WHERE card_id = ? ORDER BY scraped_at DESC LIMIT ?",
                (card_id, limit),
            ).fetchall()
            return [dict(r) for r in rows]

    def find_item_card(self, item_id: str) -> Optional[dict]:
        """依 eBay item_id 查出先前快取的「商品 → 卡牌」對照。"""
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM item_index WHERE item_id = ?", (item_id,)
            ).fetchone()
            return dict(row) if row else None

    def save_item_index(self, item_id: str, card_id: int, fingerprint: str,
                        title: str, features_json: str) -> None:
        """寫入「商品網址 → 卡牌特徵」對照，供日後貼網址即時比對。"""
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO item_index "
                "(item_id, card_id, fingerprint, title, features_json, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (item_id, card_id, fingerprint, title, features_json, self._now()),
            )
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()
