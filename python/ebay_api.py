# -*- coding: utf-8 -*-
"""
ebay_api.py — 模組 A：eBay Browse API（在售商品 / 一口價）
=========================================================
用官方 API 抓「仍在售（active）」商品，供：
  * 功能 1（主動監控）：每 N 小時輪詢新上架的一口價（Buy It Now）商品。
  * 功能 2（手動查價）：查某張卡目前在售價格，與歷史中位價比對。
"""

from __future__ import annotations

import base64
import time
from typing import List, Optional

import requests

from models import Listing, clean_item_url, extract_item_id

BASES = {
    "production": {
        "token": "https://api.ebay.com/identity/v1/oauth2/token",
        "api": "https://api.ebay.com",
        "scope": "https://api.ebay.com/oauth/api_scope",
    },
    "sandbox": {
        "token": "https://api.sandbox.ebay.com/identity/v1/oauth2/token",
        "api": "https://api.sandbox.ebay.com",
        "scope": "https://api.ebay.com/oauth/api_scope",
    },
}

MAX_LIMIT = 200
MAX_OFFSET = 10000


class EbayApiError(Exception):
    """eBay API 錯誤（含 HTTP 狀態碼與回應內容）。"""

    def __init__(self, message: str, status: Optional[int] = None, body=None):
        super().__init__(message)
        self.status = status
        self.body = body


