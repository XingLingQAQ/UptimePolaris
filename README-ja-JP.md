<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/overview-ja-JP-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/overview-ja-JP-light.svg">
  <img src="assets/readme/overview-ja-JP-light.svg" width="100%" alt="Uptime Polaris：サービスの可用性とホストの監視">
</picture>

<a href="README.md">English</a> · <a href="README-zh-CN.md">简体中文</a> · <a href="README-zh-TW.md">繁體中文（台灣）</a> · <a href="README-zh-HK.md">繁體中文（香港）</a> · <strong>日本語</strong> · <a href="README-ko-KR.md">한국어</a> · <a href="README-fr-FR.md">Français</a> · <a href="README-pt-BR.md">Português (Brasil)</a> · <a href="README-ru-RU.md">Русский</a>

# Uptime Polaris - セルフホストのステータスページと稼働監視

Uptime Polaris は Web サイト、ポート、定期実行されるジョブを定期的にチェックし、サーバーの指標を収集して、状態が変わったときに通知を送ります。<br>
サーバーを用意せず Cloudflare Workers で動かすことも、自前のサーバーで Go バックエンドとして動かすこともできます。<br>
公開ステータスページと管理画面を備え、インターフェースは 9 言語に対応しています。

<p>
  <a href="https://developers.cloudflare.com/workers/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&amp;logo=cloudflare&amp;logoColor=white" height="20" alt="Cloudflare Workers で動作"></a>
  <a href="backends/go/README.md"><img src="https://img.shields.io/badge/Go-Backend-00ADD8?style=flat-square&amp;logo=go&amp;logoColor=white" height="20" alt="Go backend"></a>
  <a href="frontend/README.md"><img src="https://img.shields.io/badge/React-TypeScript-3178C6?style=flat-square&amp;logo=react&amp;logoColor=white" height="20" alt="フロントエンドは React と TypeScript を使用"></a>
  <a href="https://github.com/XingLingQAQ/polaris-agent"><img src="https://img.shields.io/badge/Rust-Agent-93450A?style=flat-square&amp;logo=rust&amp;logoColor=white" height="20" alt="Polaris Agent は Rust を使用"></a>
  <a href="docs/configuration.md"><img src="https://img.shields.io/badge/Storage-D1%20%2F%20SQLite%20%2F%20PostgreSQL-4169E1?style=flat-square&amp;logo=postgresql&amp;logoColor=white" height="20" alt="Storage: D1, SQLite, PostgreSQL"></a>
</p>

<p><a href="#機能">機能</a> · <a href="#デプロイ">デプロイ</a> · <a href="#クイックスタート">クイックスタート</a> · <a href="#ホストの監視">Agent</a> · <a href="#データと公開範囲">公開範囲</a> · <a href="#よくある質問">よくある質問</a> · <a href="#ドキュメント">ドキュメント</a></p>

</div>

## Uptime Polaris を選ぶ理由

- **サーバーを管理しなくてよい**：Cloudflare Workers にデプロイすると、チェック、通知、ステータスページはすべて Cloudflare 上で動きます。内部ネットワークを監視したい場合やチェック間隔を短くしたい場合は Go バックエンドに切り替えられ、どちらも同じインターフェースを使います。
- **状態は実際の結果にもとづく**：ページには実際のチェックや報告で得たデータだけを表示します。データがない箇所は待機として表示し、正常として埋めることはしません。
- **定期ジョブも監視できる**：バックアップスクリプトや cron ジョブが定刻にハートビートを送り、期限を過ぎても届かなければ異常として扱います。
- **サーバー指標**：`polaris-agent` が CPU、メモリ、ディスク、ロードアベレージ、ネットワークを報告します。到達できるホストから内部サービスのチェックも行えます。
- **2 種類の公開ページ**：監視ステータスページとマシンステータスページは別々で、それぞれにドメインを割り当てられます。メンテナンス中はどちらもメンテナンスページに切り替わります。
- **グループ単位の通知**：Telegram、Feishu、Slack、Discord、Webhook、Apprise、ServerChan に対応し、チャネルごとに担当するグループを指定できます。
- **データベースを選べる**：Worker は D1 または PostgreSQL、Go は SQLite または PostgreSQL を使い、既存データは PostgreSQL へ移行できます。

## 機能

### <img src="assets/readme/check.svg" width="20" height="20" alt=""> チェックとハートビート

