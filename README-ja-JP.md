<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/overview-ja-JP-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/readme/overview-ja-JP-light.svg">
    <img src="assets/readme/overview-ja-JP-light.svg" width="100%" alt="Uptime Polaris：サービスの可用性とホストの監視">
  </picture>
</h1>

<p align="center"><strong>HTTP/TCP チェック、Push ハートビート、ホスト指標</strong><br>Cloudflare Worker またはセルフホストの Go サーバーで動作します。</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README-zh-CN.md">简体中文</a> · <a href="README-zh-TW.md">繁體中文（台灣）</a> · <a href="README-zh-HK.md">繁體中文（香港）</a> · <strong>日本語</strong> · <a href="README-ko-KR.md">한국어</a> · <a href="README-fr-FR.md">Français</a> · <a href="README-pt-BR.md">Português (Brasil)</a> · <a href="README-ru-RU.md">Русский</a>
</p>

<p align="center">
  <a href="https://developers.cloudflare.com/workers/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&amp;logo=cloudflare&amp;logoColor=white" height="20" alt="Cloudflare Workers で動作"></a>
  <a href="backends/go/README.md"><img src="https://img.shields.io/badge/Go-Backend-00ADD8?style=flat-square&amp;logo=go&amp;logoColor=white" height="20" alt="Go backend"></a>
  <a href="frontend/README.md"><img src="https://img.shields.io/badge/React-TypeScript-3178C6?style=flat-square&amp;logo=react&amp;logoColor=white" height="20" alt="フロントエンドは React と TypeScript を使用"></a>
  <a href="https://github.com/XingLingQAQ/polaris-agent"><img src="https://img.shields.io/badge/Rust-Agent-93450A?style=flat-square&amp;logo=rust&amp;logoColor=white" height="20" alt="Polaris Agent は Rust を使用"></a>
  <a href="docs/configuration.md"><img src="https://img.shields.io/badge/Storage-D1%20%2F%20SQLite%20%2F%20PostgreSQL-4169E1?style=flat-square&amp;logo=postgresql&amp;logoColor=white" height="20" alt="Storage: D1, SQLite, PostgreSQL"></a>
</p>

<p align="center">
  <a href="#クイックスタート">クイックスタート</a> · <a href="#cloudflare-へのデプロイ">デプロイ</a> · <a href="#deploy-go">Go のデプロイ</a> ·
  <a href="#ホストの監視">Agent</a> ·
  <a href="#ドキュメント">ドキュメント</a>
</p>

Uptime Polaris は、Web サイトとポートを定期的にチェックし、スケジュールタスクからのハートビートを受け取り、サーバーの CPU、メモリ、ディスク指標を収集し、監視の状態が変わると通知を送ります。公開ステータスページと管理コンソールが付属します。

## バックエンドを選ぶ

デプロイごとにどちらか一方を使います。どちらも同じ画面を提供します。

| | Cloudflare Worker | Go |
| --- | --- | --- |
| 実行環境 | Cloudflare | 自前のサーバーまたはコンテナ |
| データベース | D1 または PostgreSQL | SQLite または PostgreSQL |
| 直接プローブ | HTTP、TCP（UDP、ICMP は Agent 経由） | HTTP、TCP、UDP、ICMP、DNS、TLS、WebSocket |
| 最短チェック間隔 | 60 秒 | 5 秒 |
| テーマファイル | R2（任意） | データディレクトリ |

サーバーを保守したくない場合は Worker を使用してください。内部ネットワークのプローブ、より多くのプロトコル、短いチェック間隔が必要な場合は Go を選びます。詳しくは[バックエンドの比較](docs/backends.md)を参照してください。

## 機能

<p align="center">
  <img src="assets/readme/check.svg" width="24" height="24" alt="サービスチェックのアイコン"><br>
  <strong>サービスチェックとハートビート</strong><br>
  HTTP と TCP のチェックに加え、レスポンス内容、証明書、ドメイン有効期限、DNS の判定を設定できます。Push 監視は cron やバックアップスクリプト向けで、設定時間を超えてハートビートが届かないと異常と判定します。
</p>

<p align="center">
  <img src="assets/readme/host.svg" width="24" height="24" alt="ホスト監視のアイコン"><br>
  <strong>サーバー監視</strong><br>
  <code>polaris-agent</code> が CPU、メモリ、ディスク、負荷、ネットワーク指標を送信します。ホストから HTTP/TCP チェックを実行し、内部サービスをプローブすることもできます。
</p>

<p align="center">
  <img src="assets/readme/bell.svg" width="24" height="24" alt="状態通知のアイコン"><br>
  <strong>ステータスページと通知</strong><br>
  ステータスページには現在の状態とイベント履歴が表示され、グループとメンテナンス期間に対応します。通知先は Telegram、Feishu、Slack、Discord、Webhook、Apprise、Server酱 で、チャネルごとに担当する監視グループを限定できます。
</p>

<p align="center">
  <img src="assets/readme/layers.svg" width="24" height="24" alt="ストレージとテーマのアイコン"><br>
  <strong>ストレージとテーマ</strong><br>
  Worker はデータを D1 または PostgreSQL、テーマを R2 に保存します。Go はデータを SQLite または PostgreSQL、テーマをデータディレクトリに保存します。
</p>

## クイックスタート

