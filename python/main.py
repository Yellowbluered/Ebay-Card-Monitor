# -*- coding: utf-8 -*-
"""
main.py — 程式入口
==================
  * 預設：啟動 Discord Bot（含 /comp、貼網址、背景輪詢與甜甜價推播）。
  * --once：不啟動 Discord，單次執行「主動監控」並把甜甜價印到終端（方便測試）。

用法（在 python/ 目錄下）：
  python main.py            # 啟動 Discord Bot
  python main.py --once     # 單次執行主動監控（需在 .env 設定 WATCH_KEYWORDS）
"""

from __future__ import annotations

import sys


def run_once() -> None:
    """單次執行主動監控，把結果印到終端（不連 Discord）。"""
    import discord_bot
    from ebay_sold_scraper import is_quota_exhausted

    if is_quota_exhausted():
        print("⚠️ 兩家外部 Sold API 額度均耗盡，主動監控已暫停（Pause），本次略過。")
        return

    results = discord_bot.poll_sync()
    if not results:
        print("本次沒有符合條件的甜甜價。")
        return

    print(f"共發現 {len(results)} 筆甜甜價：\n")
    for _keyword, features, deal, baseline, used_count in results:
        listing = deal["listing"]
        print("─" * 60)
        print(f"卡片全名與評級 : {features.display_name()}")
        print(f"標題           : {listing.title}")
        print(f"現價（含運費） : {deal['total_price']:.2f} {listing.currency or 'USD'}")
        print(f"歷史中位成交價 : {baseline:.2f}（樣本 {used_count} 筆）")
        print(f"折扣幅度       : 低於市價 {deal['discount_pct']:.0f}%")
        print(f"連結           : {listing.url}")
    print("─" * 60)


def main() -> None:
    if "--once" in sys.argv:
        run_once()
        return

    import discord_bot

    discord_bot.main()


if __name__ == "__main__":
    main()
