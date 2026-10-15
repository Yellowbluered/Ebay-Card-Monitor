# -*- coding: utf-8 -*-
"""
ebay_sold_scraper.py — 模組 C：本機 eBay 成交價爬蟲（$0 成本、免被封鎖設計）
============================================================================
預設以 Playwright 無頭 Chromium 真實渲染 eBay 歷史成交頁後抓取資料：

    https://www.ebay.com/sch/i.html?_nkw={卡牌特徵關鍵字}&LH_Sold=1&LH_Complete=1

安全防護：
  * 以真實 Chromium 執行 JS 並帶上完整瀏覽器指紋（stealth 修補）。
  * 先造訪市集首頁累積 cookie，再翻成交頁（降低 403 / 登入牆機率）。
  * 連續請求間加入隨機延遲（預設 2~4 秒，可設定）。

後端切換（SCRAPER_BACKEND）：
  * playwright（預設）：無頭 Chromium 渲染，繞過純 HTTP 反爬。
  * curl_cffi（備援）：模擬 Chrome TLS/JA3 指紋。
  * requests（備援）：純 requests，不帶 TLS 指紋模擬。
  * external（選填）：改用外部 Scraper API（需一併設定 EXTERNAL_SCRAPER_URL）。

注意：eBay 對 Sold 頁的反爬很嚴格，即使 Playwright 渲染，
      若 IP 已被列入黑名單仍可能被擋，請配合住宅 Proxy 或更換網路。
"""

from __future__ import annotations

import random
import re
import threading
import time
from typing import List, Optional
from urllib.parse import quote_plus

import requests
from bs4 import BeautifulSoup

try:
    from curl_cffi import requests as _curl_requests
except ImportError as _exc:  # 未安裝 curl_cffi 時，仍可使用 requests / external 後端
    _curl_requests = None
    _CURL_CFFI_IMPORT_ERROR = str(_exc)
else:
    _CURL_CFFI_IMPORT_ERROR = ""

try:
    from playwright.sync_api import sync_playwright
except ImportError as _exc:  # 未安裝 playwright 時，仍可使用其他後端
    sync_playwright = None
    _PLAYWRIGHT_IMPORT_ERROR = str(_exc)
else:
    _PLAYWRIGHT_IMPORT_ERROR = ""

try:
    from playwright_stealth import stealth_sync  # 原版 playwright-stealth API
except ImportError:  # playwright-stealth 為選填，缺漏時退回內建 _STEALTH_JS 修補
    stealth_sync = None

try:
    from playwright_stealth import Stealth  # 分叉版 playwright-stealth API
except ImportError:
    Stealth = None


def _apply_stealth(page) -> None:
    """以 playwright-stealth 抹除 navigator.webdriver 等自動化指紋。

    相容兩種常見 API：
      * 原版 playwright-stealth：stealth_sync(page)
      * 分叉版：Stealth().apply_stealth_sync(page)
    兩者皆不可用時為 no-op（此時仍仰賴 _STEALTH_JS init script 的內建修補）。
    """
    if stealth_sync is not None:
        stealth_sync(page)
    elif Stealth is not None:
        Stealth().apply_stealth_sync(page)

from models import (
    SoldRecord,
    clean_item_url,
    currency_for_marketplace,
    domain_for_marketplace,
    extract_item_id,
    parse_price,
)

# 真實 Chrome User-Agent
REAL_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

BASE_HEADERS = {
    "User-Agent": REAL_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,"
              "image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.ebay.com/",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}

# curl_cffi 後端只補它不會自動產生的「導覽」headers。
# User-Agent / Sec-Ch-Ua / Accept / Accept-Language / Priority 等交由
# impersonate 自動帶入，避免 UA 版本與 TLS 指紋不一致反而被識破。
CURL_CFFI_HEADERS = {
    "Referer": "https://www.ebay.com/",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}

# eBay 以 HTTP 200 回傳的軟性阻擋頁特徵（登入牆 / 驗證頁）。
_BLOCK_MARKERS = (
    "pardon our interruption",
    "access denied",
    "robot check",
    "verify you are a human",
    "sign in or register",
    "security check",
)