1. [Cloudflare](#cloudflare-へのデプロイ)または[自前のサーバー](#deploy-go)へデプロイします。
2. サイトの `/setup` を開きます。Worker はバインディングとシークレットを先に確認し、Go は起動ログの初期設定キーを入力します。
3. 管理者アカウントを作成し、`/admin` で監視を追加します。

## Cloudflare へのデプロイ

1. このリポジトリを Fork します。
2. Cloudflare ダッシュボードで **Workers & Pages → Create application → GitHub** を開き、fork したリポジトリを選択します。ビルドコマンドに `npm run build`、デプロイコマンドに `npm run deploy` を設定します。
3. デプロイ後にサイトを開きます。初期設定ページがバインディングとシークレットを確認するので、Worker の **Settings** で以下を設定します。
   - **データベース（どちらか一方）**: D1 を使う場合は **Bindings** で変数名 `DB` のデータベースを追加します。PostgreSQL を使う場合は **Variables and Secrets** で Secret `DATABASE_URL` を追加します。D1 をバインドしていない場合は自動的に PostgreSQL として扱われます。
   - **初期設定キー**: **Variables and Secrets** で Secret `ADMIN_TOKEN` を追加し、十分に長いランダムな値（例: `openssl rand -hex 32` の出力）を設定します。
   - **Analytics Engine（必須）**: ダッシュボードで Analytics Engine を有効にし、**Bindings** でデータセットを追加してバインド名を `UPTIME` にします。
   - **任意**: 外部テーマを使う場合は、バインド名 `THEMES` で R2 バケットを追加します。初期設定後でも追加できます。
4. 初期設定ページで「再確認」を押し、次へ進んで `ADMIN_TOKEN` を入力し、管理者アカウントを作成します。

更新は GitHub の Sync fork だけで完了します。Workers Builds が自動で再デプロイし、ダッシュボードで追加したバインディングも保持されます。

下のボタンでもデプロイできます。ボタンによるデプロイは GitHub アカウントに新しいリポジトリを作成するため（fork ではないので Sync fork で更新できません）、データベースとシークレットは初期設定ページの案内に従って設定してください。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/XingLingQAQ/UptimePolaris)

コマンドラインでのデプロイと PostgreSQL の設定は[デプロイガイド](docs/deployment.md)を参照してください。

<a id="deploy-go"></a>

## Go バックエンドのデプロイ

[Releases](https://github.com/XingLingQAQ/UptimePolaris/releases) から OS とアーキテクチャに合うファイルを取得し、`polaris`（Windows では `polaris.exe`）に名前を変更して起動します。

```sh
chmod +x polaris   # Linux / macOS
./polaris --data-dir ./data
```

```powershell
.\polaris.exe --data-dir .\data
```

既定では `127.0.0.1:8080` で待ち受けます。外部からアクセスする場合は `--addr` を変更するか、リバースプロキシを設定してください。データはすべて `./data` に保存されるため、このディレクトリを永続化し、アクセス権を制限し、定期的にバックアップしてください。詳しい設定は [Go バックエンドの説明](backends/go/README.md#install-and-start)を参照してください。

## ホストの監視

管理コンソールの Agent ページでマシンを追加し、プラットフォームとインストール方法を選び、生成されたコマンドを対象マシンで実行します。対象マシンは GitHub にアクセスできる必要があります。

インストール後は `pa`（`polaris-agent` の短縮コマンド）でサービスを管理できます。

```sh
pa status
pa restart
pa logs -f
```

- インストールコマンドにはサイトのアドレスとそのマシンの Token が含まれます。本番ドメインで生成し、公開しないでください。
- マシンを追加しても監視は作成されません。オンライン状態やリソースしきい値を監視するには、監視ページで Agent タイプの監視を追加してください。
- 手動インストールにはサービスマネージャーがないため、`pa start`、`stop`、`restart` は使用できません。

詳しくは [Agent ガイド](docs/agents.md)を参照してください。

## 利用と公開情報

ステータスページはログインなしで閲覧できます。監視名、対象パス、ホスト名は公開ページや公開 API に表示されることがあるため、内部アドレスやシークレットを記載しないでください。詳細は[公開データ](docs/usage.md#公开数据)と[通知ガイド](docs/notifications.md)を参照してください。

## ドキュメント

| ドキュメント | 内容 |
| --- | --- |
| [バックエンドの比較](docs/backends.md) | Worker と Go の違い |
| [デプロイガイド](docs/deployment.md) | Fork、ボタン、手動デプロイ、ドメイン、PostgreSQL、D1 から PostgreSQL への移行 |
| [Go バックエンド](backends/go/README.md) | 起動オプション、環境変数、SQLite から PostgreSQL への移行 |
| [利用ガイド](docs/usage.md) | 監視設定、Push、状態と可用性 |
| [Agent ガイド](docs/agents.md) | インストール、管理、設定、更新、アンインストール |
| [通知ガイド](docs/notifications.md) | チャネル設定、グループ範囲、配信記録 |
| [テーマガイド](docs/themes.md) | インストール、設定、プレビュー |
| [設定リファレンス](docs/configuration.md) | バインディング、環境変数、コンソール設定 |
| [API リファレンス](docs/api.md) | エンドポイント、認証、例 |
| [運用ガイド](docs/operations.md) | バックアップ、復旧、アップグレード、データ保持 |
| [よくある質問](docs/troubleshooting.md) | 症状別のトラブルシューティング |

## ライセンス

このプロジェクトは [MIT ライセンス](LICENSE)の下で公開されています。
