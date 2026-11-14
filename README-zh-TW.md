<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/overview-zh-TW-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/overview-zh-TW-light.svg">
  <img src="assets/readme/overview-zh-TW-light.svg" width="100%" alt="Uptime Polaris：服務可用性和主機監控">
</picture>

<a href="README.md">English</a> · <a href="README-zh-CN.md">简体中文</a> · <strong>繁體中文（台灣）</strong> · <a href="README-zh-HK.md">繁體中文（香港）</a> · <a href="README-ja-JP.md">日本語</a> · <a href="README-ko-KR.md">한국어</a> · <a href="README-fr-FR.md">Français</a> · <a href="README-pt-BR.md">Português (Brasil)</a> · <a href="README-ru-RU.md">Русский</a>

# Uptime Polaris - 自架狀態頁與服務監控

Uptime Polaris 定時檢查網站、連接埠和排程任務，採集伺服器指標，並在狀態變化時發送通知。<br>
可以部署在 Cloudflare Workers 上，不需要維護伺服器；也可以在自有伺服器上執行 Go 後端。<br>
內建公開狀態頁和管理後台，介面支援 9 種語言。

<p>
  <a href="https://developers.cloudflare.com/workers/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&amp;logo=cloudflare&amp;logoColor=white" height="20" alt="執行於 Cloudflare Workers"></a>
  <a href="backends/go/README.md"><img src="https://img.shields.io/badge/Go-Backend-00ADD8?style=flat-square&amp;logo=go&amp;logoColor=white" height="20" alt="Go backend"></a>
  <a href="frontend/README.md"><img src="https://img.shields.io/badge/React-TypeScript-3178C6?style=flat-square&amp;logo=react&amp;logoColor=white" height="20" alt="前端使用 React 和 TypeScript"></a>
  <a href="https://github.com/XingLingQAQ/polaris-agent"><img src="https://img.shields.io/badge/Rust-Agent-93450A?style=flat-square&amp;logo=rust&amp;logoColor=white" height="20" alt="Polaris Agent 使用 Rust"></a>
  <a href="docs/configuration.md"><img src="https://img.shields.io/badge/Storage-D1%20%2F%20SQLite%20%2F%20PostgreSQL-4169E1?style=flat-square&amp;logo=postgresql&amp;logoColor=white" height="20" alt="Storage: D1, SQLite, PostgreSQL"></a>
</p>

<p><a href="#功能">功能</a> · <a href="#部署">部署</a> · <a href="#快速開始">快速開始</a> · <a href="#監控伺服器">Agent</a> · <a href="#資料與公開範圍">公開範圍</a> · <a href="#常見問題">常見問題</a> · <a href="#文件">文件</a></p>

</div>

## 為什麼選擇 Uptime Polaris

- **不用維護伺服器**：部署在 Cloudflare Workers 上，檢查、通知和狀態頁都由 Cloudflare 執行。需要探測內網或縮短檢查間隔時，可以改用 Go 後端，兩者使用同一套介面。
- **狀態來自實際結果**：頁面只顯示實際檢查和上報得到的資料。沒有資料時顯示等待，不會把缺口補成正常。
- **排程任務也能監控**：備份腳本和 cron 任務按時上報心跳，超過時限沒有上報即判定為異常。
- **伺服器指標**：`polaris-agent` 上報 CPU、記憶體、磁碟、負載和網路，也可以從所在主機檢查內網服務。
- **兩種公開頁面**：監控狀態頁和機器狀態頁分開展示，可以分別綁定網域；維護期間自動切換到維護頁面。
- **依分組發送通知**：支援 Telegram、飛書、Slack、Discord、Webhook、Apprise 和 Server醬，每個管道可以只負責部分分組。
- **資料庫可選**：Worker 使用 D1 或 PostgreSQL，Go 使用 SQLite 或 PostgreSQL，既有資料可以遷移到 PostgreSQL。

## 功能

### <img src="assets/readme/check.svg" width="20" height="20" alt=""> 服務檢查與心跳

