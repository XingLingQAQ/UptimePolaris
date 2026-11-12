<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/overview-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/readme/overview-light.svg">
    <img src="assets/readme/overview-light.svg" width="100%" alt="Uptime Polaris: service availability and host monitoring">
  </picture>
</h1>

<p align="center"><strong>HTTP/TCP checks, Push heartbeats, host metrics</strong><br>Runs on Cloudflare Workers or a self-hosted Go server.</p>

<p align="center">
  <strong>English</strong> · <a href="README-zh-CN.md">简体中文</a> · <a href="README-zh-TW.md">繁體中文（台灣）</a> · <a href="README-zh-HK.md">繁體中文（香港）</a> · <a href="README-ja-JP.md">日本語</a> · <a href="README-ko-KR.md">한국어</a> · <a href="README-fr-FR.md">Français</a> · <a href="README-pt-BR.md">Português (Brasil)</a> · <a href="README-ru-RU.md">Русский</a>
</p>

<p align="center">
  <a href="https://developers.cloudflare.com/workers/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&amp;logo=cloudflare&amp;logoColor=white" height="20" alt="Runs on Cloudflare Workers"></a>
  <a href="backends/go/README.md"><img src="https://img.shields.io/badge/Go-Backend-00ADD8?style=flat-square&amp;logo=go&amp;logoColor=white" height="20" alt="Go backend"></a>
  <a href="frontend/README.md"><img src="https://img.shields.io/badge/React-TypeScript-3178C6?style=flat-square&amp;logo=react&amp;logoColor=white" height="20" alt="Frontend built with React and TypeScript"></a>
  <a href="https://github.com/XingLingQAQ/polaris-agent"><img src="https://img.shields.io/badge/Rust-Agent-93450A?style=flat-square&amp;logo=rust&amp;logoColor=white" height="20" alt="Polaris Agent built with Rust"></a>
  <a href="docs/configuration.md"><img src="https://img.shields.io/badge/Storage-D1%20%2F%20SQLite%20%2F%20PostgreSQL-4169E1?style=flat-square&amp;logo=postgresql&amp;logoColor=white" height="20" alt="Storage: D1, SQLite, PostgreSQL"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#deploy-to-cloudflare">Deploy</a> · <a href="#deploy-go">Go deployment</a> ·
  <a href="#monitor-hosts">Agent</a> ·
  <a href="#documentation">Documentation</a>
</p>

Uptime Polaris checks sites and ports on a schedule, receives heartbeats from scheduled jobs, collects CPU, memory, and disk metrics from servers, and sends a notification when a monitor changes state. The public status page and admin console are built in.

## Choose a backend

Pick one backend per deployment. Both serve the same interface.

| | Cloudflare Worker | Go |
| --- | --- | --- |
| Runs on | Cloudflare | Your server or container |
| Database | D1 or PostgreSQL | SQLite or PostgreSQL |
| Direct probes | HTTP, TCP (UDP and ICMP through an Agent) | HTTP, TCP, UDP, ICMP, DNS, TLS, WebSocket |
| Minimum interval | 60 seconds | 5 seconds |
| Theme files | R2 (optional) | Data directory |

Use Worker when you do not want to maintain a server. Choose Go for private-network probes, more protocols, or shorter intervals. See [backend options](docs/backends.md) for details.

## Features

<p align="center">
  <img src="assets/readme/check.svg" width="24" height="24" alt="Service check icon"><br>
  <strong>Service checks and heartbeats</strong><br>
  HTTP and TCP checks with optional response, certificate, domain expiry, and DNS assertions. Push monitors suit cron jobs and backup scripts: a missed heartbeat past the timeout marks the monitor down.
</p>

<p align="center">
  <img src="assets/readme/host.svg" width="24" height="24" alt="Host monitoring icon"><br>
  <strong>Server monitoring</strong><br>
  <code>polaris-agent</code> reports CPU, memory, disk, load, and network metrics. It can also run HTTP and TCP checks from its host to reach internal services.
</p>

<p align="center">
  <img src="assets/readme/bell.svg" width="24" height="24" alt="Status notification icon"><br>
  <strong>Status page and notifications</strong><br>
  The status page shows current state and event history, with groups and maintenance windows. Notifications go to Telegram, Feishu, Slack, Discord, Webhook, Apprise, and ServerChan, and each channel can be limited to monitor groups.
</p>

