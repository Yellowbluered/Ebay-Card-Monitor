# eBay 卡牌價格掃描器（eBay Card Price Scanner）

自動抓取 eBay 上**仍在售（未售出）**的球卡 / 集換式卡牌，算出平均價，
列出所有**價格 ≤ 平均價**的「甜甜價」商品，並印出 **標題、價格、折扣%、商品連結**。

---

## 為什麼有兩種資料來源？

| 模式 | 說明 | 需要憑證 | 穩定性 |
| --- | --- | --- | --- |
| `api`（**推薦**） | eBay 官方 **Browse API** | 需要 Client ID / Secret | ★★★★★ 官方授權，不會被擋 |
| `scrape`（備用） | 模擬真實瀏覽器，可選 **Playwright**（預設）或 **Puppeteer + stealth** | 免憑證 | ★★☆ 可能被 Akamai 擋 |

> ⚠️ **重點**：直接對 `https://www.ebay.com/sch/i.html` 發普通 HTTP 請求會拿到 **HTTP 403**（Akamai 反爬）。
> 所以本專案主方案改用官方 API；備用方案改用真的 Headless Chrome 執行 JS + 完整瀏覽器指紋。

`--source auto`（預設）會自動判斷：**`.env` 有憑證就走 API，否則走爬蟲**。
爬蟲預設引擎是 **Playwright**；想換驅動可加 `--engine puppeteer`。
兩種引擎共用同一套解析邏輯（`src/index.js` 第 7 區塊），所以過濾與統計行為完全一致。

---

## 快速開始（3 步）

```bash
# 1. 安裝（API 模式其實不需要任何套件；這步是為了爬蟲備用方案）
npm install
# 不想下載瀏覽器（Playwright / Puppeteer 各約數百 MB）可只裝核心：
#   npm install --omit=optional

# 2. 複製環境設定檔並填入憑證
copy .env.example .env

# 3. 先跑離線示範，確認程式正常
run.cmd --demo
```

正式查價：

```bash
run.cmd "charizard base set psa 10"
```

> macOS / Linux：把 `run.cmd` 換成 `node src/index.js`。

---

## 如何申請 eBay Client ID / Secret（免費，約 5 分鐘）

1. 到 **https://developer.ebay.com/** → 右上角 **Sign in**，用你的 eBay 帳號登入（沒有的話先註冊一個普通買家帳號即可）。
2. 進入 **My Account → Application Keys**（或直接開 https://developer.ebay.com/my/keys）。
3. 第一次會要你建立 **Keyset**：
   - **Sandbox Keyset**：立即可用，用來測試（回傳假資料）。
   - **Production Keyset**：按 **Create a new keyset**，填寫用途（例如「查詢集換式卡牌售價」），送出後**通常即刻開通**。
4. 每個 Keyset 都有三組值，本程式只需要前兩組：
   - **App ID (Client ID)** → 填入 `EBAY_CLIENT_ID`
   - **Cert ID (Client Secret)** → 填入 `EBAY_CLIENT_SECRET`
   - **Dev ID**：本程式不需要。
5. 貼進 `.env`：

```env
EBAY_CLIENT_ID=你的AppID-xxxxxxxx-xxxx
EBAY_CLIENT_SECRET=你的CertID-xxxxxxxx-xxxx
EBAY_ENV=production
EBAY_MARKETPLACE=EBAY_US
EBAY_CURRENCY=            # 留空 = 自動採用結果中佔多數的幣別（建議）
```

6. 驗證憑證：

```bash
run.cmd "pokemon charizard" --limit 10 --top 5
```

### 關於 API 額度
- Browse API 採 **client_credentials**（應用授權），免費額度約 **每天 5,000 次呼叫**（預設 1,000，可於 Application Growth Check 申請提高）。
- 本程式 `--limit 200 --pages 1` 只消耗 **1 次呼叫**，非常省。
- 認證 token 有效期 2 小時，程式會自動快取與重用。
- 想要假資料測試流程可設 `EBAY_ENV=sandbox`。

---

## 使用範例