class EbayBrowseApi:
    """eBay Browse API 客戶端。"""

    def __init__(self, client_id: str, client_secret: str,
                 env: str = "production", marketplace: str = "EBAY_US"):
        self.client_id = client_id
        self.client_secret = client_secret
        self.env = "sandbox" if env == "sandbox" else "production"
        self.marketplace = marketplace or "EBAY_US"
        self.base = BASES[self.env]
        self._token: Optional[str] = None
        self._token_expires_at: float = 0.0

    def get_token(self, force: bool = False) -> str:
        now = time.time()
        if not force and self._token and now < self._token_expires_at - 60:
            return self._token
        if not self.client_id or not self.client_secret:
            raise EbayApiError(
                "缺少 eBay API 憑證。請在 .env 設定 EBAY_CLIENT_ID 與 EBAY_CLIENT_SECRET。"
            )

        basic = base64.b64encode(
            f"{self.client_id}:{self.client_secret}".encode("utf-8")
        ).decode("utf-8")
        try:
            resp = requests.post(
                self.base["token"],
                data={"grant_type": "client_credentials", "scope": self.base["scope"]},
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Authorization": f"Basic {basic}",
                },
                timeout=30,
            )
        except requests.RequestException as exc:
            raise EbayApiError(f"取得 token 失敗（網路錯誤）：{exc}") from exc

        try:
            data = resp.json()
        except ValueError:
            raise EbayApiError(
                f"取得 token 失敗（HTTP {resp.status_code}）：{resp.text[:300]}",
                status=resp.status_code,
                body=resp.text,
            )

        if resp.status_code != 200 or not data.get("access_token"):
            raise EbayApiError(
                f"取得 token 失敗（HTTP {resp.status_code}）："
                f"{data.get('error_description') or data.get('error') or resp.text[:300]}",
                status=resp.status_code,
                body=data,
            )

        self._token = data["access_token"]
        self._token_expires_at = now + float(data.get("expires_in", 7200))
        return self._token

    @staticmethod
    def build_filter(buying: str = "fixed", currency: Optional[str] = None) -> str:
        filters: List[str] = []
        if buying == "fixed":
            filters.append("buyingOptions:{FIXED_PRICE}")
        elif buying == "auction":
            filters.append("buyingOptions:{AUCTION}")
        if currency:
            filters.append(f"priceCurrency:{currency}")
        return ",".join(filters)

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.get_token()}",
            "Accept": "application/json",
            "X-EBAY-C-MARKETPLACE-ID": self.marketplace,
        }

    def search_once(self, query: str, limit: int = MAX_LIMIT, offset: int = 0,
                    filter_: str = "", sort: str = "price") -> dict:
        params = {"q": query, "limit": min(limit, MAX_LIMIT), "offset": offset}
        if filter_:
            params["filter"] = filter_
        if sort:
            params["sort"] = sort

        try:
            resp = requests.get(
                f"{self.base['api']}/buy/browse/v1/item_summary/search",
                params=params,
                headers=self._headers(),
                timeout=30,
            )
        except requests.RequestException as exc:
            raise EbayApiError(f"搜尋失敗（網路錯誤）：{exc}") from exc

        try:
            data = resp.json()
        except ValueError:
            raise EbayApiError(
                f"搜尋回應無法解析（HTTP {resp.status_code}）：{resp.text[:300]}",
                status=resp.status_code,
                body=resp.text,
            )

        if resp.status_code == 401:
            self._token = None
            raise EbayApiError("存取被拒（401）：憑證無效或 token 過期，請檢查 .env。",
                               status=resp.status_code, body=data)
        if resp.status_code != 200:
            errors = data.get("errors") or []
            detail = " | ".join(f"{e.get('errorId')}: {e.get('message')}" for e in errors)
            raise EbayApiError(
                f"搜尋失敗（HTTP {resp.status_code}）：{detail or data.get('message') or resp.text[:300]}",
                status=resp.status_code,
                body=data,
            )

        return {"total": int(data.get("total") or 0),
                "items": data.get("itemSummaries") or [], "raw": data}


    def search_all(self, query: str, limit: int = 100, pages: int = 1,
                   buying: str = "fixed", sort: str = "newest") -> dict:
        """連續抓多批並去重，回傳正規化後的 Listing 清單。"""
        filter_ = self.build_filter(buying)
        sort_key = "newlyListed" if sort == "newest" else sort

        seen = set()
        out: List[Listing] = []
        total = 0

        for page in range(pages):
            offset = page * limit
            if offset >= MAX_OFFSET:
                break
            result = self.search_once(query, limit=limit, offset=offset,
                                      filter_=filter_, sort=sort_key)
            total = result["total"] or total
            items = result["items"]
            if not items:
                break
            for item in items:
                listing = self.normalize(item)
                if not listing:
                    continue
                key = listing.item_id or listing.url
                if key in seen:
                    continue
                seen.add(key)
                out.append(listing)
            if len(out) >= total:
                break

        return {
            "total": total,
            "listings": out,
            "filter": filter_,
            "marketplace": self.marketplace,
        }

    def search_active_fixed(self, query: str, limit: int = 100, pages: int = 1,
                            sort: str = "price") -> dict:
        """查詢「在售一口價」商品（額度耗盡降級保底用）。

        強制 filter=buyingOptions:{FIXED_PRICE}，僅比對一口價 / 直購在售商品，
        徹底排除尚未結標的低價起標拍賣干擾。
        """
        return self.search_all(query, limit=limit, pages=pages,
                               buying="fixed", sort=sort)

    def get_item(self, item_id: str) -> Optional[Listing]:
        """查單一商品（貼網址查價用）。"""
        try:
            resp = requests.get(
                f"{self.base['api']}/buy/browse/v1/item/{item_id}",
                headers=self._headers(),
                timeout=30,
            )
        except requests.RequestException as exc:
            raise EbayApiError(f"查詢商品失敗（網路錯誤）：{exc}") from exc

        try:
            data = resp.json()
        except ValueError:
            raise EbayApiError(
                f"商品回應無法解析（HTTP {resp.status_code}）：{resp.text[:300]}",
                status=resp.status_code,
                body=resp.text,
            )
        if resp.status_code == 401:
            self._token = None
            raise EbayApiError("存取被拒（401）：憑證無效或 token 過期，請檢查 .env。",
                               status=resp.status_code, body=data)
        if resp.status_code != 200:
            raise EbayApiError(f"查詢商品失敗（HTTP {resp.status_code}）",
                               status=resp.status_code, body=data)
        return self.normalize(data)

    @staticmethod
    def normalize(item: dict) -> Optional[Listing]:
        """把 Browse API 的 itemSummary / item 轉成統一的 Listing 結構。"""
        price_raw = (item.get("price") or {}).get("value")
        try:
            price = float(price_raw)
        except (TypeError, ValueError):
            return None

        currency = (item.get("price") or {}).get("currency")

        shipping: Optional[float] = None
        shipping_options = item.get("shippingOptions") or []
        if shipping_options:
            sc = (shipping_options[0].get("shippingCost") or {}).get("value")
            try:
                shipping = float(sc)
            except (TypeError, ValueError):
                shipping = None

        total_price = price + shipping if shipping else price
        url = clean_item_url(item.get("itemWebUrl") or item.get("itemAffiliateWebUrl") or "")
        seller = item.get("seller")
        image = item.get("image")

        return Listing(
            item_id=item.get("itemId") or extract_item_id(url),
            title=str(item.get("title") or ""),
            price=price,
            currency=currency,
            shipping=shipping,
            total_price=total_price,
            condition=str(item.get("condition") or ""),
            buying_options=list(item.get("buyingOptions") or []),
            url=url,
            seller=seller.get("username", "") if isinstance(seller, dict) else "",
            image=image.get("imageUrl", "") if isinstance(image, dict) else "",
            listing_date=item.get("itemCreationDate"),
            source="api",
        )

