<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/overview-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/overview-light.svg">
  <img src="assets/readme/overview-light.svg" width="100%" alt="Uptime Polaris: service availability and host monitoring">
</picture>

<strong>English</strong> · <a href="README-zh-CN.md">简体中文</a> · <a href="README-zh-TW.md">繁體中文（台灣）</a> · <a href="README-zh-HK.md">繁體中文（香港）</a> · <a href="README-ja-JP.md">日本語</a> · <a href="README-ko-KR.md">한국어</a> · <a href="README-fr-FR.md">Français</a> · <a href="README-pt-BR.md">Português (Brasil)</a> · <a href="README-ru-RU.md">Русский</a>

# Uptime Polaris - self-hosted status page and uptime monitoring

Uptime Polaris checks websites, ports and scheduled jobs on a timer, collects server metrics and sends notifications when a status changes.<br>
It runs on Cloudflare Workers without a server to maintain, or as a Go backend on your own machine.<br>
Includes a public status page and an admin console, in 9 languages.

<p>
  <a href="https://developers.cloudflare.com/workers/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&amp;logo=cloudflare&amp;logoColor=white" height="20" alt="Runs on Cloudflare Workers"></a>
  <a href="backends/go/README.md"><img src="https://img.shields.io/badge/Go-Backend-00ADD8?style=flat-square&amp;logo=go&amp;logoColor=white" height="20" alt="Go backend"></a>
  <a href="frontend/README.md"><img src="https://img.shields.io/badge/React-TypeScript-3178C6?style=flat-square&amp;logo=react&amp;logoColor=white" height="20" alt="Frontend built with React and TypeScript"></a>
  <a href="https://github.com/XingLingQAQ/polaris-agent"><img src="https://img.shields.io/badge/Rust-Agent-93450A?style=flat-square&amp;logo=rust&amp;logoColor=white" height="20" alt="Polaris Agent built with Rust"></a>
  <a href="docs/configuration.md"><img src="https://img.shields.io/badge/Storage-D1%20%2F%20SQLite%20%2F%20PostgreSQL-4169E1?style=flat-square&amp;logo=postgresql&amp;logoColor=white" height="20" alt="Storage: D1, SQLite, PostgreSQL"></a>
</p>

<p><a href="#features">Features</a> · <a href="#deployment">Deploy</a> · <a href="#quick-start">Quick start</a> · <a href="#monitoring-hosts">Agent</a> · <a href="#data-and-public-scope">Public scope</a> · <a href="#faq">FAQ</a> · <a href="#documentation">Documentation</a></p>

</div>

## Why Uptime Polaris

- **No server to maintain**: deployed on Cloudflare Workers, with checks, notifications and the status page all running there. Switch to the Go backend when you need to probe an internal network or check more often; both use the same interface.
- **Status comes from real results**: the page only shows what a check or report actually produced. Missing data reads as pending, never as healthy.
- **Scheduled jobs included**: backup scripts and cron jobs send a heartbeat on schedule, and a missed heartbeat is reported as down.
- **Server metrics**: `polaris-agent` reports CPU, memory, disk, load and network, and can also check internal services from the machine that can reach them.
- **Two public pages**: the monitor status page and the machine status page are separate and can have their own domains. During maintenance both switch to the maintenance page.
- **Notifications by group**: Telegram, Feishu, Slack, Discord, Webhook, Apprise and ServerChan, each channel scoped to the groups it should cover.
- **Choice of database**: D1 or PostgreSQL on the Worker, SQLite or PostgreSQL on Go, and existing data can be migrated to PostgreSQL.

## Features

### <img src="assets/readme/check.svg" width="20" height="20" alt=""> Checks and heartbeats

- HTTP checks verify the status code, JSON fields, response headers and response time. TCP checks verify the port opens, and can send a payload and match the reply.
- The Go backend also checks UDP, ICMP, DNS, TLS and WebSocket directly. On the Worker, UDP and ICMP checks run through an Agent.
- Additional checks cover SSL certificate expiry, domain expiry and DNS records.
- Push monitors get a dedicated URL; a scheduled job posts to it and a missed post is reported as down.
- The shortest interval is 60 seconds on the Worker and 5 seconds on Go. When a target is only reachable on an internal network, pick an Agent as the check source.

Monitor types and every field are in the [usage guide](docs/usage.md).

### <img src="assets/readme/host.svg" width="20" height="20" alt=""> Server monitoring

- `polaris-agent` reports CPU, memory, disk, load, network and mount points on Linux, macOS and Windows; Docker is supported on Linux.
- Resource rules take a threshold and a duration, so only sustained readings raise an alert. Recovery is a percentage of the threshold, which settles readings that hover near the limit.
- The machine status page is opt-in, with search, filters and a map view, plus side-by-side comparison of 2 to 4 machines. It is off by default and machines stay admin-only until you publish them.

Installation, management and updates are in the [Agent guide](docs/agents.md).