- HTTP 檢查可以驗證狀態碼、JSON 欄位、回應標頭和回應時間；TCP 檢查連接埠能否連線，也可以送出內容並比對回應。
- Go 後端還能直接檢查 UDP、ICMP、DNS、TLS 和 WebSocket。Worker 上的 UDP 和 ICMP 檢查由 Agent 執行。
- 附加檢查包括 SSL 憑證到期、網域到期和 DNS 記錄。
- Push 監控提供專屬上報網址，排程任務按時發送 POST 請求，逾時未上報即判定為異常。
- 最短檢查間隔為 60 秒（Worker）或 5 秒（Go）。目標只在內網開放時，可以指定一台 Agent 作為檢查來源。

監控類型和各項設定，詳見[使用手冊](docs/usage.md)。

### <img src="assets/readme/host.svg" width="20" height="20" alt=""> 伺服器監控

- `polaris-agent` 上報 CPU、記憶體、磁碟、負載、網路和掛載點，支援 Linux、macOS 和 Windows，Linux 還可以使用 Docker 安裝。
- 資源告警可以設定閾值和持續時間，連續超過閾值才會告警；恢復時依比例回落，減少臨界值附近的反覆告警。
- 機器狀態頁可以單獨開啟，支援搜尋、篩選和地圖檢視，也可以選擇 2～4 台機器比較。機器狀態頁預設關閉，機器預設只在後台可見。

安裝、管理和更新，詳見 [Agent 手冊](docs/agents.md)。

### <img src="assets/readme/bell.svg" width="20" height="20" alt=""> 狀態頁與通知

- 狀態頁顯示目前狀態、可用率和事件記錄，支援分組，只展示標記為公開的監控。
- 維護視窗可以設為單次或每週重複。開始前在頁面頂端顯示公告，維護期間暫緩自動通知。
- 每個通知管道可以選擇訊息語言和負責的分組。後台保留投遞記錄，區分發送成功、供應商拒絕和網路逾時。

管道設定與分組範圍，詳見[通知指南](docs/notifications.md)。

### <img src="assets/readme/layers.svg" width="20" height="20" alt=""> 儲存與主題

- Worker 使用 D1 或 PostgreSQL，Go 使用 SQLite 或 PostgreSQL；D1 和 SQLite 的資料都可以遷移到 PostgreSQL。
- 公開頁面可以安裝第三方主題，上傳 ZIP 壓縮檔或填寫下載網址，套用前可以預覽。Worker 的主題存放在 R2，Go 存放在資料目錄。
- 未安裝主題時使用內建主題，管理後台一律使用內建介面。

主題的安裝與製作，詳見[主題指南](docs/themes.md)。

### 更多

- **指令面板**：在後台按 `Ctrl+K`（macOS 為 `⌘K`），可以搜尋頁面、監控和 Agent。
- **狀態浮層**：後台頂端彙總異常的監控和離線的 Agent，可以直接暫停、立即檢查或複製摘要。
- **API**：管理介面支援 Bearer Token 認證，可以透過腳本建立和管理監控，詳見 [API 參考](docs/api.md)。
- **介面語言**：簡體中文、繁體中文（台灣、香港）、英語、日語、韓語、法語、葡萄牙語和俄語。

## 部署

每次部署選擇一種後端，兩種後端使用相同的介面。

| | Cloudflare Worker | Go |
| --- | --- | --- |
| 執行環境 | Cloudflare | 自有伺服器或容器 |
| 資料庫 | D1 或 PostgreSQL | SQLite 或 PostgreSQL |
| 直接探測 | HTTP、TCP（UDP、ICMP 需透過 Agent） | HTTP、TCP、UDP、ICMP、DNS、TLS、WebSocket |
| 最短檢查間隔 | 60 秒 | 5 秒 |
| 主題檔案 | R2（選用） | 資料目錄 |

不想維護伺服器時建議使用 Worker；需要探測內網服務、使用更多協定或更短的檢查間隔時，請選擇 Go。詳細比較見[選擇後端](docs/backends.md)。

### 部署到 Cloudflare

