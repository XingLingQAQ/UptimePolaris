<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/overview-zh-HK-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/readme/overview-zh-HK-light.svg">
    <img src="assets/readme/overview-zh-HK-light.svg" width="100%" alt="Uptime Polaris：服務可用性和主機監控">
  </picture>
</h1>

<p align="center"><strong>HTTP/TCP 檢查、Push 心跳、主機指標</strong><br>可運行於 Cloudflare Worker 或自行託管的 Go 後端。</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README-zh-CN.md">简体中文</a> · <a href="README-zh-TW.md">繁體中文（台灣）</a> · <strong>繁體中文（香港）</strong> · <a href="README-ja-JP.md">日本語</a> · <a href="README-ko-KR.md">한국어</a> · <a href="README-fr-FR.md">Français</a> · <a href="README-pt-BR.md">Português (Brasil)</a> · <a href="README-ru-RU.md">Русский</a>
</p>

<p align="center">
  <a href="https://developers.cloudflare.com/workers/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&amp;logo=cloudflare&amp;logoColor=white" height="20" alt="運行於 Cloudflare Workers"></a>
  <a href="backends/go/README.md"><img src="https://img.shields.io/badge/Go-Backend-00ADD8?style=flat-square&amp;logo=go&amp;logoColor=white" height="20" alt="Go backend"></a>
  <a href="frontend/README.md"><img src="https://img.shields.io/badge/React-TypeScript-3178C6?style=flat-square&amp;logo=react&amp;logoColor=white" height="20" alt="前端使用 React 和 TypeScript"></a>
  <a href="https://github.com/XingLingQAQ/polaris-agent"><img src="https://img.shields.io/badge/Rust-Agent-93450A?style=flat-square&amp;logo=rust&amp;logoColor=white" height="20" alt="Polaris Agent 使用 Rust"></a>
  <a href="docs/configuration.md"><img src="https://img.shields.io/badge/Storage-D1%20%2F%20SQLite%20%2F%20PostgreSQL-4169E1?style=flat-square&amp;logo=postgresql&amp;logoColor=white" height="20" alt="Storage: D1, SQLite, PostgreSQL"></a>
</p>

<p align="center">
  <a href="#快速開始">快速開始</a> ·
  <a href="#部署到-cloudflare">部署</a> · <a href="#deploy-go">部署 Go</a> ·
  <a href="#監控主機">Agent</a> ·
  <a href="#文檔">文檔</a>
</p>

Uptime Polaris 定時檢查網站和端口，接收定時任務發送的心跳，採集伺服器的 CPU、內存和磁盤指標，並在監控狀態變化時發送通知。項目自帶公開狀態頁和管理後台。

## 選擇後端

每次部署選擇一種後端，兩種後端使用相同的界面。

| | Cloudflare Worker | Go |
| --- | --- | --- |
| 運行環境 | Cloudflare | 自有伺服器或容器 |
| 數據庫 | D1 或 PostgreSQL | SQLite 或 PostgreSQL |
| 直接探測 | HTTP、TCP（UDP、ICMP 需通過 Agent） | HTTP、TCP、UDP、ICMP、DNS、TLS、WebSocket |
| 最短檢查間隔 | 60 秒 | 5 秒 |
| 主題文件 | R2（可選） | 數據目錄 |

不想維護伺服器時建議使用 Worker；需要探測內網服務、使用更多協議或更短的檢查間隔時，請選擇 Go。詳細對比見[選擇後端](docs/backends.md)。

## 功能

<p align="center">
  <img src="assets/readme/check.svg" width="24" height="24" alt="服務檢查圖標"><br>
  <strong>服務檢查與心跳</strong><br>
  支持 HTTP 和 TCP 檢查，並可附加響應內容、證書、域名到期和 DNS 檢查。Push 監控適用於定時任務和備份腳本，超過設定時間未收到心跳即判定為異常。
</p>

<p align="center">
  <img src="assets/readme/host.svg" width="24" height="24" alt="主機監控圖標"><br>
  <strong>伺服器監控</strong><br>
  <code>polaris-agent</code> 上報 CPU、內存、磁盤、負載和網絡指標，也可以從所在主機發起 HTTP/TCP 檢查，用於探測內網服務。
</p>

<p align="center">
  <img src="assets/readme/bell.svg" width="24" height="24" alt="狀態通知圖標"><br>
  <strong>狀態頁與通知</strong><br>
  狀態頁展示當前狀態和事件歷史，支持分組和維護窗口。通知渠道包括 Telegram、飛書、Slack、Discord、Webhook、Apprise 和 Server醬，每個渠道可以限定負責的監控分組。
</p>

<p align="center">
  <img src="assets/readme/layers.svg" width="24" height="24" alt="存儲和主題圖標"><br>
  <strong>存儲與主題</strong><br>
  Worker 使用 D1 或 PostgreSQL 存儲數據，主題存放在 R2；Go 使用 SQLite 或 PostgreSQL，主題存放在數據目錄。
</p>

## 快速開始