### <img src="assets/readme/bell.svg" width="20" height="20" alt=""> Status pages and notifications

- The status page shows current status, availability and an event history, grouped as you like, with only the monitors you mark public.
- Maintenance windows run once or weekly. A notice appears above the page before the window, and automatic notifications pause while it is open.
- Each channel has its own message language and group scope. The console keeps a delivery record that separates successful sends, provider rejections and network timeouts.

Channel setup and group scope are in the [notification guide](docs/notifications.md).

### <img src="assets/readme/layers.svg" width="20" height="20" alt=""> Storage and themes

- D1 or PostgreSQL on the Worker, SQLite or PostgreSQL on Go; D1 and SQLite data can both be migrated to PostgreSQL.
- Third-party themes install on the public pages from a ZIP upload or a download URL, and can be previewed before you apply them. Themes live in R2 on the Worker and in the data directory on Go.
- Without a theme, the built-in design is used. The admin console always uses the built-in interface.

Installing and building themes is in the [theme guide](docs/themes.md).

### More

- **Command palette**: press `Ctrl+K` (or `⌘K` on macOS) in the console to search pages, monitors and Agents.
- **Status popover**: the console header summarises failing monitors and offline Agents, with pause, check now and copy summary.
- **API**: management endpoints accept a bearer token, so monitors can be created and managed from scripts. See the [API reference](docs/api.md).
- **Interface languages**: Simplified Chinese, Traditional Chinese (Taiwan, Hong Kong), English, Japanese, Korean, French, Portuguese and Russian.

## Deployment

Pick one backend per deployment; both use the same interface.

| | Cloudflare Worker | Go |
| --- | --- | --- |
| Runs on | Cloudflare | Your server or a container |
| Database | D1 or PostgreSQL | SQLite or PostgreSQL |
| Direct checks | HTTP, TCP (UDP and ICMP need an Agent) | HTTP, TCP, UDP, ICMP, DNS, TLS, WebSocket |
| Shortest interval | 60 seconds | 5 seconds |
| Theme files | R2 (optional) | Data directory |

Choose the Worker if you would rather not maintain a server. Choose Go when you need to probe internal services, use more protocols or check more often. The [backend comparison](docs/backends.md) has the details.

### Deploy on Cloudflare

1. Fork this repository.
2. In the Cloudflare dashboard open **Workers & Pages → Create application → GitHub** and select your fork. Use `npm run build` as the build command and `npm run deploy` as the deploy command.
3. Open the site once the deploy finishes. The setup page checks bindings and secrets first. Configure the following in the Worker's **Settings** as the page asks:
   - **D1 (optional)**: to use D1, add a database under **Bindings** with the variable name `DB`. Without D1, setup offers PostgreSQL only.
   - **KV (required for page-entered PostgreSQL)**: add a KV namespace under **Bindings** with the variable name `CONFIG` to store connection URLs encrypted. Optional when using only D1 or a deployment `DATABASE_URL`.
   - **Setup key**: add a secret `ADMIN_TOKEN` under **Variables and Secrets**, with a long random value such as the output of `openssl rand -hex 32`.
   - **Analytics Engine (required)**: enable Analytics Engine in the dashboard and add the dataset under **Bindings** with the variable name `UPTIME`.
   - **R2 (optional)**: needed for third-party themes. Add a bucket under **Bindings** with the variable name `THEMES`, or add it after setup.
4. On the setup page, select **Re-check**. Once the required checks pass, configure and verify the database with `ADMIN_TOKEN`, then create the administrator account.

There is also a deploy button. It creates a new repository in your GitHub account rather than a fork, so Sync fork cannot update it later. Database and secrets are configured the same way from the setup page:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/XingLingQAQ/UptimePolaris)

For command-line deploys and PostgreSQL, see the [deployment guide](docs/deployment.md).

<a id="deploy-go"></a>

### Deploy the Go backend

