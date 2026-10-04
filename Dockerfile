# ============================================================
# eBay 卡價監測 Discord Bot — 精簡 Docker 映像
# ------------------------------------------------------------
# 只含 Node.js + discord.js + eBay Browse API（用 Node 內建 fetch），
# 不包含 playwright / puppeteer 等重型爬蟲（那些是 optionalDependencies）。
# ============================================================
FROM node:20-alpine

# 建立非 root 使用者（降低權限風險）
RUN addgroup -S app && adduser -S app -G app

ENV NODE_ENV=production
WORKDIR /app

# 先複製依賴檔，利用 Docker layer cache 加快重建
COPY package.json package-lock.json ./

# 只安裝正式依賴（--omit=optional 會跳過 playwright / puppeteer 等重型爬蟲）
RUN npm ci --omit=optional --no-audit --no-fund && npm cache clean --force

# 複製原始碼與監測清單（presets.json 內含 _watchlist）
COPY src ./src
COPY presets.json ./

# 以非 root 身份執行
USER app

# 啟動 Discord bot（長跑程式；Render 會透過 PORT 提供健康檢查）
CMD ["node", "src/discordBot.js"]
