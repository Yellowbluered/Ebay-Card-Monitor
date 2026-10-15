# -*- coding: utf-8 -*-
"""
discord_bot.py — 模組 A（功能 2）+ 模組 E：Discord 互動與警報
==============================================================
  * 斜線指令 /comp <關鍵字>     → 回傳比價報告
  * 前綴指令 !comp <關鍵字>     → 同上（備援）
  * 貼上 eBay 商品網址           → 自動解析該商品並回傳比價報告
  * 背景輪詢（每 N 小時）        → 主動監控新上架一口價，發現甜甜價即推播 Embed

甜甜價（模組 E）：現價（含運費）<= 歷史中位價 * DISCOUNT_THRESHOLD（預設 0.7）。
同步網路請求（requests）一律丟到 asyncio.to_thread，避免卡住事件迴圈。
"""

from __future__ import annotations

import asyncio
import threading
from datetime import datetime

import discord
from discord import app_commands
from discord.ext import commands, tasks

from card_parser import parse_card_title
from config import load_settings
from ebay_api import EbayBrowseApi
from ebay_sold_scraper import (
    EbaySoldScraper,
    ScraperBlockedError,
    is_quota_exhausted,
    reset_quota_exhausted,
)
from models import (
    Listing,
    clean_item_url,
    currency_for_marketplace,
    extract_item_id,
    sign_for_currency,
)
from price_engine import (
    DEGRADE_WARNING,
    check_cache,
    find_deals,
    get_baseline,
    resolve_item_cache,
    save_item_index,
)
from request_queue import ScraperQueue
from stats import discount_percent

settings = load_settings()
DEFAULT_CURRENCY = currency_for_marketplace(settings.marketplace)
POLL_SECONDS = max(60, int(settings.poll_interval_hours * 3600))

# 非同步請求隊列：一次一個工作，工作間 1~2 秒隨機平滑間隔（防 eBay 限流）
scraper_queue = ScraperQueue(delay_min=1.0, delay_max=2.0)

# 熔斷一次性警告：兩家外部 Sold API 額度皆耗盡時，只在第一次發送提醒
_quota_warned = False
_quota_warn_lock = threading.Lock()


def _take_quota_warn_token() -> bool:
    """回傳 True 表示這是第一次（應發送一次性暫停警告）。"""
    global _quota_warned
    with _quota_warn_lock:
        if _quota_warned:
            return False
        _quota_warned = True
        return True


def _reset_quota_warn() -> None:
    """解除熔斷時一併重置警告旗標。"""
    global _quota_warned
    with _quota_warn_lock:
        _quota_warned = False


def log(msg: str = "") -> None:
    print(f"[{datetime.utcnow().isoformat()}] {msg}", flush=True)


def fmt_money(value, currency: str = DEFAULT_CURRENCY) -> str:
    if value is None:
        return "-"
    return f"{sign_for_currency(currency)}{value:,.2f}"


# ---------------------------------------------------------------------------
# Embed 建構
# ---------------------------------------------------------------------------

def build_deal_embed(features, deal: dict, baseline, currency: str, sample_count: int = 0):
    """甜甜價推播 Embed（模組 E）。"""
    listing = deal["listing"]
    embed = discord.Embed(color=0x2ECC71, title="🟢 甜甜價！低於歷史中位成交價")
    embed.description = f"**{listing.title or '（無標題）'}**"
    embed.add_field(name="卡片全名與評級",
                    value=features.display_name() or listing.title, inline=False)
    embed.add_field(name="當前售價（含運費）",
                    value=fmt_money(deal["total_price"], currency), inline=True)
    embed.add_field(name="歷史中位成交價",
                    value=fmt_money(baseline, currency), inline=True)
    embed.add_field(name="折扣幅度",
                    value=f"低於市價 {deal['discount_pct']:.0f}%"
                          f"（省 {fmt_money(deal['delta'], currency)}）", inline=True)
    embed.add_field(name="參考成交筆數", value=f"{sample_count} 筆", inline=True)
    if listing.url:
        embed.url = listing.url
    if listing.image:
        embed.set_thumbnail(url=listing.image)
    embed.timestamp = discord.utils.utcnow()

    view = None
    if listing.url:
        view = discord.ui.View()
        view.add_item(discord.ui.Button(label="前往 eBay 查看",
                                        url=listing.url, style=discord.ButtonStyle.link))
    return embed, view


