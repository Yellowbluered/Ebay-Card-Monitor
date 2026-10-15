# -*- coding: utf-8 -*-
"""
config.py — 設定載入
====================
負責讀取 .env / 環境變數，並整理成一個可讀性高的 Settings 物件。
不引入 python-dotenv，直接寫一個極簡 .env 解析器（對齊原 Node 版做法）。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import List

# 本檔所在目錄（即 python/ 資料夾）
ROOT_DIR = Path(__file__).resolve().parent
ENV_FILE = ROOT_DIR / ".env"


def parse_env_text(content: str) -> dict:
    """解析 .env 字串內容，支援 KEY=VALUE、# 註解、單/雙引號、行內 # 註解。"""
    out: dict = {}
    for line in content.splitlines():
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        if "=" not in text:
            continue
        key, value = text.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        # 去掉包覆的單/雙引號
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        else:
            # 行內註解（" #" 之後視為註解）
            idx = value.find(" #")
            if idx != -1:
                value = value[:idx].rstrip()
        out[key] = value
    return out


def load_env(path: Path = ENV_FILE) -> dict:
    """載入 .env（已存在的環境變數優先，不會被覆蓋）。"""
    if not path.exists():
        return {}
    try:
        parsed = parse_env_text(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    for key, value in parsed.items():
        if os.environ.get(key, "") == "":
            os.environ[key] = value
    return parsed


# ---- 型別轉換小工具 -------------------------------------------------

def _get(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _get_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return value.strip().lower() in ("1", "true", "yes", "y", "on")


def _get_float(name: str, default: float) -> float:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    try:
        return float(value)
    except ValueError:
        return default


def _get_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _get_list(name: str, default: List[str] | None = None) -> List[str]:
    raw = os.environ.get(name, "")
    if not raw:
        return list(default or [])
    return [s.strip() for s in raw.split(",") if s.strip()]


@dataclass
class Settings:
    """全專案共用設定（對應 .env 內所有可調參數）。"""

    discord_token: str = ""
    discord_channel_ids: List[str] = field(default_factory=list)
    watch_keywords: List[str] = field(default_factory=list)

    ebay_client_id: str = ""
    ebay_client_secret: str = ""
    ebay_env: str = "production"
    marketplace: str = "EBAY_US"

    poll_interval_hours: float = 2.0
    cache_ttl_days: int = 7
    discount_threshold: float = 0.7
    min_sold_samples: int = 3
    iqr_k: float = 1.5

    scraper_backend: str = "playwright"
    scraper_impersonate: str = "chrome124"
    scraper_headless: bool = True
    scraper_browser_channel: str = ""
    external_scraper_url: str = ""
    scrapingdog_api_key: str = ""
    serpapi_api_key: str = ""
    scraper_proxy_url: str = ""
    scraper_use_proxy: bool = False
    scraper_delay_min: float = 2.0
    scraper_delay_max: float = 4.0
    scraper_pages: int = 1

    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"

    db_path: str = ""

    @property
    def resolved_db_path(self) -> Path:
        """回傳 SQLite 檔案的絕對路徑（預設放在 python/ 目錄下）。"""
        if self.db_path:
            return Path(self.db_path)
        return ROOT_DIR / "card_cache.db"


def load_settings(env_file: Path = ENV_FILE) -> Settings:
    """從環境變數 / .env 建立 Settings。"""
    load_env(env_file)
    return Settings(
        discord_token=_get("DISCORD_TOKEN"),
        discord_channel_ids=_get_list("DISCORD_CHANNEL_ID"),
        watch_keywords=_get_list("WATCH_KEYWORDS"),
        ebay_client_id=_get("EBAY_CLIENT_ID"),
        ebay_client_secret=_get("EBAY_CLIENT_SECRET"),
        ebay_env=_get("EBAY_ENV", "production").lower(),
        marketplace=_get("EBAY_MARKETPLACE", "EBAY_US").upper(),
        poll_interval_hours=_get_float("POLL_INTERVAL_HOURS", 2.0),
        cache_ttl_days=_get_int("CACHE_TTL_DAYS", 7),
        discount_threshold=_get_float("DISCOUNT_THRESHOLD", 0.7),
        min_sold_samples=_get_int("MIN_SOLD_SAMPLES", 3),
        iqr_k=_get_float("IQR_K", 1.5),
        scraper_backend=_get("SCRAPER_BACKEND", "playwright").lower(),
        scraper_impersonate=_get("SCRAPER_IMPERSONATE", "chrome124"),
        scraper_headless=_get_bool("SCRAPER_HEADLESS", True),
        scraper_browser_channel=_get("SCRAPER_BROWSER_CHANNEL"),
        external_scraper_url=_get("EXTERNAL_SCRAPER_URL"),
        scrapingdog_api_key=_get("SCRAPINGDOG_API_KEY"),
        serpapi_api_key=_get("SERPAPI_API_KEY"),
        scraper_proxy_url=_get("SCRAPER_PROXY_URL"),
        scraper_use_proxy=_get_bool("SCRAPER_USE_PROXY", False),
        scraper_delay_min=_get_float("SCRAPER_DELAY_MIN", 2.0),
        scraper_delay_max=_get_float("SCRAPER_DELAY_MAX", 4.0),
        scraper_pages=_get_int("SCRAPER_PAGES", 1),
        deepseek_api_key=_get("DEEPSEEK_API_KEY"),
        deepseek_base_url=_get("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
        db_path=_get("DB_PATH"),
    )
