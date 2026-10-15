# eBay 卡牌比價與撿漏機器人（Python 版）

自用的 Discord 卡牌比價與撿漏機器人，重構自原 Node.js 專案。
核心概念：**以「歷史成交價的中位數」當市場基準價**，不再把「在售標價平均」當基準，
避免把限量卡、普卡、不同評級混在一起算平均所造成的價格失真。

## 模組對照

| 模組 | 檔案 | 說明 |
|------|------|------|
| A（雙軌觸發） | `ebay_api.py`、`discord_bot.py`、`main.py` | 功能1：每 2 小時輪詢一口價新上架；功能2：`/comp` 指令 + 貼 eBay 網址 |
| B（SQLite 記憶庫） | `db.py` | 快取歷史成交價；7 天內直接讀本機，不發外部請求 |
| C（成交價爬蟲） | `ebay_sold_scraper.py` | Playwright 無頭 Chromium 渲染抓 `LH_Sold=1&LH_Complete=1`，含 stealth 指紋、首頁暖身、隨機延遲、Proxy/外部 Scraper 介面 |
| D（特徵對齊 + 抗極端值） | `card_parser.py`、`stats.py`、`models.py` | 標題結構化、嚴格比對（/10 絕不混普卡）、中位數 + IQR |
| E（Discord 警報與回覆） | `discord_bot.py` | 甜甜價 Embed 推播、比價報告回覆 |

## 安裝

> 需 **Python 3.9+**（`asyncio.to_thread` 需 3.9；`discord.py 2.x` 需 3.8+）。
> 備援後端 `curl_cffi`（選用）需 Python 3.10+。

```bash
cd python
python -m venv .venv
# Windows：
.venv\Scripts\activate
# macOS / Linux：
source .venv/bin/activate

pip install -r requirements.txt
playwright install chromium   # 下載成交價爬蟲（模組 C）用的無頭 Chromium
cp .env.example .env   # 然後編輯 .env 填入 token / key
```

> Discord Developer Portal 記得開啟 Bot 的 **Message Content Intent**（貼網址 / 前綴指令需要讀取訊息內容）。
> 斜線指令 `/comp` 則需要 Bot 有 `applications.commands` 範圍（一般邀請時預設包含）。

## 設定（.env 重點）

```ini
DISCORD_TOKEN=...                 # 必要
DISCORD_CHANNEL_ID=123,...        # 推播頻道（可多個，逗號分隔）
WATCH_KEYWORDS=2024 topps chrome sinner psa 10,charizard base set psa 10
EBAY_CLIENT_ID=...                # 模組 A 的在售來源（選填，但主動監控與在售比價需要）
EBAY_CLIENT_SECRET=...
POLL_INTERVAL_HOURS=2             # 主動監控間隔
CACHE_TTL_DAYS=7                  # SQLite 快取有效天數
DISCOUNT_THRESHOLD=0.7            # 甜甜價門檻（0.7 = 7 折）
MIN_SOLD_SAMPLES=3                # 至少幾筆成交才計算基準價
```

## 執行

```bash
python main.py            # 啟動 Discord Bot（含輪詢、/comp、貼網址）
python main.py --once     # 不連 Discord，單次執行主動監控並印出甜甜價（測試用）
```

## Discord 使用方式

- **斜線指令**：`/comp 2024 topps chrome sinner psa 10`
- **前綴指令（備援）**：`!comp 2024 topps chrome sinner psa 10`
- **貼網址**：直接把 eBay 商品網址貼到頻道，機器人自動解析並回比價報告。

## 運作流程

```
查詢卡片基準價（模組 B → C → D）
  1. 解析標題特徵 → fingerprint
  2. 查 SQLite baseline_cache：7 天內命中 → 直接回傳（0 外部請求）
  3. 未命中/過期 → 成交價爬蟲（模組 C）抓 LH_Sold=1&LH_Complete=1
  4. 嚴格比對（模組 D）只留「特徵完全吻合」的成交紀錄
  5. IQR 剔除離群值 → 取中位數 → 回存 SQLite（sold_records + baseline_cache）

甜甜價推播（模組 E）
  現價（含運費） <= 歷史中位價 * 0.7 → Discord Embed 推播
```

## 手動查價的限流防護（新增）

- **非同步請求隊列（`request_queue.py`）**：所有「貼網址 / 查價」的爬蟲工作
  一律排入 FIFO 隊列，一次只執行一個，工作間加入 **1~2 秒隨機平滑間隔**，
  避免多位用戶短時間連發觸發 eBay 頻率限制。
- **記憶庫即時比對（快取優先）**：
  - 貼網址：先用 `item_id` 查 SQLite 的 `item_index` + `baseline_cache`，
    若有紀錄且 7 天內未過期 → 直接回傳本機歷史紀錄，**不進隊列、不發任何 eBay 請求**。
  - 查價指令：先查 `baseline_cache`，命中即回傳本機中位價（零爬蟲請求）；
    未命中 / 過期才排入隊列，由爬蟲重新抓取與計算。

## 注意事項

1. **eBay 反爬**：對 `ebay.com/sch` 發純 HTTP 請求可能被 Akamai 擋下（403/429）。
   成交價爬蟲預設以 `playwright` 無頭 Chromium 真實渲染頁面（含 stealth 指紋修補、
   首頁暖身累積 cookie），繞過 403/登入牆；仍被擋時（通常是 IP 被黑名單）可改
   `SCRAPER_BACKEND=curl_cffi`（TLS 指紋）或 `SCRAPER_BACKEND=external` +
   `EXTERNAL_SCRAPER_URL` 走外部 Scraper。
   外部 Scraper 介面約定：POST `{EXTERNAL_SCRAPER_URL}`，body
   `{"query": "...", "pages": N, "sold": true}`；回應
   `{"items": [{"item_id","title","price","currency","shipping","sold_date","url"}]}`。
2. **卡牌解析為啟發式**：`card_parser.py` 的正則解析是「最佳努力」，
   可自行擴充 `KNOWN_SET_PHRASES`、`KNOWN_SET_WORDS`、`PARALLEL_KEYWORDS`。
   若設定 `DEEPSEEK_API_KEY`，會優先使用 DeepSeek JSON 結構化解析（更準）。
3. **嚴格比對防呆**：`strict_match()` 要求身份 token、平行/編號、年份、卡號、
   評級、分數等完全吻合，`/10` 與普卡絕不混為一談；「Base」與「未標示」視為同一普卡。
4. **資料結構**：SQLite 檔預設存於 `python/card_cache.db`，可用 `DB_PATH` 指定。