def build_report_embed(result: dict, currency: str) -> discord.Embed:
    """/comp 比價報告 Embed。"""
    features = result.get("features")
    baseline = result.get("baseline") or {}
    median = baseline.get("median")
    used = baseline.get("used_count") or 0
    deals = result.get("deals") or []
    degraded = bool(baseline.get("degraded"))

    embed = discord.Embed(title="🔎 卡牌比價報告", color=0x3498DB)
    if degraded:
        embed.add_field(name="⚠️ 已售額度已耗盡",
                        value=DEGRADE_WARNING, inline=False)
    embed.add_field(name="卡片全名與評級",
                    value=(features.display_name() if features else "") or "（無法解析）",
                    inline=False)

    median_label = "在售一口價參考中位數" if degraded else "歷史中位成交價"
    if median:
        embed.add_field(name=median_label, value=fmt_money(median, currency), inline=True)
        embed.add_field(name="參考筆數", value=f"{used} 筆", inline=True)
        embed.add_field(name="目前在售（嚴格吻合）",
                        value=f"{result.get('matched', 0)} 筆", inline=True)
    else:
        embed.add_field(name=median_label, value="樣本不足（無法計算）", inline=True)

    if result.get("error"):
        embed.add_field(name="⚠ 注意", value=result["error"], inline=False)

    if deals:
        lines = []
        for i, d in enumerate(deals[:5], 1):
            line = (f"{i}. **{fmt_money(d['total_price'], currency)}**"
                    f"（低於市價 {d['discount_pct']:.0f}%）")
            if d["listing"].url:
                line += f" — [查看]({d['listing'].url})"
            lines.append(line)
        embed.add_field(name="🍀 甜甜價（7 折或更低）", value="\n".join(lines), inline=False)
    else:
        embed.add_field(name="🍀 甜甜價", value="目前沒有低於門檻的在售商品。", inline=False)

    embed.set_footer(text=f"基準價來源：{baseline.get('source', 'none')}")
    embed.timestamp = discord.utils.utcnow()
    return embed


def build_item_embed(result: dict, currency: str):
    """貼網址查價的單一商品比價 Embed。"""
    listing = result.get("listing")
    features = result.get("features")
    baseline = result.get("baseline") or {}
    median = baseline.get("median")
    is_deal = bool(result.get("is_deal"))
    degraded = bool(baseline.get("degraded"))

    embed = discord.Embed(title="🔎 商品比價報告",
                          color=0x2ECC71 if is_deal else 0x3498DB)
    if degraded:
        embed.add_field(name="⚠️ 已售額度已耗盡",
                        value=DEGRADE_WARNING, inline=False)
    embed.description = f"**{listing.title or '（無標題）'}**"
    embed.add_field(name="卡片全名與評級",
                    value=(features.display_name() if features else "") or listing.title,
                    inline=False)
    embed.add_field(name="當前售價（含運費）",
                    value=fmt_money(listing.total_price or listing.price, currency), inline=True)

    median_label = "在售一口價參考中位數" if degraded else "歷史中位成交價"
    embed.add_field(name=median_label, value=fmt_money(median, currency), inline=True)
    if median:
        embed.add_field(name="折扣幅度",
                        value=f"低於市價 {result.get('discount', 0):.0f}%", inline=True)
    embed.add_field(name="參考筆數",
                    value=f"{baseline.get('used_count', 0)} 筆", inline=True)
    if is_deal:
        embed.add_field(name="結論", value="🍀 甜甜價！低於歷史中位成交價 7 折以下。", inline=False)
    if listing.url:
        embed.url = listing.url
    if listing.image:
        embed.set_thumbnail(url=listing.image)
    embed.timestamp = discord.utils.utcnow()

    view = None
    if listing.url:
        view = discord.ui.View()
        view.add_item(discord.ui.Button(label="前往 eBay 查看",
                                        url=listing.url, style=discord.ButtonStyle.link))
    return embed, view


def build_cached_report_embed(features, baseline: dict, currency: str,
                              stored_title: str = None) -> discord.Embed:
    """「快取命中」回覆 Embed：只回傳本機歷史紀錄，未發任何 eBay 請求。"""
    embed = discord.Embed(title="🔎 比價報告（快取命中）", color=0x9B59B6)
    if stored_title:
        embed.add_field(name="商品標題", value=stored_title, inline=False)
    embed.add_field(name="卡片全名與評級",
                    value=(features.display_name() if features else "") or "（無法解析）",
                    inline=False)
    embed.add_field(name="歷史中位成交價",
                    value=fmt_money(baseline.get("median"), currency), inline=True)
    embed.add_field(name="參考成交筆數",
                    value=f"{baseline.get('used_count', 0)} 筆", inline=True)
    embed.add_field(name="資料來源", value="SQLite 快取（未重新抓取）", inline=False)
    embed.set_footer(text="快取命中，未發送任何 eBay 請求")
    embed.timestamp = discord.utils.utcnow()
    return embed