# ---- Playwright 反偵測 ----------------------------------------------------

# 每個新頁面載入前注入的指紋修補（對齊原 Node 版 ebayPlaywright.js 的 STEALTH_INIT）。
_STEALTH_JS = """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true });
Object.defineProperty(navigator, 'plugins', { get: () => [
    { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
], configurable: true });
if (!window.chrome) { Object.defineProperty(window, 'chrome', { value: {}, configurable: true }); }
if (!window.chrome.runtime) { window.chrome.runtime = {}; }
const pp = window.Permissions && window.Permissions.prototype;
if (pp && pp.query) {
    const oq = pp.query;
    pp.query = function (p) { if (p && p.name === 'notifications') { return Promise.resolve({ state: 'default', onchange: null }); } return oq.call(this, p); };
}
const gp = window.WebGLRenderingContext && window.WebGLRenderingContext.prototype;
if (gp && gp.getParameter) {
    const ogp = gp.getParameter;
    gp.getParameter = function (p) {
        if (p === 37445) { return 'Intel Inc.'; }
        if (p === 37446) { return 'Intel Iris OpenGL Engine'; }
        return ogp.call(this, p);
    };
}
"""

_PW_LAUNCH_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--disable-notifications",
    "--window-size=1440,900",
    "--lang=en-US,en",
]

_PW_CONTEXT_OPTIONS = {
    "user_agent": REAL_UA,
    "viewport": {"width": 1440, "height": 900},
    "screen": {"width": 1440, "height": 900},
    "device_scale_factor": 1,
    "is_mobile": False,
    "has_touch": False,
    "locale": "en-US",
    "timezone_id": "America/New_York",
    "color_scheme": "light",
    "java_script_enabled": True,
    "bypass_csp": True,
    "extra_http_headers": {
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,"
                  "image/avif,image/webp,image/apng,*/*;q=0.8",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
    },
}

_PW_NAV_TIMEOUT_MS = 60_000
_PW_DEFAULT_TIMEOUT_MS = 45_000


class ScraperBlockedError(Exception):
    """被 eBay 反爬阻擋時丟出。"""


class _ExternalProviderError(Exception):
    """外部 Scraper 單一 provider 呼叫失敗（額度耗盡 / 429 / 403 / 阻擋頁 / 網路錯誤）。

    由 _fetch_external 捕捉，作為「容錯切換（failover）」的訊號；不直接對外拋出。
    """


class ExternalQuotaExhaustedError(ScraperBlockedError):
    """兩家外部 Sold API（ScrapingDog / SerpApi）額度皆耗盡或請求皆失敗。

    與一般 ScraperBlockedError 不同，此錯誤表示「已售成交數據來源已用罄」，
    呼叫端（price_engine）可據此降級改用 eBay Browse API 查「在售」參考價。
    """


# 熔斷狀態：兩家外部 Sold API 額度皆耗盡時設為 True（跨執行緒共用，以鎖保護）。
_quota_exhausted = False
_quota_exhausted_lock = threading.Lock()


def set_quota_exhausted(value: bool) -> None:
    """設定熔斷旗標（額度耗盡時設 True）。"""
    global _quota_exhausted
    with _quota_exhausted_lock:
        _quota_exhausted = value


def is_quota_exhausted() -> bool:
    """查詢熔斷旗標：兩家外部 Sold API 是否皆已額度耗盡。"""
    with _quota_exhausted_lock:
        return _quota_exhausted


def reset_quota_exhausted() -> None:
    """解除熔斷（補充額度後呼叫，或由 /reset_quota 指令觸發）。"""
    set_quota_exhausted(False)


# 外部 Scraper 雙 API 輪替（round-robin）狀態：放在模組層級，跨 scraper 實例維持，
# 讓「每筆查詢」在 ScrapingDog 與 SerpApi 之間交替起始。以鎖保護避免多執行緒競爭。
_EXTERNAL_PROVIDERS = ("scrapingdog", "serpapi")
_external_rr_lock = threading.Lock()
_external_rr_count = 0