1. Fork 本儲存庫。
2. 在 Cloudflare 控制台開啟 **Workers & Pages → Create application → GitHub**，選擇 fork 後的儲存庫。建置命令填寫 `npm run build`，部署命令填寫 `npm run deploy`。
3. 部署完成後開啟網站，初始化頁面會先檢查綁定和密鑰。請依頁面提示在 Worker 的 **Settings** 中設定：
   - **D1（選用）**：使用 D1 時，在 **Bindings** 中新增資料庫，變數名稱填寫 `DB`。未綁定 D1 時，初始化只提供 PostgreSQL。
   - **KV（必需）**：在 **Bindings** 中新增 KV 命名空間，變數名稱填寫 `CONFIG`，用於儲存資料庫選擇和加密的連線位址。
   - **初始化密鑰**：在 **Variables and Secrets** 中新增 Secret `ADMIN_TOKEN`，值使用足夠長的隨機字串，例如 `openssl rand -hex 32` 的輸出。
   - **Analytics Engine（必需）**：在控制台啟用 Analytics Engine，並在 **Bindings** 中新增資料集，變數名稱填 `UPTIME`。
   - **R2（選用）**：安裝第三方主題時需要。在 **Bindings** 中新增儲存桶，變數名稱填 `THEMES`，也可以在初始化後再新增。
4. 回到初始化頁面點選「重新檢查」。必要項目通過後，輸入 `ADMIN_TOKEN`，設定並驗證資料庫，再建立管理員帳號。

也可以透過下方按鈕部署。按鈕會在您的 GitHub 帳號下建立新的儲存庫（不是 fork，之後無法透過 Sync fork 更新），資料庫和密鑰同樣依初始化頁面的提示設定：