# ---------------------------------------------------------------------------
# 同步核心（會丟到 asyncio.to_thread 執行）
# ---------------------------------------------------------------------------

def _make_api() -> EbayBrowseApi:
    if not (settings.ebay_client_id and settings.ebay_client_secret):
        return None
    return EbayBrowseApi(settings.ebay_client_id, settings.ebay_client_secret,
                         settings.ebay_env, settings.marketplace)


def query_cache_lookup(query: str) -> Optional[dict]:
    """關鍵字查價的「快取優先」比對：命中回傳 dict，否則 None。

    只做「解析特徵 + 查 SQLite」，不進入隊列、不發 eBay 請求。
    """
    features = parse_card_title(query, settings)
    baseline = check_cache(features, settings)
    if not baseline:
        return None
    return {"features": features, "baseline": baseline, "query": query}


def link_cache_lookup(url: str) -> Optional[dict]:
    """貼網址的「快取優先」比對：由 item_id 直接查 SQLite，零網絡。

    命中回傳 dict（features、baseline、stored_title），否則 None。
    """
    item_id = extract_item_id(url)
    if not item_id:
        return None
    return resolve_item_cache(item_id, settings)


def comp_sync(query: str) -> dict:
    """手動查價：解析 → 取基準價 → 抓在售 → 找甜甜價。"""
    features = parse_card_title(query, settings)
    try:
        baseline = get_baseline(features, settings, log)
    except ScraperBlockedError as exc:
        return {"features": features,
                "baseline": {"source": "error", "median": None, "used_count": 0},
                "deals": [], "matched": 0, "listings": [], "error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        return {"features": features,
                "baseline": {"source": "error", "median": None, "used_count": 0},
                "deals": [], "matched": 0, "listings": [], "error": str(exc)}

    listings = []
    api_err = None
    api = _make_api()
    if api:
        try:
            listings = api.search_all(query, limit=100, pages=1,
                                      buying="fixed", sort="price")["listings"]
        except Exception as exc:  # noqa: BLE001
            api_err = f"無法取得目前在售商品（{exc}）"
    else:
        api_err = "未設定 eBay API，無法取得目前在售價格；以下僅顯示歷史中位成交價。"

    deals, matched = find_deals(features, listings, baseline.get("median"),
                                settings.discount_threshold, settings)
    return {"features": features, "baseline": baseline, "deals": deals,
            "matched": matched, "listings": listings, "error": api_err}


def url_sync(url: str) -> dict:
    """貼網址查價：解析 itemId → 取商品 → 解析特徵 → 取基準價 → 比價。"""
    item_id = extract_item_id(url)
    if not item_id:
        return {"error": "無法從網址解析出 eBay itemId。"}

    listing = None
    api = _make_api()
    if api:
        try:
            listing = api.get_item(item_id)
        except Exception as exc:  # noqa: BLE001
            return {"error": f"查詢商品失敗：{exc}"}
    else:
        try:
            info = EbaySoldScraper(settings).fetch_item_page(url)
        except ScraperBlockedError as exc:
            return {"error": f"抓取商品頁失敗（且未設定 eBay API）：{exc}"}
        if not info.get("title"):
            return {"error": "無法取得商品資訊（建議設定 EBAY_CLIENT_ID/SECRET 走官方 API）。"}
        price = info.get("price") or 0.0
        listing = Listing(item_id=item_id, title=info["title"], price=price,
                          currency=info.get("currency"), shipping=None,
                          total_price=price, url=clean_item_url(url),
                          image=info.get("image"), source="scrape")

    if not listing:
        return {"error": "找不到該商品（可能已下架）。"}

    features = parse_card_title(listing.title, settings)
    try:
        baseline = get_baseline(features, settings, log)
    except Exception as exc:  # noqa: BLE001
        baseline = {"source": "error", "median": None, "used_count": 0}

    # 記下「商品網址 → 卡牌特徵」，下次貼同一網址即可零網絡命中快取
    save_item_index(item_id, features, baseline.get("card_id"), listing.title, settings)

    total = listing.total_price or listing.price
    median = baseline.get("median")
    is_deal = bool(median and total and total <= median * settings.discount_threshold)
    discount = discount_percent(total, median) if median else 0.0

    return {"features": features, "listing": listing, "baseline": baseline,
            "is_deal": is_deal, "discount": discount}