class EbaySoldScraper:
    """成交價爬蟲（可切換 playwright / curl_cffi / requests / 外部 Scraper 後端）。"""

    def __init__(self, settings):
        self.settings = settings
        self._requests_session = requests.Session()
        self._requests_session.headers.update(BASE_HEADERS)
        self._curl_session = None
        self._last_request_at = 0.0
        self._warmed_up = False
        if (self.settings.scraper_backend or "playwright").lower() == "curl_cffi":
            self._init_curl_session()

    def _init_curl_session(self) -> None:
        if _curl_requests is None:
            hint = (
                "SCRAPER_BACKEND=curl_cffi 但無法載入 curl_cffi。"
                "請執行：pip install curl_cffi（需 Python 3.10+）。"
            )
            if _CURL_CFFI_IMPORT_ERROR:
                hint += f" 原始錯誤：{_CURL_CFFI_IMPORT_ERROR}"
            raise ScraperBlockedError(hint)
        self._curl_session = _curl_requests.Session(
            impersonate=self.settings.scraper_impersonate
        )
        self._curl_session.headers.update(CURL_CFFI_HEADERS)

    def _warmup(self) -> None:
        """先造訪市集首頁累積 cookie，降低 Akamai 403 機率（curl_cffi 後端）。"""
        if self._warmed_up or self._curl_session is None:
            return
        self._warmed_up = True
        try:
            home = f"https://{domain_for_marketplace(self.settings.marketplace)}/"
            self._curl_session.get(home, timeout=30, proxies=self._proxies())
        except Exception:
            pass  # 暖身失敗不影響主流程（best-effort）

    # ---- 安全防護 --------------------------------------------------------

    def _proxies(self) -> Optional[dict]:
        if self.settings.scraper_use_proxy and self.settings.scraper_proxy_url:
            return {
                "http": self.settings.scraper_proxy_url,
                "https": self.settings.scraper_proxy_url,
            }
        return None

    def _random_delay(self) -> float:
        return random.uniform(self.settings.scraper_delay_min,
                              self.settings.scraper_delay_max)

    def _respect_rate_limit(self) -> None:
        """確保兩次請求之間至少間隔一段隨機延遲（避免觸發限流）。"""
        wait = self._random_delay()
        elapsed = time.time() - self._last_request_at
        if elapsed < wait:
            time.sleep(wait - elapsed)
        self._last_request_at = time.time()

    def _sleep_between_pages(self) -> None:
        time.sleep(self._random_delay())

    # ---- 網址組裝 --------------------------------------------------------

    def build_url(self, query: str, page: int = 1) -> str:
        domain = domain_for_marketplace(self.settings.marketplace)
        return (
            f"https://{domain}/sch/i.html?_nkw={quote_plus(query)}"
            f"&_sacat=0&_ipg=240&_pgn={page}&LH_Sold=1&LH_Complete=1&rt=nc"
        )

    # ---- 主流程 ----------------------------------------------------------

    def fetch_sold(self, query: str, pages: Optional[int] = None) -> List[SoldRecord]:
        """抓取某關鍵字的歷史成交紀錄。"""
        pages = pages or self.settings.scraper_pages
        backend = (self.settings.scraper_backend or "playwright").lower()

        if backend == "external":
            return self._fetch_external(query, pages)
        if backend == "playwright":
            return self._fetch_sold_playwright(query, pages)

        records: List[SoldRecord] = []
        for page in range(1, pages + 1):
            url = self.build_url(query, page)
            html = self._get(url)
            page_records = self._parse_html(html, url)
            if not page_records:
                break
            records.extend(page_records)
            if page < pages:
                self._sleep_between_pages()

        return self._dedupe(records)

    # ---- Playwright 後端（預設） ------------------------------------------

    def _require_playwright(self) -> None:
        if sync_playwright is None:
            hint = (
                "SCRAPER_BACKEND=playwright 但未安裝 playwright。請執行：\n"
                "  pip install playwright\n"
                "  playwright install chromium\n"
                "本機已安裝 Chrome / Edge 時，可改在 .env 設 SCRAPER_BROWSER_CHANNEL=chrome "
                "免下載 Chromium。"
            )
            if _PLAYWRIGHT_IMPORT_ERROR:
                hint += f"\n原始錯誤：{_PLAYWRIGHT_IMPORT_ERROR}"
            raise ScraperBlockedError(hint)

    @staticmethod
    def _scroll_to_bottom(page) -> None:
        """向下捲動頁面，觸發 lazy-load（eBay 部分卡片需捲動才載入）。"""
        try:
            page.evaluate(
                "async () => {"
                "  const step = window.innerHeight;"
                "  for (let y = 0; y < document.body.scrollHeight; y += step) {"
                "    window.scrollTo(0, y);"
                "    await new Promise((r) => setTimeout(r, 120));"
                "  }"
                "  window.scrollTo(0, 0);"
                "}"
            )
        except Exception:
            pass

    def _settle_akamai(self, page, title: str) -> str:
        """Akamai「Pardon Our Interruption」挑戰常會跑 JS 後自動跳轉，等待其解決。

        若挑戰頁在數秒內自行跳回真正的 eBay 內容，回傳新標題；否則回傳原標題。
        """
        if not self._looks_blocked(title):
            return title
        for _ in range(12):  # 最多再等 12 秒
            time.sleep(1.0)
            try:
                current = page.title()
            except Exception:
                continue
            if not self._looks_blocked(current):
                return current
        return title

    def _render_pages(self, urls: List[str],
                      warmup_home: Optional[str] = None) -> List[dict]:
        """以 Playwright 無頭 Chromium 渲染多個 URL。

        回傳 [{"url", "html", "status", "title"}]；瀏覽器在 finally 中關閉。
        """
        self._require_playwright()
        results: List[dict] = []
        pw = sync_playwright().start()
        browser = None
        context = None
        try:
            launch_kwargs = {
                "headless": self.settings.scraper_headless,
                "args": list(_PW_LAUNCH_ARGS),
            }
            if self.settings.scraper_browser_channel:
                launch_kwargs["channel"] = self.settings.scraper_browser_channel
            try:
                browser = pw.chromium.launch(**launch_kwargs)
            except Exception as exc:
                raise ScraperBlockedError(
                    "Playwright 無法啟動瀏覽器。請執行：playwright install chromium，"
                    "或於 .env 設 SCRAPER_BROWSER_CHANNEL=chrome 使用本機已安裝的 Chrome。"
                    f" 原始錯誤：{exc}"
                ) from exc

            context_options = dict(_PW_CONTEXT_OPTIONS)
            if self.settings.scraper_use_proxy and self.settings.scraper_proxy_url:
                context_options["proxy"] = {"server": self.settings.scraper_proxy_url}
            context = browser.new_context(**context_options)
            context.add_init_script(_STEALTH_JS)
            page = context.new_page()
            page.set_default_timeout(_PW_DEFAULT_TIMEOUT_MS)
            page.set_default_navigation_timeout(_PW_NAV_TIMEOUT_MS)

            # 套用 playwright-stealth 抹除 navigator.webdriver 等自動化指紋。
            # 與上方 context.add_init_script(_STEALTH_JS) 互補；補丁失敗時仍以 _STEALTH_JS 兜底。
            try:
                _apply_stealth(page)
            except Exception:
                pass

            # 暖身：先造訪首頁累積 cookie
            if warmup_home:
                self._respect_rate_limit()
                try:
                    page.goto(warmup_home, wait_until="domcontentloaded",
                              timeout=_PW_NAV_TIMEOUT_MS)
                except Exception:
                    pass
                time.sleep(self._random_delay())

            for url in urls:
                self._respect_rate_limit()
                status = 0
                try:
                    resp = page.goto(url, wait_until="domcontentloaded",
                                     timeout=_PW_NAV_TIMEOUT_MS)
                    status = resp.status if resp else 0
                except Exception:
                    status = 0
                try:
                    page.wait_for_selector("li.s-item, .s-item", state="attached",
                                           timeout=20_000)
                except Exception:
                    pass
                self._scroll_to_bottom(page)
                title = ""
                try:
                    title = page.title()
                except Exception:
                    pass
                title = self._settle_akamai(page, title)
                html = page.content()
                results.append({"url": url, "html": html, "status": status, "title": title})
        finally:
            if context is not None:
                try:
                    context.close()
                except Exception:
                    pass
            if browser is not None:
                try:
                    browser.close()
                except Exception:
                    pass
            try:
                pw.stop()
            except Exception:
                pass
        return results

    def _fetch_sold_playwright(self, query: str, pages: int) -> List[SoldRecord]:
        home = f"https://{domain_for_marketplace(self.settings.marketplace)}/"
        urls = [self.build_url(query, page) for page in range(1, pages + 1)]
        records: List[SoldRecord] = []
        for rendered in self._render_pages(urls, warmup_home=home):
            if (rendered["status"] in (403, 429)
                    or self._looks_blocked(rendered["html"])
                    or self._looks_blocked(rendered["title"])):
                raise ScraperBlockedError(
                    f"被 eBay 反爬阻擋（HTTP {rendered['status']}，"
                    f"title={rendered['title']!r}）。"
                    "Playwright 渲染仍被擋，通常是 IP 已被列入黑名單；"
                    "請更換網路，或設定住宅 Proxy（SCRAPER_PROXY_URL + SCRAPER_USE_PROXY=1）。"
                )
            page_records = self._parse_html(rendered["html"], rendered["url"])
            if not page_records:
                break
            records.extend(page_records)
        return self._dedupe(records)

    def _session_get(self, url: str):
        if self._curl_session is not None:
            return self._curl_session.get(url, timeout=30, proxies=self._proxies())
        return self._requests_session.get(url, timeout=30, proxies=self._proxies())

    @staticmethod
    def _looks_blocked(html: str) -> bool:
        """偵測 eBay 以 200 回傳的軟性阻擋頁（登入牆 / 驗證頁）。"""
        lower = html.lower()
        return any(marker in lower for marker in _BLOCK_MARKERS)

    def _get(self, url: str) -> str:
        self._respect_rate_limit()
        self._warmup()
        try:
            resp = self._session_get(url)
        except Exception as exc:  # 網路層錯誤（requests / curl_cffi）一律轉成 ScraperBlockedError
            raise ScraperBlockedError(f"成交頁請求失敗：{exc}") from exc

        if resp.status_code in (403, 429) or self._looks_blocked(resp.text):
            raise ScraperBlockedError(
                f"被 eBay 反爬阻擋（HTTP {resp.status_code}，疑似登入牆/驗證頁）。"
                "建議改用 curl_cffi 後端（SCRAPER_BACKEND=curl_cffi），"
                "或改用外部 Scraper（SCRAPER_BACKEND=external + EXTERNAL_SCRAPER_URL）。"
            )
        resp.raise_for_status()
        return resp.text

    @staticmethod
    def _dedupe(records: List[SoldRecord]) -> List[SoldRecord]:
        seen = set()
        out: List[SoldRecord] = []
        for rec in records:
            key = rec.item_id or rec.url
            if key and key in seen:
                continue
            if key:
                seen.add(key)
            out.append(rec)
        return out


    # ---- HTML 解析 --------------------------------------------------------

    def _parse_html(self, html: str, page_url: str = "") -> List[SoldRecord]:
        soup = BeautifulSoup(html, "html.parser")
        currency_default = currency_for_marketplace(self.settings.marketplace)
        out: List[SoldRecord] = []

        for li in soup.select("li.s-item"):
            title_el = li.select_one(".s-item__title")
            title = title_el.get_text(" ", strip=True) if title_el else ""
            if not title or title.lower().startswith("shop on ebay"):
                continue

            price_el = li.select_one(".s-item__price")
            price_text = price_el.get_text(" ", strip=True) if price_el else ""

            link = li.select_one("a.s-item__link")
            href = link.get("href") if link else ""

            # 成交日期（eBay 會顯示 "Sold Oct 12, 2024" 之類文字）
            sold_date = None
            for sel in (".s-item__title--tag", ".s-item__caption",
                        ".s-item__endedDate", ".s-item__subtitle"):
                el = li.select_one(sel)
                if not el:
                    continue
                text = el.get_text(" ", strip=True)
                m = re.search(
                    r"(?:sold|ended)[^\d]{0,12}"
                    r"(\d{1,2}\s+[a-z]{3,9}\.?\s+\d{4}|[a-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})",
                    text,
                    re.IGNORECASE,
                )
                if m:
                    sold_date = m.group(1)
                    break

            ship_el = li.select_one(".s-item__shipping, .s-item__logisticsCost")
            shipping_text = ship_el.get_text(" ", strip=True) if ship_el else ""

            parsed = parse_price(price_text)
            if parsed.value is None:
                continue
            shipping = parse_price(shipping_text).value

            out.append(SoldRecord(
                item_id=extract_item_id(href),
                title=title,
                price=parsed.value,
                currency=parsed.currency or currency_default,
                shipping=shipping,
                sold_date=sold_date,
                url=clean_item_url(href),
                source="scrape",
            ))
        return out

    # ---- 外部 Scraper 後端（ScrapingDog / SerpApi 雙 API）------------------

    def _fetch_external(self, query: str, pages: int) -> List[SoldRecord]:
        """外部 Scraper 後端：ScrapingDog / SerpApi 雙 API 輪替 + 容錯切換。

        輪替（round-robin）：模組層級計數器確保每筆查詢在兩家之間交替起始。
        容錯（failover）：額度耗盡 / HTTP 429/403 / 阻擋頁 / 請求失敗 / 回傳 0 筆（解析失敗）時，
                          自動無縫切到另一家重試同一筆查詢。
        最後兜底：若兩家皆失敗且設定了 EXTERNAL_SCRAPER_URL，改用通用外部 Scraper。
        """
        global _external_rr_count
        with _external_rr_lock:
            start = _external_rr_count % 2
            _external_rr_count += 1

        # 依輪替計數器決定起始 provider，並只保留「已設定 key」的 provider
        names = [n for n in _EXTERNAL_PROVIDERS if self._external_provider_enabled(n)]
        if start == 1:
            names.reverse()

        last_error: Optional[Exception] = None
        for name in names:
            try:
                records = self._fetch_provider(name, query, pages)
                if not records:
                    # 0 筆成交紀錄（可能被解析失敗或軟性阻擋頁包裝成空結果）
                    # 也視為失敗，無縫切到下一家重試同一筆查詢。
                    last_error = _ExternalProviderError(
                        f"{name} 回傳 0 筆成交紀錄（解析失敗或查無結果）。"
                    )
                    continue
                return self._dedupe(records)
            except _ExternalProviderError as exc:
                last_error = exc
                continue

        # 通用 EXTERNAL_SCRAPER_URL 兜底（選填，保留向後相容）
        if self.settings.external_scraper_url:
            try:
                return self._dedupe(self._fetch_generic_external(query, pages))
            except _ExternalProviderError as exc:
                last_error = exc

        if not names:
            raise ScraperBlockedError(
                "SCRAPER_BACKEND=external 但未設定 SCRAPINGDOG_API_KEY 或 SERPAPI_API_KEY"
                "（或 EXTERNAL_SCRAPER_URL）。"
            )
        # 兩家皆耗盡 / 失敗：設下熔斷旗標（供主動監控暫停與降級判斷），
        # 並以專屬例外拋出，讓 price_engine 據此降級到 Browse API 在售查價。
        set_quota_exhausted(True)
        raise ExternalQuotaExhaustedError(
            f"外部 Scraper（ScrapingDog / SerpApi）皆額度耗盡或請求失敗：{last_error}"
        )

    def _external_provider_enabled(self, name: str) -> bool:
        """判斷 provider 是否已設定對應的 API key。"""
        if name == "scrapingdog":
            return bool(self.settings.scrapingdog_api_key)
        if name == "serpapi":
            return bool(self.settings.serpapi_api_key)
        return False

    def _fetch_provider(self, name: str, query: str, pages: int) -> List[SoldRecord]:
        """依 provider 名稱分派到對應的抓取實作。"""
        if name == "scrapingdog":
            return self._fetch_scrapingdog(query, pages)
        if name == "serpapi":
            return self._fetch_serpapi(query, pages)
        raise _ExternalProviderError(f"未知外部 provider：{name}")

    # ---- ScrapingDog -----------------------------------------------------

    def _fetch_scrapingdog(self, query: str, pages: int) -> List[SoldRecord]:
        """透過 ScrapingDog 通用 scrape 端點抓取 eBay 成交頁 HTML，再以本機 parser 解析。

        失敗（額度耗盡 / 429 / 403 / 阻擋頁 / 網路錯誤）以 _ExternalProviderError 拋出，
        交由 _fetch_external 切換至另一家。
        """
        records: List[SoldRecord] = []
        for page in range(1, pages + 1):
            url = self.build_url(query, page)
            try:
                resp = requests.get(
                    "https://api.scrapingdog.com/scrape",
                    params={"api_key": self.settings.scrapingdog_api_key, "url": url},
                    timeout=60,
                )
            except requests.RequestException as exc:
                raise _ExternalProviderError(f"ScrapingDog 請求失敗：{exc}") from exc

            ctype = (resp.headers.get("Content-Type") or "").lower()
            if resp.status_code in (401, 402, 403, 429) or "json" in ctype or resp.status_code >= 400:
                try:
                    payload = resp.json()
                except ValueError:
                    payload = {}
                raise _ExternalProviderError(
                    f"ScrapingDog 失敗（HTTP {resp.status_code}）："
                    f"{payload.get('message') or payload.get('error') or resp.text[:200]}"
                )

            html = resp.text
            if self._looks_blocked(html):
                raise _ExternalProviderError("ScrapingDog 回傳 eBay 阻擋頁（登入牆/驗證頁）")

            page_records = self._parse_html(html, url)
            if not page_records:
                break
            records.extend(page_records)
            if page < pages:
                self._sleep_between_pages()
        return records

    # ---- SerpApi ---------------------------------------------------------

    def _fetch_serpapi(self, query: str, pages: int) -> List[SoldRecord]:
        """透過 SerpApi 的 eBay engine 抓取成交紀錄（結構化 JSON）。

        失敗（額度耗盡 / 429 / 403 / error 回應 / 網路錯誤）以 _ExternalProviderError 拋出。
        """
        records: List[SoldRecord] = []
        for page in range(1, pages + 1):
            params = {
                "engine": "ebay",
                "_nkw": query,
                "_pgn": str(page),
                "LH_Sold": "1",
                "LH_Complete": "1",
                "api_key": self.settings.serpapi_api_key,
            }
            try:
                resp = requests.get("https://serpapi.com/search.json",
                                    params=params, timeout=60)
            except requests.RequestException as exc:
                raise _ExternalProviderError(f"SerpApi 請求失敗：{exc}") from exc

            if resp.status_code in (401, 402, 403, 429) or resp.status_code >= 400:
                raise _ExternalProviderError(
                    f"SerpApi 失敗（HTTP {resp.status_code}）：{resp.text[:200]}"
                )

            try:
                data = resp.json()
            except ValueError as exc:
                raise _ExternalProviderError(f"SerpApi 回應非 JSON：{exc}") from exc

            if data.get("error"):
                raise _ExternalProviderError(f"SerpApi 錯誤：{data.get('error')}")

            page_records = self._parse_serpapi(data)
            if not page_records:
                break
            records.extend(page_records)
            if page < pages:
                self._sleep_between_pages()
        return records

    def _parse_serpapi(self, data: dict) -> List[SoldRecord]:
        """把 SerpApi eBay engine 的 organic_results 轉成 SoldRecord。"""
        currency_default = currency_for_marketplace(self.settings.marketplace)
        out: List[SoldRecord] = []
        for item in data.get("organic_results", []):
            title = str(item.get("title") or "").strip()
            if not title:
                continue
            link = item.get("link") or ""

            # price 可能是 dict（{"raw": "$1,234.56", "extracted": 1234.56}）或字串
            price_raw = item.get("price")
            if isinstance(price_raw, dict):
                extracted = price_raw.get("extracted")
                price_text = str(price_raw.get("raw") or price_raw.get("value") or "")
            else:
                extracted = None
                price_text = str(price_raw or "")
            parsed = parse_price(price_text)
            price = extracted if extracted is not None else parsed.value
            if price is None:
                continue

            ship_raw = item.get("shipping")
            if isinstance(ship_raw, dict):
                ship_text = str(ship_raw.get("raw") or ship_raw.get("value") or "")
            else:
                ship_text = str(ship_raw or "")
            shipping = parse_price(ship_text).value

            sold_date = item.get("sold_date") or item.get("ended_date")

            out.append(SoldRecord(
                item_id=extract_item_id(link),
                title=title,
                price=float(price),
                currency=parsed.currency or currency_default,
                shipping=shipping,
                sold_date=str(sold_date) if sold_date else None,
                url=clean_item_url(link),
                source="serpapi",
            ))
        return out

    # ---- 通用外部 Scraper（EXTERNAL_SCRAPER_URL，選填兜底）----------------

    def _fetch_generic_external(self, query: str, pages: int) -> List[SoldRecord]:
        """呼叫通用外部 Scraper API。

        約定：POST {EXTERNAL_SCRAPER_URL}，body {"query":..., "pages":..., "sold":true}
        回應：{"items": [{"item_id","title","price","currency","shipping","sold_date","url"}]}
        """
        try:
            resp = requests.post(
                self.settings.external_scraper_url,
                json={"query": query, "pages": pages, "sold": True},
                timeout=60,
            )
            resp.raise_for_status()
            data = resp.json()
        except requests.RequestException as exc:
            raise _ExternalProviderError(f"通用外部 Scraper 失敗：{exc}") from exc

        records: List[SoldRecord] = []
        for item in data.get("items", []):
            try:
                price = float(item.get("price"))
            except (TypeError, ValueError):
                continue
            records.append(SoldRecord(
                item_id=str(item.get("item_id") or "") or None,
                title=str(item.get("title") or ""),
                price=price,
                currency=item.get("currency") or currency_for_marketplace(self.settings.marketplace),
                shipping=item.get("shipping"),
                sold_date=item.get("sold_date"),
                url=clean_item_url(item.get("url") or ""),
                source="external",
            ))
        return records

    # ---- 商品頁（貼網址查價的備援來源） --------------------------------

    def fetch_item_page(self, url: str) -> dict:
        """抓商品頁 meta 標籤，取得標題 / 價格 / 幣別 / 圖片（備援用）。

        優先使用 eBay Browse API 的 get_item()，此方法只在無 API 憑證時當備援，
        且 eBay 商品頁可能被反爬擋下，屬 best-effort。
        """
        if (self.settings.scraper_backend or "playwright").lower() == "playwright":
            rendered = self._render_pages([url])[0]
            if (rendered["status"] in (403, 429)
                    or self._looks_blocked(rendered["html"])
                    or self._looks_blocked(rendered["title"])):
                raise ScraperBlockedError(
                    f"被 eBay 反爬阻擋（HTTP {rendered['status']}）。"
                )
            html = rendered["html"]
        else:
            html = self._get(url)
        soup = BeautifulSoup(html, "html.parser")

        title = ""
        for sel in ('meta[property="og:title"]', "title"):
            el = soup.select_one(sel)
            if el:
                title = el.get("content") if el.has_attr("content") else el.get_text(strip=True)
                if title:
                    break

        price = None
        el = soup.select_one('meta[itemprop="price"]')
        if el and el.get("content"):
            try:
                price = float(el["content"])
            except (TypeError, ValueError):
                price = None

        currency = None
        el = soup.select_one('meta[itemprop="priceCurrency"]')
        if el and el.get("content"):
            currency = el["content"]

        image = ""
        el = soup.select_one('meta[property="og:image"]')
        if el and el.get("content"):
            image = el["content"]

        return {
            "title": title,
            "price": price,
            "currency": currency,
            "image": image,
            "url": clean_item_url(url),
        }