- HTTP チェックではステータスコード、JSON のフィールド、レスポンスヘッダー、応答時間を検証できます。TCP チェックではポートへの接続を確認し、送信内容と応答の照合もできます。
- Go バックエンドは UDP、ICMP、DNS、TLS、WebSocket を直接チェックできます。Worker では UDP と ICMP を Agent 経由で実行します。
- 追加チェックとして SSL 証明書の期限、ドメインの期限、DNS レコードを確認できます。
- Push 監視には専用の URL が発行され、定期ジョブがそこへ POST します。期限を過ぎても届かなければ異常になります。
- 最短のチェック間隔は Worker が 60 秒、Go が 5 秒です。対象が内部ネットワークにしか公開されていない場合は、Agent をチェック元に指定します。

監視の種類と各項目は[使用ガイド](docs/usage.md)にまとめています。

### <img src="assets/readme/host.svg" width="20" height="20" alt=""> サーバー監視

- `polaris-agent` は Linux、macOS、Windows で CPU、メモリ、ディスク、ロードアベレージ、ネットワーク、マウントポイントを報告します。Linux では Docker も利用できます。
- リソースのルールはしきい値と継続時間で判定するため、続けて外れたときだけ通知します。回復はしきい値に対する割合で判定し、境界付近での通知の往復を抑えます。
- マシンステータスページは任意で有効にします。検索、絞り込み、地図表示に加え、2〜4 台の比較ができます。既定では無効で、公開するまでマシンは管理画面からのみ見えます。

インストール、管理、更新は [Agent ガイド](docs/agents.md)にまとめています。

### <img src="assets/readme/bell.svg" width="20" height="20" alt=""> ステータスページと通知

- ステータスページには現在の状態、稼働率、イベント履歴を表示します。グループ分けができ、公開に設定した監視だけが表示されます。
- メンテナンスウィンドウは 1 回だけ、または毎週繰り返す形で設定できます。開始前はページ上部に告知を表示し、実施中は自動通知を保留します。
- チャネルごとにメッセージの言語と担当グループを設定できます。管理画面には送信成功、プロバイダーによる拒否、ネットワークタイムアウトを区別した配信記録が残ります。

チャネルの設定とグループの範囲は[通知ガイド](docs/notifications.md)にまとめています。

### <img src="assets/readme/layers.svg" width="20" height="20" alt=""> ストレージとテーマ

- Worker は D1 または PostgreSQL、Go は SQLite または PostgreSQL を使います。D1 と SQLite のデータはどちらも PostgreSQL へ移行できます。
- 公開ページにはサードパーティ製テーマを導入できます。ZIP のアップロードかダウンロード URL で追加し、適用前にプレビューできます。テーマは Worker では R2、Go ではデータディレクトリに保存されます。
- テーマを導入していない場合は組み込みのデザインを使います。管理画面は常に組み込みのインターフェースです。

テーマの導入と作成は[テーマガイド](docs/themes.md)にまとめています。

### その他

- **コマンドパレット**：管理画面で `Ctrl+K`（macOS は `⌘K`）を押すと、ページ、監視、Agent を検索できます。
- **ステータスのポップオーバー**：管理画面の上部に異常のある監視とオフラインの Agent をまとめ、一時停止、今すぐチェック、概要のコピーができます。
- **API**：管理用のエンドポイントはベアラートークンで認証でき、スクリプトから監視を作成・管理できます。[API リファレンス](docs/api.md)を参照してください。
- **表示言語**：簡体字中国語、繁体字中国語（台湾、香港）、英語、日本語、韓国語、フランス語、ポルトガル語、ロシア語。

## デプロイ

デプロイごとにどちらか一方のバックエンドを選びます。どちらも同じインターフェースを使います。

| | Cloudflare Worker | Go |
| --- | --- | --- |
| 実行環境 | Cloudflare | 自前のサーバーまたはコンテナ |
| データベース | D1 または PostgreSQL | SQLite または PostgreSQL |
| 直接のチェック | HTTP、TCP（UDP と ICMP は Agent 経由） | HTTP、TCP、UDP、ICMP、DNS、TLS、WebSocket |
| 最短のチェック間隔 | 60 秒 | 5 秒 |
| テーマの保存先 | R2（任意） | データディレクトリ |

サーバーを管理したくない場合は Worker を選んでください。内部サービスを監視したい場合、より多くのプロトコルが必要な場合、チェック間隔を短くしたい場合は Go を選びます。詳しい比較は[バックエンドの選択](docs/backends.md)にあります。

### Cloudflare へのデプロイ

