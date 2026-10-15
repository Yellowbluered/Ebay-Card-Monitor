# -*- coding: utf-8 -*-
"""
price_engine.py — 串接模組 B + C + D
====================================
查詢某款卡片的「歷史中位成交價」的完整流程：

  1. 先查 SQLite 快取（baseline_cache）：
     若在 TTL（預設 7 天）內已有該卡特徵的中位價 → 直接讀本機，不發外部請求。
  2. 快取無紀錄或已過期 → 呼叫本機 Sold 爬蟲抓歷史成交。
  3. 用模組 D 的嚴格比對（strict_match）過濾出「特徵完全吻合」的成交紀錄。
  4. 以 IQR 剔除離群值後取中位數，寫回 sold_records + baseline_cache。

另外提供 find_deals() 給模組 E：找出「現價（含運費）<= 歷史中位價 * 折扣門檻」的甜甜價。
"""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import asdict
from typing import List, Optional, Tuple

from card_parser import is_base_card, parse_card_title, strict_match, title_has_scarcity_signal
from db import CardDatabase
from ebay_api import EbayBrowseApi
from ebay_sold_scraper import (
    EbaySoldScraper,
    ExternalQuotaExhaustedError,
    ScraperBlockedError,
    is_quota_exhausted,
)
from models import CardFeature, Listing, SoldRecord, currency_for_marketplace
from stats import discount_percent, robust_median


def _dominant_currency(records: List[SoldRecord], fallback: str) -> str:
    currencies = [r.currency for r in records if r.currency]
    if currencies:
        return Counter(currencies).most_common(1)[0][0]
    return fallback


# 額度耗盡降級後回覆給 Discord 的醒目警告標籤（需求 2.d）。
DEGRADE_WARNING = "⚠️ 已售額度已耗盡，目前顯示同特徵在售一口價參考中位數"


def _recent_sold_fallback(db, card_id, fallback_currency, settings) -> Optional[dict]:
    """反爬 / 額度耗盡時，退回 SQLite 既有歷史成交紀錄算中位價（若有）。"""
    if card_id is None:
        return None
    recent = db.get_recent_sold(card_id)
    if not recent:
        return None
    prices = [r["price"] for r in recent if r["price"]]
    stats = robust_median(prices, k=settings.iqr_k, min_samples=settings.min_sold_samples)
    return {
        "source": "cache-fallback", "card_id": card_id,
        "median": stats.median,
        "currency": fallback_currency,
        "sample_count": stats.count,
        "used_count": stats.used_count,
        "stats": stats,
    }


def degrade_to_active_baseline(features: CardFeature, settings, log=None) -> dict:
    """額度耗盡智慧降級保底：改查官方 eBay Browse API 的「同特徵在售一口價」。

    嚴格規則：
      a. 用 card_parser 的結構化特徵（年份/系列/平行/編號/評級）組關鍵字，
         絕不只用純球員姓名。
      b. 強制 filter=buyingOptions:{FIXED_PRICE}，只比對一口價在售，
         排除尚未結標的低價起標拍賣干擾。
      c. 以 stats.py 的 IQR 演算法剔除極端離群值，回報合理掛牌中位數。
    """
    log = log or (lambda *a, **k: None)
    fallback_currency = currency_for_marketplace(settings.marketplace)
    result = {
        "source": "active-degraded",
        "degraded": True,
        "warning": DEGRADE_WARNING,
        "median": None,
        "currency": fallback_currency,
        "sample_count": 0,
        "used_count": 0,
        "matched": 0,
        "stats": None,
    }

    if not (settings.ebay_client_id and settings.ebay_client_secret):
        log("    [Engine] 降級失敗：未設定 EBAY_CLIENT_ID/SECRET，無法查在售。")
        result["reason"] = "no-browse-api"
        return result

    query = features.search_query()
    if not query:
        result["reason"] = "empty-query"
        return result

    log(f"    [Engine] 已售額度耗盡，降級查在售一口價：{query}")
    try:
        api = EbayBrowseApi(settings.ebay_client_id, settings.ebay_client_secret,
                            settings.ebay_env, settings.marketplace)
        # b. 強制 FIXED_PRICE，排除尚未結標的低價起標拍賣
        listings = api.search_active_fixed(query, limit=100, pages=1,
                                           sort="price")["listings"]
    except Exception as exc:  # noqa: BLE001
        log(f"    [Engine] 降級查在售失敗：{exc}")
        result["reason"] = f"browse-error: {exc}"
        return result

    # a. 精準比對：只留特徵完全吻合的在售掛牌
    matched_prices: List[float] = []
    currency = fallback_currency
    for listing in listings:
        candidate = parse_card_title(listing.title, settings)
        ok, _ = strict_match(features, candidate)
        if not ok:
            continue
        if currency == fallback_currency and listing.currency:
            currency = listing.currency
        total = listing.total_price if listing.total_price else listing.price
        if total and total > 0:
            matched_prices.append(total)

    # c. IQR 剔除離群值後取中位數（降級情境樣本較少，至少 1 筆即回報參考中位數）
    stats = robust_median(matched_prices, k=settings.iqr_k, min_samples=1)

    result.update({
        "median": stats.median,
        "currency": currency,
        "sample_count": stats.count,
        "used_count": stats.used_count,
        "matched": len(matched_prices),
        "stats": stats,
    })
    return result


