# -*- coding: utf-8 -*-
"""
models.py — 資料結構與通用解析工具
==================================
全專案共用的資料模型與工具函式：

  * CardFeature  卡牌特徵（模組 D）
  * Listing      在售商品（模組 A 的 active listing）
  * SoldRecord   歷史成交紀錄（模組 C 爬蟲回傳）
  * ParsedPrice  價格解析結果
  * PriceStats   價格統計結果（中位數 + IQR，模組 D）

價格解析（parse_price）同時服務 eBay Browse API（結構化）與爬蟲（HTML 文字）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Optional

# ---------------------------------------------------------------------------
# 幣別 / 市場對照表（對齊原 Node 版 parse.js）
# ---------------------------------------------------------------------------

# 各市場幣別代碼 ↔ 符號對照（爬蟲模式用來判斷幣別）
CURRENCY_SYMBOLS: List[tuple] = [
    ("US $", "USD"),
    ("C $", "CAD"),
    ("AU $", "AUD"),
    ("HK $", "HKD"),
    ("S $", "SGD"),
    ("EUR", "EUR"),
    ("$", "USD"),
    ("£", "GBP"),
    ("€", "EUR"),
    ("¥", "JPY"),
]

# 市場 ID → 爬蟲用的網域
MARKETPLACE_DOMAINS = {
    "EBAY_US": "www.ebay.com",
    "EBAY_GB": "www.ebay.co.uk",
    "EBAY_DE": "www.ebay.de",
    "EBAY_AT": "www.ebay.at",
    "EBAY_AU": "www.ebay.com.au",
    "EBAY_CA": "www.ebay.ca",
    "EBAY_HK": "www.ebay.com.hk",
    "EBAY_SG": "www.ebay.com.sg",
    "EBAY_IE": "www.ebay.ie",
    "EBAY_FR": "www.ebay.fr",
    "EBAY_IT": "www.ebay.it",
    "EBAY_ES": "www.ebay.es",
}

# 市場 ID → 預設幣別
MARKETPLACE_CURRENCY = {
    "EBAY_US": "USD",
    "EBAY_GB": "GBP",
    "EBAY_DE": "EUR",
    "EBAY_AT": "EUR",
    "EBAY_AU": "AUD",
    "EBAY_CA": "CAD",
    "EBAY_HK": "HKD",
    "EBAY_SG": "SGD",
    "EBAY_IE": "EUR",
    "EBAY_FR": "EUR",
    "EBAY_IT": "EUR",
    "EBAY_ES": "EUR",
}

# 幣別代碼 → 顯示符號
CURRENCY_SIGN = {
    "USD": "$",
    "CAD": "C $",
    "AUD": "A $",
    "HKD": "HK $",
    "SGD": "S $",
    "GBP": "£",
    "EUR": "€",
    "JPY": "¥",
}


def domain_for_marketplace(marketplace_id: str) -> str:
    return MARKETPLACE_DOMAINS.get(marketplace_id, MARKETPLACE_DOMAINS["EBAY_US"])


def currency_for_marketplace(marketplace_id: str) -> str:
    return MARKETPLACE_CURRENCY.get(marketplace_id, "USD")


def sign_for_currency(code: str) -> str:
    return CURRENCY_SIGN.get(code, f"{code} ")


# ---------------------------------------------------------------------------
# 價格解析
# ---------------------------------------------------------------------------

@dataclass
class ParsedPrice:
    value: Optional[float] = None
    currency: Optional[str] = None
    is_range: bool = False
    low: Optional[float] = None
    high: Optional[float] = None


def parse_price(text) -> ParsedPrice:
    """從一段文字解析出價格。

    支援：US $1,234.56 / C $5.99 / £3.50 / €12,00 / 12.99 / "12.00 to 20.00"。
    區間價（如「US $12.00 to US $20.00」）以低價作為比較基準。
    """
    if text is None:
        return ParsedPrice()
    s = str(text).replace("\u00a0", " ").strip()
    if not s:
        return ParsedPrice()

    currency = None
    up = s.upper()
    for symbol, code in CURRENCY_SYMBOLS:
        if symbol.upper() in up:
            currency = code
            break

    # 抓出所有數字片段（含千分位與小數）
    raw = re.findall(r"\d[\d.,\s]*\d|\d", s)
    numbers: List[float] = []
    for chunk in raw:
        cleaned = chunk.replace(" ", "")
        has_comma = "," in cleaned
        has_dot = "." in cleaned
        if has_comma and has_dot:
            # 1,234.56 → 去掉千分位逗號；1.234,56（歐式）→ 逗號是小數點
            if cleaned.rfind(",") > cleaned.rfind("."):
                normalized = cleaned.replace(".", "").replace(",", ".")
            else:
                normalized = cleaned.replace(",", "")
        elif has_comma:
            # 12,00（歐式小數）或 1,234（千分位）
            decimals = cleaned.split(",")[-1]
            normalized = cleaned.replace(",", ".") if len(decimals) == 2 else cleaned.replace(",", "")
        else:
            normalized = cleaned
        try:
            numbers.append(float(normalized))
        except ValueError:
            continue

    if not numbers:
        return ParsedPrice(currency=currency)

    is_range = len(numbers) > 1 and re.search(r"\b(to|-|–|~)\b", s, re.IGNORECASE) is not None
    low = min(numbers)
    high = max(numbers)
    return ParsedPrice(
        value=low if is_range else numbers[0],
        currency=currency,
        is_range=is_range,
        low=low,
        high=high,
    )


# ---------------------------------------------------------------------------
# 資料模型
# ---------------------------------------------------------------------------

@dataclass
class CardFeature:
    """卡牌特徵（模組 D 的結構化解析結果）。"""

    player_or_character: str = ""   # 球員 / 角色名
    year: str = ""                  # 年份
    set_name: str = ""              # 系列名稱
    card_number: str = ""           # 卡號
    parallel_or_serial: str = ""    # 平行版本 / 編號（Base、Refractor、/10 …）
    grading_company: str = ""       # 評級機構（PSA、BGS、CGC、Raw 裸卡）
    grade: str = ""                 # 分數（10、9.5 …）
    is_autograph: bool = False      # 是否簽名

    @staticmethod
    def _norm(s) -> str:
        return " ".join(str(s or "").lower().split())

    @staticmethod
    def _toks(s) -> set:
        """把一段文字拆成「小寫、去空白」的 token 集合。"""
        return set(str(s or "").lower().split())

    def identity_tokens(self) -> list:
        """身份 token = 球員/角色 ∪ 系列的 token 集合（排序後回傳）。

        因為同一張卡的標題可能把系列與球員寫在不同位置，
        比對時用「聯集」可避免拆分歧義造成誤判。
        """
        return sorted(self._toks(self.player_or_character) | self._toks(self.set_name))

    def _parallel_key(self) -> str:
        """平行/編號的正規化 key：把「Base」與「未標示」都視為普卡（空字串）。

        並把限量編號統一成「張數」：4/10、/10 → "10"，
        讓指紋與 strict_match 的比對規則一致。
        """
        toks = set()
        for t in self._toks(self.parallel_or_serial):
            m = re.fullmatch(r"(\d{1,3})?/(\d{1,4})", t)
            if m:
                toks.add(m.group(2))
            else:
                toks.add(t)
        if toks <= {"base"}:
            return ""
        return ",".join(sorted(toks))

    def fingerprint(self) -> str:
        """產生唯一指紋，用於 SQLite 快取與「完全吻合」比對。

        設計要點：
          * 身份（球員 + 系列）用 token 集合聯集 → 與單字順序、拆分歧義無關。
          * 平行/編號（parallel_or_serial）用 token 集合 → 確保 Base 與 /10 絕不混用。
          * 年份、卡號、評級、分數等單值欄位用小寫正規化字串。
        """
        parts = [
            ",".join(self.identity_tokens()),
            self._norm(self.year),
            self._norm(self.card_number),
            self._parallel_key(),
            self._norm(self.grading_company),
            self._norm(self.grade),
            "auto" if self.is_autograph else "",
        ]
        return "|".join(parts)

    def display_name(self) -> str:
        """人類可讀的全名（例如「2024 Topps Chrome Jannik Sinner PSA 10」）。"""
        parts: List[str] = []
        for p in (self.year, self.player_or_character, self.set_name,
                  self.card_number, self.parallel_or_serial):
            if p and p.strip():
                parts.append(p.strip())
        grading = (self.grading_company + " " + self.grade).strip()
        if grading:
            parts.append(grading)
        if self.is_autograph:
            parts.append("Auto")
        return " ".join(parts)

    def search_query(self) -> str:
        """組出用來搜尋 eBay「成交紀錄」的關鍵字（抓取後再用嚴格比對過濾）。"""
        parts = [
            self.year,
            self.player_or_character,
            self.set_name,
            self.card_number,
            self.parallel_or_serial,
        ]
        grading = (self.grading_company + " " + self.grade).strip()
        if grading:
            parts.append(grading)
        if self.is_autograph:
            parts.append("auto")
        return " ".join(p for p in parts if p and p.strip())


@dataclass
class Listing:
    """在售商品（模組 A：eBay Browse API 回傳的 active listing）。"""

    item_id: Optional[str] = None
    title: str = ""
    price: float = 0.0
    currency: Optional[str] = None
    shipping: Optional[float] = None
    total_price: float = 0.0
    condition: str = ""
    buying_options: List[str] = field(default_factory=list)
    url: str = ""
    seller: str = ""
    image: str = ""
    listing_date: Optional[str] = None
    source: str = "api"


@dataclass
class SoldRecord:
    """歷史成交紀錄（模組 C 爬蟲回傳）。"""

    item_id: Optional[str] = None
    title: str = ""
    price: float = 0.0
    currency: Optional[str] = None
    shipping: Optional[float] = None
    sold_date: Optional[str] = None
    url: str = ""
    source: str = "scrape"


@dataclass
class PriceStats:
    """價格統計結果（中位數 + IQR 離群值過濾，模組 D）。"""

    count: int = 0              # 原始樣本數
    used_count: int = 0         # 剔除離群值後實際使用樣本數
    removed: int = 0            # 被剔除的離群值數量
    median: Optional[float] = None
    min: Optional[float] = None
    max: Optional[float] = None
    q1: Optional[float] = None
    q3: Optional[float] = None
    iqr: Optional[float] = None
    lower: Optional[float] = None
    upper: Optional[float] = None
    values: List[float] = field(default_factory=list)


def extract_item_id(url) -> Optional[str]:
    """從 eBay 商品連結取出 itemId。"""
    if not url:
        return None
    s = str(url)
    m = re.search(r"/itm/(?:[^/?#]*/)?(\d{9,15})", s) or re.search(r"[?&]item=(\d{9,15})", s)
    return m.group(1) if m else None


def clean_item_url(url) -> str:
    """移除追蹤參數，保留乾淨可分享的 eBay 商品連結。"""
    if not url:
        return ""
    try:
        from urllib.parse import urlparse, urlunparse

        u = urlparse(str(url))
        item_id = extract_item_id(str(url))
        if item_id:
            return f"https://{u.netloc}/itm/{item_id}"
        return urlunparse((u.scheme, u.netloc, u.path, "", "", ""))
    except Exception:
        return str(url)