1. このリポジトリを fork します。
2. Cloudflare のダッシュボードで **Workers & Pages → Create application → GitHub** を開き、fork したリポジトリを選びます。ビルドコマンドに `npm run build`、デプロイコマンドに `npm run deploy` を指定します。
3. デプロイが終わったらサイトを開きます。セットアップページが最初にバインディングとシークレットを確認するので、表示に従って Worker の **Settings** で次を設定します。
   - **D1（任意）**：D1 を使う場合は **Bindings** でデータベースを追加し、変数名を `DB` にします。D1 をバインドしない場合、初期設定では PostgreSQL のみ選択できます。
   - **KV（必須）**: **Bindings** で変数名 `CONFIG` の KV 名前空間を追加します。データベースの選択と暗号化した接続 URL を保存します。
   - **初期設定キー**：**Variables and Secrets** で Secret `ADMIN_TOKEN` を追加します。値には `openssl rand -hex 32` の出力など、十分に長いランダムな文字列を使います。
   - **Analytics Engine（必須）**：ダッシュボードで Analytics Engine を有効にし、**Bindings** でデータセットを追加して、変数名を `UPTIME` にします。
   - **R2（任意）**：サードパーティ製テーマを使う場合に必要です。**Bindings** でバケットを追加し、変数名を `THEMES` にします。セットアップ後に追加してもかまいません。
4. 初期設定ページで「再確認」を押します。必須項目を通過したら、`ADMIN_TOKEN` を入力してデータベースを設定・検証し、管理者アカウントを作成します。

下のボタンからもデプロイできます。このボタンは fork ではなく、あなたの GitHub アカウントに新しいリポジトリを作成するため、後から Sync fork で更新することはできません。データベースとシークレットはセットアップページの案内に従って設定します。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/XingLingQAQ/UptimePolaris)

コマンドラインからのデプロイと PostgreSQL の設定は[デプロイガイド](docs/deployment.md)にまとめています。

<a id="deploy-go"></a>

### Go バックエンドのデプロイ