1. 將服務部署到 [Cloudflare](#部署到-cloudflare) 或[自有伺服器](#deploy-go)。
2. 打開站點的 `/setup` 頁面。Worker 會先檢查綁定和密鑰，通過後輸入 `ADMIN_TOKEN`；Go 輸入啟動日誌中的初始化密鑰。
3. 創建管理員帳號，然後在 `/admin` 添加監控。

## 部署到 Cloudflare

1. Fork 本倉庫。
2. 在 Cloudflare 控制台打開 **Workers & Pages → Create application → GitHub**，選擇 fork 後的倉庫。構建命令填寫 `npm run build`，部署命令填寫 `npm run deploy`。
3. 部署完成後打開站點，初始化頁面會先檢查綁定和密鑰。請按頁面提示在 Worker 的 **Settings** 中配置：
   - **D1（可選）**：使用 D1 時，在 **Bindings** 中新增數據庫，變量名填寫 `DB`。未綁定 D1 時，初始化只提供 PostgreSQL。
   - **初始化密鑰**：在 **Variables and Secrets** 中添加 Secret `ADMIN_TOKEN`，值使用足夠長的隨機字符串，例如 `openssl rand -hex 32` 的輸出。
   - **Analytics Engine（必需）**：在控制台啟用 Analytics Engine，並在 **Bindings** 添加數據集，變量名填寫 `UPTIME`。
   - **可選**：安裝第三方主題時添加 R2 存儲桶，變量名填寫 `THEMES`，也可在初始化後添加。
4. 回到初始化頁面點擊「重新檢查」。必需項通過後，輸入 `ADMIN_TOKEN`，配置並驗證數據庫，再創建管理員賬號。

後續升級只需在 GitHub 上執行 Sync fork，Workers Builds 會自動重新部署，並保留控制台中已添加的綁定。

也可以通過下方按鈕部署。按鈕部署會在你的 GitHub 帳號下新建一個倉庫（不是 fork，後續無法通過 Sync fork 同步更新），數據庫和密鑰同樣按初始化頁面的提示配置：

[![部署到 Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/XingLingQAQ/UptimePolaris)

命令行部署與 PostgreSQL 配置見[部署指南](docs/deployment.md)。

<a id="deploy-go"></a>

## 部署 Go 後端

從 [Releases](https://github.com/XingLingQAQ/UptimePolaris/releases) 下載對應系統和架構的程序，重命名為 `polaris`（Windows 為 `polaris.exe`）後啟動：

```sh
chmod +x polaris   # Linux / macOS
./polaris --data-dir ./data
```

```powershell
.\polaris.exe --data-dir .\data
```

程序默認監聽 `127.0.0.1:8080`。如需對外訪問，請修改 `--addr` 或配置反向代理。所有數據保存在 `./data` 目錄，該目錄需要持久化存儲、限制訪問權限並定期備份。更多配置見 [Go 後端說明](backends/go/README.md#安装与启动)。

## 監控主機

在後台的 Agent 頁面添加機器，選擇平台和安裝方式，然後在目標機器上執行生成的安裝命令。目標機器需要能夠訪問 GitHub。

安裝完成後，可使用 `pa`（`polaris-agent` 的簡寫）管理服務：

```sh
pa status
pa restart
pa logs -f
```

- 安裝命令包含站點地址和該機器的 Token，請在正式域名下生成，並避免公開。
- 添加機器不會自動創建監控，需要在監控頁面新增 Agent 類型的監控。
- 手動安裝模式沒有服務管理器，`pa start`、`stop`、`restart` 不可用。

更多說明見 [Agent 手冊](docs/agents.md)。

## 使用與公開信息

狀態頁無需登錄即可訪問，監控名稱、目標路徑和主機名可能出現在公開頁面和公開接口中，請勿在其中填寫內網地址或密鑰。公開範圍詳見[公開數據](docs/usage.md#公开数据)，通知配置見[通知指南](docs/notifications.md)。

## 文檔

| 文檔 | 內容 |
| --- | --- |
| [選擇後端](docs/backends.md) | Worker 與 Go 的區別 |
| [部署指南](docs/deployment.md) | Fork 部署、按鈕部署、手動部署、域名、PostgreSQL、D1 遷移到 PostgreSQL |
| [Go 後端](backends/go/README.md) | 啟動參數、環境變量、SQLite 遷移到 PostgreSQL |
| [使用手冊](docs/usage.md) | 監控配置、Push、狀態與可用率 |
| [Agent 手冊](docs/agents.md) | 安裝、管理、配置、更新、卸載 |
| [通知指南](docs/notifications.md) | 渠道配置、分組範圍、投遞記錄 |
| [主題指南](docs/themes.md) | 安裝、配置、預覽 |
| [配置參考](docs/configuration.md) | 綁定、環境變量、後台設置 |
| [API 參考](docs/api.md) | 接口、認證、示例 |
| [運維指南](docs/operations.md) | 備份、恢復、升級、數據保留 |
| [常見問題](docs/troubleshooting.md) | 按故障現象排查 |

## 授權

本項目採用 [MIT 許可證](LICENSE)。