<p align="center">
  <img src="assets/readme/layers.svg" width="24" height="24" alt="Storage and themes icon"><br>
  <strong>Storage and themes</strong><br>
  Worker stores data in D1 or PostgreSQL and themes in R2; Go uses SQLite or PostgreSQL and keeps themes in its data directory.
</p>

## Quick start

1. Deploy to [Cloudflare](#deploy-to-cloudflare) or to [your own server](#deploy-go).
2. Open `/setup`. Worker checks bindings and secrets first; Go asks for the setup key from the startup log.
3. Create the administrator account, then add monitors at `/admin`.

## Deploy to Cloudflare

1. Fork this repository.
2. In the Cloudflare dashboard, open **Workers & Pages → Create application → GitHub** and select your fork. Set the build command to `npm run build` and the deploy command to `npm run deploy`.
3. Open the site after deployment. The setup page checks bindings and secrets first; configure what it reports under the Worker's **Settings**:
   - **Database (choose one)**: for D1, add a database in **Bindings** with the variable name `DB`; for PostgreSQL, add the secret `DATABASE_URL` in **Variables and Secrets**. Without D1 the deployment uses PostgreSQL automatically.
   - **Setup key**: add the secret `ADMIN_TOKEN` in **Variables and Secrets** with a long random value, for example the output of `openssl rand -hex 32`.
   - **Optional**: for third-party themes, add an R2 bucket named `THEMES`; for raw observations and backfill, enable Analytics Engine and add a dataset named `UPTIME`.
4. Select **Re-check** on the setup page, continue to the next step, and enter `ADMIN_TOKEN` to create the administrator account.

Upgrades use **Sync fork** on GitHub; Workers Builds redeploys automatically and keeps the bindings added in the dashboard.

You can also deploy with the button below. It creates a new repository in your GitHub account (not a fork, so it cannot be updated with Sync fork); configure the database and secret as the setup page describes:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/XingLingQAQ/UptimePolaris)

See the [deployment guide](docs/deployment.md) for command-line deployment and PostgreSQL.

<a id="deploy-go"></a>

## Deploy the Go backend

Download the build for your system from [Releases](https://github.com/XingLingQAQ/UptimePolaris/releases), rename it to `polaris` (`polaris.exe` on Windows), and start it:

```sh
chmod +x polaris   # Linux / macOS
./polaris --data-dir ./data
```

```powershell
.\polaris.exe --data-dir .\data
```

The program listens on `127.0.0.1:8080` by default. For external access, change `--addr` or add a reverse proxy. All data lives in `./data`; keep that directory persistent, restrict access to it, and back it up regularly. See the [Go backend guide](backends/go/README.md#install-and-start) for more configuration.

## Monitor hosts

Add a machine on the console's Agent page, choose a platform and installation mode, then run the generated command on the target machine. The target must be able to reach GitHub.

After installation, manage the service with `pa` (short for `polaris-agent`):

```sh
pa status
pa restart
pa logs -f
```

- Installation commands contain the site address and that machine's token. Generate them from the production domain and never publish them.
- Adding a machine does not create a monitor. To watch online status or resource thresholds, add an Agent-type monitor on the monitor page.
- Manual installations have no service manager, so `pa start`, `stop`, and `restart` are unavailable.

See the [Agent guide](docs/agents.md) for more.

## Usage and public information

The status page is anonymous. Monitor names, target paths, and hostnames may appear on public pages and APIs, so never put internal addresses or secrets in them. See [public data](docs/usage.md#public-data) and the [notification guide](docs/notifications.md).

## Documentation

| Document | Contents |
| --- | --- |
| [Backend options](docs/backends.md) | Differences between Worker and Go |
| [Deployment](docs/deployment.md) | Fork, button, and manual deployment, domains, PostgreSQL, D1 to PostgreSQL |
| [Go backend](backends/go/README.md) | Flags, environment variables, SQLite to PostgreSQL |
| [Usage](docs/usage.md) | Monitor configuration, Push, status and availability |
| [Agent](docs/agents.md) | Installation, management, configuration, updates, removal |
| [Notifications](docs/notifications.md) | Channel settings, group scope, delivery records |
| [Themes](docs/themes.md) | Installation, configuration, preview |
| [Configuration](docs/configuration.md) | Bindings, environment variables, console settings |
| [API reference](docs/api.md) | Endpoints, authentication, examples |
| [Operations](docs/operations.md) | Backup, recovery, upgrades, retention |
| [Troubleshooting](docs/troubleshooting.md) | Diagnosis by symptom |

## License

This project is licensed under the [MIT License](LICENSE).