def check_cache(features: CardFeature, settings) -> Optional[dict]:
    """「快取優先」純讀取比對：只查 SQLite，**絕不發任何網絡請求**。

    命中且未過期 → 回傳 baseline dict（source="cache"）；
    無紀錄或已過期 → 回傳 None（呼叫端才排入爬蟲隊列）。
    """
    db = CardDatabase(str(settings.resolved_db_path))
    try:
        card_id = db.find_card_id(features.fingerprint())
        if card_id is None:
            return None
        cached = db.get_cached_baseline(card_id, settings.cache_ttl_days)
        if not cached:
            return None
        return {
            "source": "cache",
            "card_id": card_id,
            "median": cached["median_price"],
            "currency": cached["currency"] or currency_for_marketplace(settings.marketplace),
            "sample_count": cached["sample_count"],
            "used_count": cached["used_count"],
            "stats": None,
        }
    finally:
        db.close()


def resolve_item_cache(item_id: str, settings) -> Optional[dict]:
    """貼網址的「即時比對」：由 item_id 直接查 SQLite，不需任何 eBay 請求。

    有對照紀錄且基準價未過期 → 回傳 dict（features、baseline、stored_title）；
    否則回傳 None（呼叫端才排入隊列重新抓取）。
    """
    db = CardDatabase(str(settings.resolved_db_path))
    try:
        row = db.find_item_card(item_id)
        if not row:
            return None
        cached = db.get_cached_baseline(row["card_id"], settings.cache_ttl_days)
        if not cached:
            return None
        features = CardFeature(**json.loads(row["features_json"]))
        return {
            "item_id": item_id,
            "features": features,
            "stored_title": row.get("title") or features.display_name(),
            "baseline": {
                "source": "cache",
                "card_id": row["card_id"],
                "median": cached["median_price"],
                "currency": cached["currency"] or currency_for_marketplace(settings.marketplace),
                "sample_count": cached["sample_count"],
                "used_count": cached["used_count"],
                "stats": None,
            },
        }
    finally:
        db.close()


def save_item_index(item_id: str, features: CardFeature, card_id: Optional[int],
                    title: str, settings) -> None:
    """把「商品網址 → 卡牌特徵」寫入 SQLite，供日後貼網址零網絡命中。"""
    if not item_id or card_id is None:
        return
    db = CardDatabase(str(settings.resolved_db_path))
    try:
        db.save_item_index(
            item_id=item_id,
            card_id=card_id,
            fingerprint=features.fingerprint(),
            title=title,
            features_json=json.dumps(asdict(features), ensure_ascii=False),
        )
    finally:
        db.close()