```bash
# 基本：查 Charizard PSA 10，列出低於平均價的
run.cmd "charizard base set psa 10"

# 只看「低於平均價 15% 以上」的，最多列 10 筆
run.cmd "michael jordan psa 10" --min-discount 15 --top 10

# 香港市場 + 港幣，抓 3 批（最多 600 筆，3 次 API 呼叫）
run.cmd "luffy psa 10" --marketplace EBAY_HK --currency HKD --pages 3

# 想用中位數當基準（價格分布很極端時更穩）
run.cmd "one piece op01-001 psa 10" --baseline median

# 濾掉散卡與整箱：只要 $50 ~ $3000 之間
run.cmd "lebron james rookie psa 9" --min-price 50 --max-price 3000

# 匯出 CSV（Excel 可直接開，含 BOM 不會亂碼）
run.cmd "charizard psa 10" --out reports/charizard.csv

# 輸出 JSON 給其他程式接
run.cmd "charizard psa 10" --json > result.json

# 顯示賣家與運費欄位（含運費一起比價時很有用）
run.cmd "charizard psa 10" --seller-info

# 用預設別名搵卡（讀 presets.json，打 @名稱 即可）
run.cmd @onepiece psa 10
run.cmd --list-presets

# 對比近期成交價：在售價 vs 已售出中位數（爬蟲版）
run.cmd "charizard psa 10" --source scrape --sold-ref
```

完整選項清單：`run.cmd --help`

---

## 它是怎麼算「甜甜價」的？

集換式卡牌價格分布非常偏斜（同一張卡可能 $20 也可能 $5000），
直接用算術平均會被少數天價商品灌水。所以流程是：

1. **過濾**：剔除命中關鍵字黑名單（預設 `reprint / proxy / digital / custom art`）與非目標幣別的商品。
2. **去離群值**：用 **Tukey IQR**（`Q1 - 1.5×IQR` ~ `Q3 + 1.5×IQR`）濾掉整箱、天價贗品。
   - 想關掉：`--no-outlier-filter`；想放寬：`--iqr-k 3`。
3. **算基準價**：預設 **平均價**（`--baseline mean`），也可選 `median` 或 `trimmed`（修剪平均）。
4. **找甜甜價**：列出 `price <= 基準價 × (1 - minDiscount/100)` 的商品，依價格升冪排序，
   並印出每筆相對平均價的**折扣百分比**與**實際差額**。

摘要區塊會同時列出 平均價 / 中位數 / 修剪平均 / 標準差 / IQR 正常範圍，讓你判斷樣本品質。

---

## 專案結構

```
.
├── run.cmd                     # Windows 啟動腳本（自動切 UTF-8）
├── src
│   └── index.js                # 單檔版：CLI 入口 + 解析 + API 客戶端 + 兩套爬蟲引擎 + 統計 + 報表
├── fixtures
│   └── sample-listings.json    # --demo 用的離線資料
├── presets.json                # 預設別名（@pokemon、@onepiece …）
├── .env.example
└── package.json
```
> 📄 **單檔版**：原本分散的模組（`parse.js` / `config.js` / `stats.js` / `report.js` / `ebayApi.js` /
> `sources.js` / `scrapeShared.js` / `ebayPlaywright.js` / `ebayScraper.js`）已全部合併進 `src/index.js`，
> 檔內以 11 個編號區塊（§1～§11）標示原始出處。
> 現在只需要 `src/index.js` 一個檔案就能跑完整條流程；其餘 `src/*.js` 已是舊版殘留，沒有任何程式會引用它們。
> 爬蟲套件（`playwright` / `puppeteer-extra` 系列）仍在 `optionalDependencies`，
> 且只有真的要爬的那一刻才會被 `require()`，所以 API 模式與 `--demo` 完全零依賴。


---

## 爬蟲備用方案（`--source scrape`）

只有在沒有 API 憑證、或 API 出問題時才需要。它用真正的 Headless Chromium 開啟 eBay 搜尋頁。

### 兩種引擎（`--engine`）

| 引擎 | 需要套件 | 說明 |
| --- | --- | --- |
| `playwright`（**預設**） | `playwright` | 內建 Chromium 不含第三方 stealth 外掛，本專案手動補齊指紋修補 |
| `puppeteer` | `puppeteer` + `puppeteer-extra` + `puppeteer-extra-plugin-stealth` | 走 `puppeteer-extra` 的 stealth 外掛 |

兩種引擎**共用同一套解析邏輯**（`src/index.js` 第 7 區塊），輸出格式與過濾結果一致；
差別只在瀏覽器驅動的指紋不同 —— 被擋時可以**換引擎交叉測試**。

共用特性：