def poll_sync() -> list:
    """主動監控（模組 A 功能 1）：逐關鍵字抓新上架一口價並找甜甜價。

    熔斷保護：兩家外部 Sold API 額度皆耗盡時自動暫停（Pause），
    避免在無成交數據情況下盲目浪費請求。

    回傳 [(keyword, features, deal, baseline), ...] 供非同步端推播。
    """
    api = _make_api()
    if not api:
        log("⚠ 未設定 eBay API，略過主動監控。")
        return []

    if is_quota_exhausted():
        log("⚠ 兩家外部 Sold API 額度均耗盡，主動監控暫停（Pause），略過本輪。")
        return []

    results = []
    for keyword in settings.watch_keywords:
        if is_quota_exhausted():
            log("⚠ 已售額度耗盡，停止本輪主動監控。")
            break
        try:
            features = parse_card_title(keyword, settings)
            baseline = get_baseline(features, settings, log)
            # 降級基準（在售中位數）不適合當撿漏基準 → 略過此關鍵字，不推播
            if baseline.get("degraded"):
                log(f"⚠ 關鍵字「{keyword}」已售額度耗盡（改用降級在售基準），背景監控略過。")
                continue
            listings = api.search_all(keyword, limit=100, pages=1,
                                      buying="fixed", sort="newest")["listings"]
            deals, _ = find_deals(features, listings, baseline.get("median"),
                                  settings.discount_threshold, settings)
            for deal in deals:
                results.append((keyword, features, deal,
                                baseline.get("median"), baseline.get("used_count") or 0))
        except Exception as exc:  # noqa: BLE001
            log(f"⚠ 輪詢「{keyword}」失敗：{exc}")
    return results


# ---------------------------------------------------------------------------
# Bot 與指令
# ---------------------------------------------------------------------------

intents = discord.Intents.default()
intents.message_content = True
bot = commands.Bot(command_prefix="!", intents=intents)

alerted_ids: set = set()


def _find_ebay_url(text: str):
    """從訊息文字中找出 eBay 商品網址。"""
    import re as _re

    m = _re.search(r"https?://[^\s<>\"']*ebay\.[^\s<>\"']*/itm/[^\s<>\"']+", text)
    if not m:
        return None
    url = m.group(0)
    for ch in (")", "]", "}", "。", "，", ".", ",", ";"):
        url = url.rstrip(ch)
    return url


@bot.tree.command(name="comp", description="查詢卡牌比價報告（目前在售 vs 歷史中位成交價）")
@app_commands.describe(query="卡牌關鍵字，例：2024 topps chrome sinner psa 10")
async def comp_command(interaction: discord.Interaction, query: str):
    await interaction.response.defer()
    try:
        # 快取優先：命中 → 直接回傳本機歷史紀錄，不進隊列、不發 eBay 請求
        cached = await asyncio.to_thread(query_cache_lookup, query)
        if cached:
            embed = build_cached_report_embed(cached["features"], cached["baseline"],
                                              DEFAULT_CURRENCY)
            await interaction.followup.send(embed=embed)
            return
        # 未命中 → 排入非同步請求隊列（1~2 秒隨機平滑間隔）
        result = await scraper_queue.submit(comp_sync, query)
    except Exception as exc:  # noqa: BLE001
        await interaction.followup.send(f"❌ 比價失敗：{exc}")
        return
    embed = build_report_embed(result, DEFAULT_CURRENCY)
    await interaction.followup.send(embed=embed)


@bot.tree.command(name="reset_quota", description="解除「已售 API 額度耗盡」的熔斷暫停狀態")
async def reset_quota_command(interaction: discord.Interaction):
    """補充 ScrapingDog / SerpApi 額度後，手動解除主動監控的暫停狀態。"""
    reset_quota_exhausted()
    _reset_quota_warn()
    await interaction.response.send_message(
        "✅ 已解除熔斷暫停，主動監控將於下一個輪詢週期恢復。", ephemeral=True
    )