[Releases](https://github.com/XingLingQAQ/UptimePolaris/releases)から環境に合ったビルドをダウンロードし、`polaris`(`polaris.exe` は Windows)に名前を変えて起動します。

```sh
chmod +x polaris   # Linux / macOS
./polaris --data-dir ./data
```

```powershell
.\polaris.exe --data-dir .\data
```

既定では `127.0.0.1:8080` で待ち受けます。外部からアクセスする場合は `--addr` を変更するか、リバースプロキシを置いてください。データはすべて `./data` に保存されるため、永続化、アクセス権限の制限、定期的なバックアップが必要です。起動オプションと環境変数は [Go バックエンドガイド](backends/go/README.md#install-and-start)にまとめています。

## クイックスタート

1. サイトの `/setup` を開きます。Worker はバインディングとシークレットを確認してから `ADMIN_TOKEN` を求めます。Go では起動ログに表示されるセットアップキーを入力します。続けて管理者アカウントを作成します。
2. `/admin` に移動し、**監視項目**で監視を追加します。たとえば HTTP を選び、`https://example.com/health` を入力して保存し、「今すぐチェック」を選びます。
3. **通知**でチャネルを追加し、テストメッセージを送ります。
4. ログインしていないブラウザーでサイトのトップページを開き、ステータスページの表示を確認します。

初回ログイン時の概要ページには、監視の追加、サイト名の設定、通知の設定、Agent の接続という「はじめに」のチェックリストが表示されます。

## ホストの監視

管理画面の **Agent 管理**でマシンを追加し、プラットフォームとインストール方法を選んで、生成されたコマンドを対象のマシンで実行します。そのマシンから GitHub にアクセスできる必要があります。

インストール後は `pa`(`polaris-agent` の短縮形)でサービスを管理できます。

```sh
pa status
pa restart
pa logs -f
```

- インストールコマンドにはサイトの URL とそのマシンのトークンが含まれます。実際のドメインで生成し、公開しないでください。
- マシンを追加しても監視は作成されません。**監視項目**で「Agent ホスト」の監視を追加してください。
- 手動インストールにはサービス管理の仕組みがないため、`pa start`、`stop`、`restart` は使えません。

インストール方法とプラットフォームごとの違いは [Agent ガイド](docs/agents.md)にまとめています。

## アップグレードとアンインストール

### アップグレード

先にデータベースをバックアップしてください。手順の全体は[運用ガイド](docs/operations.md)にあります。

- **Cloudflare**：fork した場合は GitHub で Sync fork を実行すると、Workers Builds が自動的に再デプロイし、ダッシュボードで追加したバインディングも維持されます。デプロイボタンで作成した場合は、生成されたリポジトリに新しいバージョンをマージします。
- **Go**：サービスを停止してデータディレクトリをバックアップし、バイナリを差し替えて同じデータディレクトリで起動します。
- **Agent**：マシン上で `pa update` を実行します。管理されたインストールでは管理画面から自動更新を有効にできますが、既定では無効です。

### アンインストール

- **Cloudflare**：ダッシュボードで Worker を削除します。D1 データベース、R2 バケット、PostgreSQL データベースは削除されないため、不要であれば別途削除してください。
- **Go**：サービスを停止し、バイナリとデータディレクトリを削除します。PostgreSQL を使っている場合はそのデータベースも削除します。
- **Agent**：サイトからインストールスクリプトを取得し、アンインストーラーを実行します。

  ```sh
  curl -fsSL 'https://status.example.com/install.sh' -o install.sh
  sh install.sh --uninstall
  ```

  Windows の手順は [Agent ガイド](docs/agents.md)を参照してください。Agent をアンインストールしても、管理画面の監視は削除されません。

## データと公開範囲

- データは自分のデプロイ内に残ります。Worker は Cloudflare アカウントの D1 または自分の PostgreSQL、Go はデータディレクトリの SQLite または自分の PostgreSQL を使います。
- ステータスページと公開 API はログインなしでアクセスできます。監視名、HTTP ターゲットのホストとパス、TCP ターゲットのホストとポートは公開されるため、内部アドレスやシークレットを入れないでください。
- HTTP ターゲットのユーザー名、パスワード、クエリ文字列は取り除かれます。認証情報と Agent トークンが公開されることはありません。
- Push URL のトークンはその監視の報告用の資格情報です。公開しないでください。
- 公開したくない監視は、監視一覧で「ステータスページから隠す」を選ぶと管理画面からのみ見えるようになります。
- Worker の SSL チェックは公開の証明書透明性ログを照会します。Agent は起動時にマシンのグローバル IP の地域を照会し、更新時に GitHub へアクセスします。

公開ページと API が返す項目は[公開データ](docs/usage.md)にまとめています。

## よくある質問

**セットアップページがデプロイチェックで止まり、先に進めません。**
Worker の **Settings** で必須の `ADMIN_TOKEN` と `UPTIME` を設定し、保存してデプロイ後に「再チェック」を選んでください。D1 と R2 は任意です。D1 が未バインドの場合は、次の手順で PostgreSQL 接続を設定します。

**Push URL をブラウザーで開いてもデータがありません。**
ブラウザーは GET を送りますが、Push は POST のみ受け付けるため GET は 405 を返します。`curl -X POST` を使うか、定期ジョブから POST してください。

**通知テストは成功するのに、障害時に届きません。**
チャネルが有効か、グループの範囲にその監視が含まれるか、メンテナンスウィンドウ中でないかを確認してください。グループを 1 つも選んでいないチャネルはすべての監視を受け取ります。

**Agent がオフラインと表示されます。**
マシン上で `pa status` と `pa logs -f` を実行し、サービスが動いていてサイトのドメインに到達できることを確認してください。既定では 60 秒ごとに報告し、約 3 分届かないとオフラインになります。

その他の事例は[トラブルシューティング](docs/troubleshooting.md)にまとめています。解決しない場合は [Issues](https://github.com/XingLingQAQ/UptimePolaris/issues) で報告してください。

## ドキュメント

| ドキュメント | 内容 |
| --- | --- |
| [バックエンドの選択](docs/backends.md) | Worker と Go の違い |
| [デプロイガイド](docs/deployment.md) | fork デプロイ、デプロイボタン、手動デプロイ、ドメイン、PostgreSQL、D1 から PostgreSQL への移行 |
| [Go バックエンド](backends/go/README.md) | 起動オプション、環境変数、SQLite から PostgreSQL への移行 |
| [使用ガイド](docs/usage.md) | 管理画面、監視の設定、Push、ステータスページ、メンテナンスウィンドウ、アカウントとセキュリティ |
| [Agent ガイド](docs/agents.md) | インストール、管理、設定、更新、アンインストール |
| [通知ガイド](docs/notifications.md) | チャネルの設定、グループの範囲、配信記録 |
| [テーマガイド](docs/themes.md) | 導入、設定、プレビュー |
| [設定リファレンス](docs/configuration.md) | バインディング、環境変数、管理画面の設定 |
| [API リファレンス](docs/api.md) | エンドポイント、認証、例 |
| [運用ガイド](docs/operations.md) | バックアップ、復元、アップグレード、データ保持 |
| [トラブルシューティング](docs/troubleshooting.md) | 症状別の切り分け |

## ライセンス

Uptime Polaris は [MIT ライセンス](LICENSE)で公開されています。