- 真實 **User-Agent**（Chrome/131）、`Accept`、`Accept-Language`、`Sec-Fetch-*`、`sec-ch-ua` 等完整 headers
- 抹掉 `navigator.webdriver`：`--disable-blink-features=AutomationControlled` ＋ 覆寫屬性 ＋ 移除 `--enable-automation`
- 補齊 `navigator.plugins` / `languages` / `hardwareConcurrency`、`window.chrome`、WebGL 廠商字串、Notification 權限
- 先造訪 eBay 首頁累積 cookie，再進搜尋頁（大幅降低被擋機率）
- URL 明確帶 `LH_Sold=0&LH_Complete=0`，**保證只抓在售（未售出）商品**
- 同時支援舊版 `.s-item` 與新版 `.s-card` 兩種版型
- 固定間隔翻頁（`--delay`），避免請求過快

### 安裝與執行（Playwright，預設引擎）

```bash
npm install                             # playwright 已列在 optionalDependencies
npm run install-browser:playwright      # = npx playwright install chromium
# Linux 若缺系統依賴：npx playwright install chromium --with-deps

run.cmd "charizard psa 10" --source scrape
run.cmd "charizard psa 10" --source scrape --pages 3 --delay 2500
```

### 安裝與執行（Puppeteer，備選引擎）

```bash
npm install                                 # 安裝 puppeteer + stealth（會下載 Chromium）
npm run install-browser                     # = npx puppeteer browsers install chrome

run.cmd "charizard psa 10" --source scrape --engine puppeteer
```

> 兩者都支援 `--browser-channel chrome`，可直接使用你電腦上已安裝的 Chrome，省下下載 Chromium 的時間。

### 被 403 擋住時

程式偵測到 403 / 429 / "Pardon Our Interruption" 時會給出建議。依序試：

1. **改走官方 API**（最建議）——填好 `.env` 後 `--source api`，完全不受反爬影響。
2. **換引擎交叉測試**——Playwright 與 Puppeteer 的指紋不同，可能只有一種過關：
   ```bash
   run.cmd "charizard psa 10" --source scrape --engine puppeteer
   ```
3. 用**有視窗**模式觀察實際發生什麼事：
   ```bash
   run.cmd "charizard psa 10" --source scrape --headed --debug
   ```
   `--debug` 會把收到的 HTML 存到 `_debug/playwright-page-1.html`（Puppeteer 引擎則為 `_debug/page-1.html`），
   可確認是「被擋」還是「版型變了」。
4. 改用**本機已安裝的 Chrome** 指紋（通常最不容易被擋）：
   ```bash
   run.cmd "charizard psa 10" --source scrape --browser-channel chrome
   ```
5. 拉長間隔：`--delay 5000`，並降低 `--pages`。
6. 若你的 IP（公司／機房／VPN）已被 eBay 列入黑名單，換網路或直接用 API。

---

## 預設別名：更快搵卡（presets.json）

唔想次次打全名，可以用「別名」一次過套用常用查詢 + 過濾條件。
專案根目錄的 `presets.json` 內建幾個常見系列（寶可夢 / 航海王 / 龍珠 / 遊戲王 / Lorcana / MTG / 籃球卡 / 寶可夢 151）。

```bash
# 展開別名（@名稱 = 讀 presets.json 的 query + 過濾）
run.cmd @onepiece
run.cmd @onepiece luffy psa 10          # 別名 + 額外關鍵字
run.cmd @pokemon charizard psa 10       # 寶可夢 + 額外關鍵字

# 查看所有可用別名
run.cmd --list-presets
```

每個別名可設定的欄位（全部選填，命令列參數會覆蓋它們）：

| 欄位 | 說明 |
| --- | --- |
| `query` | 展開後的搜尋關鍵字 |
| `minPrice` / `maxPrice` | 價格區間 |
| `exclude` | 額外黑名單（會「併入」預設黑名單，不是取代） |
| `category` | eBay 分類 ID（爬蟲 `_sacat` / API `category_ids`） |
| `marketplace` / `currency` | 市場與幣別 |
| `condition` / `buying` / `source` / `limit` / `pages` | 其他過濾 |

也可直接用 `--category 183454` 鎖定分類（不經別名）。

---

## 成交價基準：在售價 vs 近期成交價（--sold-ref）

預設只拿「在售」商品算平均價，但「在售」價格可以亂標。
加 `--sold-ref` 後，程式會**另外用爬蟲抓「已售出」清單**（`LH_Sold=1`），
算出**近 90 日成交中位數**，再把每筆在售價拿來比對：

- **vs 成交** 欄位會顯示 `+12%`（貴過成交中位數）或 `-8%`（平過）。
- 依 `--sold-vs` 門檻（預設 15%）標注 **偏貴 / 合理 / 抵買**。