Download the build for your OS and architecture from [Releases](https://github.com/XingLingQAQ/UptimePolaris/releases), rename it to `polaris` (`polaris.exe` on Windows) and start it:

```sh
chmod +x polaris   # Linux / macOS
./polaris --data-dir ./data
```

```powershell
.\polaris.exe --data-dir .\data
```

It listens on `127.0.0.1:8080` by default; change `--addr` or put a reverse proxy in front to expose it. All data lives in `./data`, which needs persistent storage, restricted permissions and regular backups. Flags and environment variables are in the [Go backend guide](backends/go/README.md#install-and-start).

## Quick start

1. Open `/setup` on your site. The Worker checks bindings and secrets first, then takes `ADMIN_TOKEN`; Go takes the setup key printed in its startup log. Create the admin account.
2. Go to `/admin` and add a monitor under **Monitors**. For example, choose HTTP, enter `https://example.com/health`, save, then select "Check now".
3. Add a channel under **Notifications** and send a test message.
4. Open the site root in a private browser window and confirm what the status page shows.

On first login the overview shows a getting-started checklist: add a monitor, name the site, configure notifications, connect an Agent.

## Monitoring hosts

Add a machine under **Agent management** in the console, choose the platform and install method, then run the generated command on the target. The machine needs access to GitHub.

Once installed, manage the service with `pa` (short for `polaris-agent`):

```sh
pa status
pa restart
pa logs -f
```

- The install command contains the site URL and that machine's token. Generate it on your real domain and keep it out of public places.
- Adding a machine does not create a monitor. Add an **Agent host** monitor under **Monitors**.
- Manual install mode has no service manager, so `pa start`, `stop` and `restart` are unavailable.

Install modes and platform differences are in the [Agent guide](docs/agents.md).

## Upgrade and uninstall

### Upgrade

Back up the database first; the full procedure is in the [operations guide](docs/operations.md#upgrade).

- **Cloudflare**: for a fork, select Sync fork on GitHub and Workers Builds redeploys automatically, keeping the bindings added in the dashboard. A deploy-button install needs the new version merged into the generated repository.
- **Go**: stop the service and back up the data directory, replace the binary, then start it with the same data directory.
- **Agent**: run `pa update` on the machine. Managed installs can also enable automatic updates in the console; this is off by default.

### Uninstall

- **Cloudflare**: delete the Worker in the dashboard. The D1 database, R2 bucket and PostgreSQL database are not deleted with it; remove them separately if you no longer need them.
- **Go**: stop the service, then delete the binary and the data directory. If you use PostgreSQL, drop that database as well.
- **Agent**: download the install script from your site and run the uninstaller:

  ```sh
  curl -fsSL 'https://status.example.com/install.sh' -o install.sh
  sh install.sh --uninstall
  ```

  For Windows, see the [Agent guide](docs/agents.md#update-rollback-and-uninstall). Uninstalling an Agent does not remove its monitors from the console.

## Data and public scope

- Data stays in your own deployment: D1 in your Cloudflare account or your PostgreSQL for the Worker, SQLite in the data directory or your PostgreSQL for Go.
- The status page and public API need no login. Monitor names, the host and path of HTTP targets, and the host and port of TCP targets are public, so do not put internal addresses or secrets in them.
- Usernames, passwords and query strings in HTTP targets are removed; credentials and Agent tokens are never exposed.
- The token in a Push URL is that monitor's reporting credential. Keep it private.
- For a monitor that should not be public, select "Hide from status page" in the monitor list and it stays admin-only.
- The Worker's SSL check queries public certificate transparency logs, and the Agent looks up the region of the machine's public IP at startup and contacts GitHub for updates.

Which fields the public pages and API return is described in [public data](docs/usage.md#maintenance-status-and-public-data).

## FAQ

**The setup page stops at the deployment check and will not continue.**
Configure the required `ADMIN_TOKEN` and `UPTIME` in the Worker’s **Settings**, save and deploy, then select "Check again". D1 and R2 are optional; without D1, configure the PostgreSQL connection in the next step.

**Opening a Push URL in a browser gives no data.**
A browser sends GET and Push only accepts POST, so GET returns 405. Use `curl -X POST` or send the POST from the scheduled job.

**A notification test succeeds but real outages produce nothing.**
Check that the channel is enabled, that its group scope includes the monitor, and that no maintenance window is open. A channel with no groups selected receives every monitor.

**An Agent shows as offline.**
Run `pa status` and `pa logs -f` on the machine and confirm the service is running and can reach the site domain. Reports go out every 60 seconds by default, and about 3 minutes without one marks the machine offline.

More cases are in [troubleshooting](docs/troubleshooting.md). If a problem remains, open an [issue](https://github.com/XingLingQAQ/UptimePolaris/issues).

## Documentation

| Document | Contents |
| --- | --- |
| [Backend options](docs/backends.md) | Differences between the Worker and Go |
| [Deployment](docs/deployment.md) | Fork deploy, deploy button, manual deploy, domains, PostgreSQL, D1 to PostgreSQL |
| [Go backend](backends/go/README.md) | Flags, environment variables, SQLite to PostgreSQL |
| [Usage](docs/usage.md) | Console, monitor setup, Push, status page, maintenance windows, account and security |
| [Agent](docs/agents.md) | Install, manage, configure, update, uninstall |
| [Notifications](docs/notifications.md) | Channel setup, group scope, delivery records |
| [Themes](docs/themes.md) | Install, configure, preview |
| [Configuration](docs/configuration.md) | Bindings, environment variables, console settings |
| [API reference](docs/api.md) | Endpoints, authentication, examples |
| [Operations](docs/operations.md) | Backup, restore, upgrade, data retention |
| [Troubleshooting](docs/troubleshooting.md) | Diagnose by symptom |

## License

Uptime Polaris is released under the [MIT License](LICENSE).