def get_baseline(features: CardFeature, settings, log=None) -> dict:
    """取得某張卡的歷史中位成交價（快取優先，缺資料才爬蟲）。

    回傳 dict：
      source       快取(cache) / 爬蟲(scrape) / 無資料(none)
      median       歷史中位價（可能為 None = 樣本不足）
      currency     幣別
      sample_count 原始成交樣本數
      used_count   IQR 剔除離群值後的樣本數
      stats        PriceStats（爬蟲路徑才有完整統計）
    """
    log = log or (lambda *a, **k: None)
    fallback_currency = currency_for_marketplace(settings.marketplace)
    db = CardDatabase(str(settings.resolved_db_path))

    try:
        fingerprint = features.fingerprint()
        card_id = db.find_card_id(fingerprint)

        # 1) 快取命中且未過期 → 直接回傳，不發任何外部請求
        if card_id is not None:
            cached = db.get_cached_baseline(card_id, settings.cache_ttl_days)
            if cached:
                log("    [Engine] 命中 SQLite 快取，不發外部請求。")
                return {
                    "source": "cache",
                    "card_id": card_id,
                    "median": cached["median_price"],
                    "currency": cached["currency"] or fallback_currency,
                    "sample_count": cached["sample_count"],
                    "used_count": cached["used_count"],
                    "stats": None,
                }

        # 2) 快取無紀錄或過期 → 呼叫成交價爬蟲
        query = features.search_query()
        if not query:
            return {
                "source": "none", "card_id": card_id, "median": None,
                "currency": fallback_currency, "sample_count": 0,
                "used_count": 0, "stats": None, "reason": "empty-query",
            }

        # 熔斷：兩家外部 Sold API 額度皆已耗盡 → 直接降級，不再盲目重試
        if is_quota_exhausted():
            cached = _recent_sold_fallback(db, card_id, fallback_currency, settings)
            if cached is not None:
                return cached
            return degrade_to_active_baseline(features, settings, log)

        log(f"    [Engine] 快取無效，抓取成交紀錄：{query}")
        scraper = EbaySoldScraper(settings)
        try:
            sold_records = scraper.fetch_sold(query)
        except ExternalQuotaExhaustedError:
            # 兩家外部 Sold API 額度皆耗盡 → 智慧降級查在售一口價（不直接報錯）
            cached = _recent_sold_fallback(db, card_id, fallback_currency, settings)
            if cached is not None:
                return cached
            return degrade_to_active_baseline(features, settings, log)
        except ScraperBlockedError:
            # 被反爬擋下時，若 SQLite 已有歷史成交紀錄，仍可退而求其次
            cached = _recent_sold_fallback(db, card_id, fallback_currency, settings)
            if cached is not None:
                return cached
            raise

        # 3) 嚴格比對（模組 D）：只留特徵完全吻合的成交紀錄
        #    普卡防呆：查詢目標為普卡（無簽名 / 非限量）時，先以原始標題排除
        #    Auto / Signature / 1/1 / One of One / 低編號 等限量與簽名成交紀錄，
        #    避免把限量卡、簽名卡混入普卡歷史基準價。
        target_is_base = is_base_card(features)
        matched: List[SoldRecord] = []
        rejected = 0
        for rec in sold_records:
            if target_is_base and title_has_scarcity_signal(rec.title):
                rejected += 1
                continue
            candidate = parse_card_title(rec.title, settings)
            ok, _ = strict_match(features, candidate)
            if ok:
                matched.append(rec)
            else:
                rejected += 1

        currency = _dominant_currency(matched, fallback_currency)
        prices = [r.price for r in matched]
        stats = robust_median(prices, k=settings.iqr_k, min_samples=settings.min_sold_samples)

        # 4) 寫回 SQLite（卡片、成交紀錄、基準價快取）
        if card_id is None:
            card_id = db.insert_card(features)
        if matched:
            db.save_sold_records(card_id, matched)
        if stats.median is not None:
            db.save_baseline(card_id, stats.median, currency, stats.count, stats.used_count)

        return {
            "source": "scrape",
            "card_id": card_id,
            "median": stats.median,
            "currency": currency,
            "sample_count": stats.count,
            "used_count": stats.used_count,
            "matched": len(matched),
            "rejected": rejected,
            "stats": stats,
        }
    finally:
        db.close()


def find_deals(features: CardFeature, listings: List[Listing], baseline: Optional[float],
               threshold: float, settings) -> Tuple[List[dict], int]:
    """在在售清單中找出「甜甜價」。

    規則：現價（含運費）<= 歷史中位價 * threshold，且特徵嚴格吻合。
    回傳 (deals, matched_count)。
    """
    deals: List[dict] = []
    matched_count = 0

    for listing in listings:
        candidate = parse_card_title(listing.title, settings)
        ok, _ = strict_match(features, candidate)
        if not ok:
            continue
        matched_count += 1

        total = listing.total_price if listing.total_price else listing.price
        if baseline and total > 0 and total <= baseline * threshold:
            deals.append({
                "listing": listing,
                "total_price": total,
                "discount_pct": discount_percent(total, baseline),
                "delta": baseline - total,
            })

    deals.sort(key=lambda d: d["total_price"])
    return deals, matched_count