```bash
# 爬蟲模式 + 成交價基準
run.cmd "charizard psa 10" --source scrape --sold-ref

# 調整門檻與抓取頁數
run.cmd "charizard psa 10" --source scrape --sold-ref --sold-vs 10 --sold-pages 3
```

> ⚠️ **限制**：
> - 成交價基準目前**只走爬蟲**（`--sold-ref` 會另外開爬蟲抓已售出頁），需要先裝 `playwright`／`puppeteer`。
> - eBay 免費成交資料只有**近 ~90 日**；要更長歷史需 Terapeak（付費）。
> - 想累積自己的歷史庫，可每次加 `--out reports/sold-YYYYMMDD.json` 存底，之後自行彙整。

---

## 疑難排解

| 症狀 | 原因 / 解法 |
| --- | --- |
| `HTTP 403` / `Access Denied` | 被 Akamai 反爬。改用 `--source api`（填 `.env`），或參考上面「被 403 擋住時」。 |
| `401` / `invalid_client` | Client ID / Secret 貼錯，或 `EBAY_ENV` 與 Keyset 不符（sandbox 憑證不能打 production）。 |
| `invalid_scope` / token 取得失敗 | Keyset 尚未開通或已停用，回 developer.ebay.com 確認 Production Keyset 狀態。 |
| `沒有可用的價格樣本` | 過濾太嚴：放寬 `--exclude`、`--min-price` / `--max-price`，或加大 `--limit`。 |
| 找不到 `playwright` 套件 | `npm install playwright && npx playwright install chromium`，或改 `--engine puppeteer`。 |
| `Executable doesn't exist at ...` | Playwright 尚未下載瀏覽器，執行 `npx playwright install chromium`。 |
| `未知的 --engine` | `--engine` 只接受 `playwright`（預設）或 `puppeteer`。 |
| 找不到 `puppeteer` 套件 | 執行 `npm install`，或改 `--engine playwright`／`--browser-channel chrome`。 |
| 中文變亂碼 | 用 `run.cmd`（會自動 `chcp 65001`），或 `chcp 65001` 後再執行 `node src/index.js`。 |
| 平均價看起來偏高／偏低 | 樣本裡混到不同版本（1st Edition / Unlimited / 日版 / 英文版）。把關鍵字寫精準，例如 `charizard base set 1st edition psa 10`，並用 `--min-price` / `--max-price` 收窄。 |

---

## 注意事項

- Browse API 只回傳 **active（在售）** 商品，正好符合「未賣出卡片」的需求；**已成交價**請改用 `item/getItem` 的 sold 資料或 Marketplace Insights API（需額外申請）。
- API 模式會自動把 `itemWebUrl` 清成 `https://www.ebay.com/itm/<itemId>` 的乾淨連結。
- 爬蟲模式的商品連結也同樣清理過。
- CSV 匯出檔開頭含 UTF-8 BOM，Excel 開中文欄位不會亂碼。
- API 呼叫次數：`pages × 1` 次（每次最多 200 筆），請留意每日額度。

---

## 輸出範例（`run.cmd --demo`）

```
════════════════════════════════════════════════════════════════════════
  eBay 卡牌價格掃描 — 找出在售且低於平均價的甜甜價
════════════════════════════════════════════════════════════════════════
  搜尋關鍵字   : charizard base set psa 10
  資料來源     : 內建範例資料（fixtures/sample-listings.json）
  市場 / 幣別  : EBAY_US / USD
  在售商品數   : 29 筆
  標題黑名單剔除: 1 筆
  其他幣別略過 : 1 筆

  有效樣本     : 25 筆（IQR 濾除 2 筆離群值）
  ── 平均價基準（平均價）: $218.22
  平均價       : $218.22
  中位數       : $210.00
  修剪平均     : $214.19
  標準差       : $50.14
  IQR 正常範圍 : $84.38 ~ $357.36
  價格區間     : $145.00 ~ $349.99

  ✅ 符合「<= 平均價」: 14 筆
════════════════════════════════════════════════════════════════════════

#   標題                                                     價格      折扣      比平均便宜   商品連結
──  ────────────────────────────────────────────────────────  ────────  ────────  ────────────  ──────────────────────────────────────
1   Charizard Base Set Shadowless PSA 10 Gem Mint #4/102      $145.00   -33.6%    -$73.22       https://www.ebay.com/itm/1100000001
2   1999 Pokemon Base Set Charizard Holo PSA 10 GEM MINT     $152.50   -30.1%    -$65.72       https://www.ebay.com/itm/1100000002
3   Charizard Base Set 1st Edition PSA 10 #4/102 English     $160.00   -26.7%    -$58.22       https://www.ebay.com/itm/1100000003
...
14  Pokemon Base Set Charizard Holo PSA 10 #4/102 Gem        $215.00   -1.5%     -$3.22        https://www.ebay.com/itm/1100000014
```