@bot.event
async def on_message(message: discord.Message):
    if message.author.bot:
        return
    content = message.content or ""

    # 觸發 2：貼上 eBay 商品網址
    url = _find_ebay_url(content)
    if url:
        async with message.channel.typing():
            # 快取優先：由 item_id 直接查 SQLite，命中則零網絡回傳
            cached = await asyncio.to_thread(link_cache_lookup, url)
            if cached:
                embed = build_cached_report_embed(cached["features"], cached["baseline"],
                                                  DEFAULT_CURRENCY, cached.get("stored_title"))
                await message.reply(embed=embed)
                return
            # 未命中 → 排入非同步請求隊列，由爬蟲重新抓取與計算
            try:
                result = await scraper_queue.submit(url_sync, url)
            except Exception as exc:  # noqa: BLE001
                await message.reply(f"❌ 查價失敗：{exc}")
                return
        if result.get("error"):
            await message.reply(f"❌ {result['error']}")
        else:
            embed, view = build_item_embed(result, DEFAULT_CURRENCY)
            await message.reply(embed=embed, view=view)
        return

    # 觸發 1（備援前綴）：!comp <關鍵字>
    if content.startswith("!comp"):
        query = content[5:].strip()
        if not query:
            await message.reply("用法：`!comp <關鍵字>`，例：`!comp 2024 topps chrome sinner psa 10`")
            return
        async with message.channel.typing():
            cached = await asyncio.to_thread(query_cache_lookup, query)
            if cached:
                embed = build_cached_report_embed(cached["features"], cached["baseline"],
                                                  DEFAULT_CURRENCY)
                await message.reply(embed=embed)
                return
            try:
                result = await scraper_queue.submit(comp_sync, query)
            except Exception as exc:  # noqa: BLE001
                await message.reply(f"❌ 比價失敗：{exc}")
                return
        embed = build_report_embed(result, DEFAULT_CURRENCY)
        await message.reply(embed=embed)
        return

    await bot.process_commands(message)


# ---------------------------------------------------------------------------
# 背景輪詢（模組 A 功能 1 + 模組 E 推播）
# ---------------------------------------------------------------------------

async def resolve_alert_channels() -> list:
    channels = []
    for cid in settings.discord_channel_ids:
        try:
            channel = bot.get_channel(int(cid)) or await bot.fetch_channel(int(cid))
        except Exception:  # noqa: BLE001
            channel = None
        if channel:
            channels.append(channel)
        else:
            log(f"⚠ 找不到頻道 {cid}，略過。")
    return channels


@tasks.loop(seconds=POLL_SECONDS)
async def poll_loop():
    results = await asyncio.to_thread(poll_sync)

    # 熔斷保護：兩家外部 Sold API 額度皆耗盡 → 發送一次性警告提醒，並維持暫停
    if is_quota_exhausted() and _take_quota_warn_token():
        channels = await resolve_alert_channels()
        if channels:
            warning = (
                "⚠️ **主動監控已暫停（Pause）**\n"
                "兩家外部 Sold API（ScrapingDog / SerpApi）額度均耗盡，"
                "在無成交數據情況下暫停撿漏推播，避免盲目浪費請求。\n"
                "補充額度後可用 `/reset_quota` 解除暫停。"
            )
            for channel in channels:
                try:
                    await channel.send(warning)
                    log(f"⚠ 已發送額度耗盡暫停警告至頻道 {channel.id}")
                except Exception as exc:  # noqa: BLE001
                    log(f"⚠ 推播警告失敗：{exc}")

    if not results:
        return

    channels = await resolve_alert_channels()
    if not channels:
        log("⚠ 找不到推播頻道，略過推播。")
        return

    for _keyword, features, deal, baseline, used_count in results:
        key = deal["listing"].item_id or deal["listing"].url
        if key and key in alerted_ids:
            continue
        if key:
            alerted_ids.add(key)
        embed, view = build_deal_embed(features, deal, baseline,
                                       DEFAULT_CURRENCY, used_count)
        for channel in channels:
            try:
                await channel.send(embed=embed, view=view)
                log(f"  🔔 推播甜甜價至頻道 {channel.id}：{deal['listing'].title}")
            except Exception as exc:  # noqa: BLE001
                log(f"⚠ 推播失敗：{exc}")

    if len(alerted_ids) > 5000:
        alerted_ids.clear()


@bot.event
async def on_ready():
    log(f"✅ Discord Bot 已上線：{bot.user}")
    scraper_queue.start()
    try:
        synced = await bot.tree.sync()
        log(f"已同步 {len(synced)} 個斜線指令。")
    except Exception as exc:  # noqa: BLE001
        log(f"⚠ 斜線指令同步失敗：{exc}")

    if settings.watch_keywords and settings.discord_channel_ids:
        if not poll_loop.is_running():
            poll_loop.start()
            log(f"⏱ 主動監控每 {settings.poll_interval_hours} 小時執行一次。")
    else:
        log("ℹ 未設定 WATCH_KEYWORDS 或 DISCORD_CHANNEL_ID，略過主動監控。")


def main() -> None:
    if not settings.discord_token:
        log("❌ 未設定 DISCORD_TOKEN。請複製 .env.example 為 .env 並填入 token。")
        return
    bot.run(settings.discord_token)


if __name__ == "__main__":
    main()