[![部署到 Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/XingLingQAQ/UptimePolaris)

命令列部署和 PostgreSQL 設定，詳見[部署指南](docs/deployment.md)。

<a id="deploy-go"></a>

### 部署 Go 後端

從 [Releases](https://github.com/XingLingQAQ/UptimePolaris/releases) 下載對應系統和架構的程式，重新命名為 `polaris`（Windows 為 `polaris.exe`）後啟動：

```sh
chmod +x polaris   # Linux / macOS
./polaris --data-dir ./data
```

```powershell
.\polaris.exe --data-dir .\data
```

程式預設監聽 `127.0.0.1:8080`。如需對外存取，請修改 `--addr` 或設定反向代理。所有資料保存在 `./data` 目錄，該目錄需要持久化儲存、限制存取權限並定期備份。啟動參數和環境變數，詳見 [Go 後端說明](backends/go/README.md)。

## 快速開始

1. 開啟網站的 `/setup` 頁面。Worker 會先檢查綁定和密鑰，通過後輸入 `ADMIN_TOKEN`；Go 輸入啟動日誌中的初始化密鑰。接著建立管理員帳號。
2. 進入 `/admin`，在「監控項目」中新增監控。例如選擇 HTTP，填入 `https://example.com/health`，儲存後點選「立即檢查」。
3. 在「通知」中新增管道，並發送一則測試訊息。
4. 使用未登入的瀏覽器視窗開啟網站首頁，確認狀態頁顯示的內容。

首次登入時，總覽頁的「開始使用」清單會列出新增監控、設定網站名稱、設定通知和接入 Agent 這幾步。

## 監控伺服器

在控制台的「Agent 管理」中新增機器，選擇平台和安裝方式，然後在目標機器上執行產生的安裝指令。目標機器需要能夠存取 GitHub。

安裝完成後，可以使用 `pa`（`polaris-agent` 的簡寫）管理服務：

```sh
pa status
pa restart
pa logs -f
```

- 安裝指令包含網站位址和該機器的 Token，請在正式網域下產生，並避免公開。
- 新增機器不會自動建立監控，需要在「監控項目」中新增「Agent 主機」類型的監控。
- 手動安裝模式沒有服務管理器，`pa start`、`stop`、`restart` 無法使用。

安裝模式和平台差異，詳見 [Agent 手冊](docs/agents.md)。

## 升級與移除

### 升級

升級前請先備份資料庫，完整步驟見[維運指南](docs/operations.md)。

- **Cloudflare**：Fork 部署在 GitHub 上執行 Sync fork，Workers Builds 會自動重新部署，並保留控制台中新增的綁定。按鈕部署需要把新版本合併到產生的儲存庫。
- **Go**：停止服務並備份資料目錄，替換程式後使用原資料目錄啟動。
- **Agent**：在機器上執行 `pa update`。代管安裝也可以在控制台開啟自動更新，預設關閉。

### 移除

- **Cloudflare**：在控制台刪除 Worker。D1 資料庫、R2 儲存桶和 PostgreSQL 資料庫不會隨 Worker 刪除，不再需要時請另外刪除。
- **Go**：停止服務後刪除程式和資料目錄；使用 PostgreSQL 時，另外刪除對應的資料庫。
- **Agent**：下載目前網站的安裝指令碼，然後執行移除：

  ```sh
  curl -fsSL 'https://status.example.com/install.sh' -o install.sh
  sh install.sh --uninstall
  ```

  Windows 的移除方式見 [Agent 手冊](docs/agents.md)。移除 Agent 不會刪除控制台中的監控。

## 資料與公開範圍

- 資料保存在您自己的部署中：Worker 使用您 Cloudflare 帳號下的 D1 或您提供的 PostgreSQL，Go 使用資料目錄中的 SQLite 或您提供的 PostgreSQL。
- 狀態頁和公開介面無需登入即可存取。監控名稱、HTTP 目標的網域和路徑、TCP 目標的主機和連接埠會公開顯示，請勿在其中填寫內網位址或密鑰。
- HTTP 目標中的使用者名稱、密碼和查詢參數會被移除；認證設定和 Agent Token 不會出現在公開資料中。
- Push 網址中的 Token 相當於該監控的上報憑證，請勿公開。
- 不需要公開的監控，可以在監控清單中選擇「在狀態頁隱藏」，之後只在後台可見。
- Worker 的 SSL 到期檢查會查詢公開的憑證透明度日誌；Agent 啟動時會查詢本機公網 IP 的歸屬地，更新時會存取 GitHub。

公開頁面和介面會回傳哪些欄位，詳見[公開資料](docs/usage.md)。

## 常見問題

**初始化頁面停在部署檢查，無法進入下一步？**
請在 Worker 的 **Settings** 中設定必要的 `ADMIN_TOKEN` 和 `UPTIME`，儲存並部署後按一下「重新檢查」。D1 和 R2 為選用項目；未綁定 D1 時，在下一步設定 PostgreSQL 連線。

**在瀏覽器開啟 Push 網址，為什麼沒有資料？**
瀏覽器發送的是 GET 請求，Push 只接受 POST，GET 請求會回傳 405。請使用 `curl -X POST` 或在任務中發送 POST 請求。

**通知測試成功，故障時卻沒有收到？**
請檢查管道是否啟用、分組範圍是否包含該監控，以及目前是否處於維護視窗。管道沒有選擇任何分組時，會接收全部監控的通知。

**Agent 顯示離線？**
在機器上執行 `pa status` 和 `pa logs -f`，確認服務正在執行，並且能夠存取網站網域。預設每 60 秒上報一次，約 3 分鐘沒有上報會判定為離線。

更多問題見[常見問題](docs/troubleshooting.md)。仍無法解決時，歡迎在 [Issues](https://github.com/XingLingQAQ/UptimePolaris/issues) 中回報。

## 文件

| 文件 | 內容 |
| --- | --- |
| [選擇後端](docs/backends.md) | Worker 與 Go 的差異 |
| [部署指南](docs/deployment.md) | Fork 部署、按鈕部署、手動部署、網域、PostgreSQL、D1 遷移到 PostgreSQL |
| [Go 後端](backends/go/README.md) | 啟動參數、環境變數、SQLite 遷移到 PostgreSQL |
| [使用手冊](docs/usage.md) | 後台、監控設定、Push、狀態頁、維護視窗、帳號與安全 |
| [Agent 手冊](docs/agents.md) | 安裝、管理、設定、更新、移除 |
| [通知指南](docs/notifications.md) | 管道設定、分組範圍、投遞記錄 |
| [主題指南](docs/themes.md) | 安裝、設定、預覽 |
| [設定參考](docs/configuration.md) | 綁定、環境變數、後台設定 |
| [API 參考](docs/api.md) | 介面、認證、範例 |
| [維運指南](docs/operations.md) | 備份、還原、升級、資料保留 |
| [常見問題](docs/troubleshooting.md) | 依故障現象排查 |

## 授權

Uptime Polaris 採用 [MIT 授權](LICENSE)。