---

## Discord Bot：甜甜價推播 + 雙向指令

本專案可加上一個 **Discord Bot**，讓你在手機 / 電腦上直接下指令查價，並在背景自動推播「甜甜價」通知。

### 設定

1. 安裝依賴（已內含 `discord.js`）：

   ```bash
   npm install
   ```

2. 在 `.env` 加入（欄位已內建於 `.env` / `.env.example`）：

   ```bash
   DISCORD_TOKEN=你的_Bot_Token
   DISCORD_CHANNEL_ID=要推播的頻道ID
   DISCORD_POLL_INTERVAL_MIN=30   # 選填，背景輪詢間隔（分鐘），預設 30
   DISCORD_MIN_DISCOUNT=0         # 選填，低於平均價多少%才推播，預設 0
   ```

3. 建立 Bot 並取得 Token：
   - 前往 https://discord.com/developers/applications → New Application → **Bot**
   - 開啟 **Message Content Intent**（`Bot → Privileged Gateway Intents`）
   - **Reset Token** 複製後填入 `DISCORD_TOKEN`
   - 用 OAuth2 URL 把 Bot 邀請進你的伺服器（勾 `bot`，權限勾 `Send Messages` / `Read Messages` / `Embed Links`）

4. 取得頻道 ID：Discord 設定 → 進階 → 開啟**開發者模式**，對頻道按右鍵 → 複製 ID。

### 啟動

```bash
npm run bot
```

### 指令

| 指令 | 說明 |
| --- | --- |
| `!search <關鍵字>` | 即時搜尋 eBay，回傳最平前 5 筆卡片 |
| `!rare <關鍵字> [價格範圍]` | 搜尋 /99 以下高稀缺卡片，且低於在售平均價；範圍可用 `100-500` / `500+` / `-500` 或 `cheap`/`mid`/`high`/`premium` |
| `!add <關鍵字>` | 把關鍵字加入背景輪詢監測清單（寫入 `presets.json` 的 `_watchlist`） |
| `!list` | 顯示目前監測中的關鍵字清單 |
| `!help` | 顯示指令說明 |

### 甜甜價自動推播

- Bot 每 `DISCORD_POLL_INTERVAL_MIN` 分鐘，對 `_watchlist` 的每個關鍵字跑一次掃描。
- 發現**低於歷史平均價**的卡片，就推播 Rich Embed 到 `DISCORD_CHANNEL_ID`，內含：
  - 卡片標題、當前價格、歷史平均價、折扣幅度
  - 一個「前往 eBay 查看」連結按鈕（可直接點跳轉 eBay 頁面）
- 同一 session 內不會重複推播同一張卡（以 itemId 去重）。

---

## 部署到 Render（24/7 免費託管）

想讓 Bot 在你電腦關機後都照常運作，可部署到 Render 免費方案。已備妥：
- `Dockerfile`：精簡映像（僅 Node.js + discord.js + eBay API，不含 playwright/puppeteer）
- `.dockerignore`：排除 node_modules / .env 等
- `render.yaml`：Render Blueprint 設定（Web Service + 環境變數）

### ⚠️ 免費方案重點
1. Render Free **只支援 Web Service**（不支援 Background Worker），所以本 Bot 以 Web Service 形式部署，並在 `src/discordBot.js` 內建 PORT 健康檢查伺服器。
2. 免費 Web Service **閒置約 15 分鐘會自動休眠**；要 24/7 常駐，請用外部監測（UptimeRobot / cron-job.org）每 5–10 分鐘 ping 一次服務網址。
3. 免費方案**檔案系統是暫時的**：重新部署後 `presets.json` 的變更（例如 `!add` 加的關鍵字）會還原；建議直接把監測關鍵字寫進 `presets.json` 再 push。

### 必填環境變數
`EBAY_CLIENT_ID`、`EBAY_CLIENT_SECRET`、`DISCORD_TOKEN`、`DISCORD_CHANNEL_ID`。

> ⚠️ 一定要設 eBay API 憑證，否則 bot 會退回爬蟲模式（映像檔沒有瀏覽器引擎）而失敗。


