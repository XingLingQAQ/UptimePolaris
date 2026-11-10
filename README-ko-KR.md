<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/overview-ko-KR-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/readme/overview-ko-KR-light.svg">
    <img src="assets/readme/overview-ko-KR-light.svg" width="100%" alt="Uptime Polaris: 서비스 가용성 및 호스트 모니터링">
  </picture>
</h1>

<p align="center"><strong>HTTP/TCP 검사, Push 하트비트, 호스트 지표</strong><br>Cloudflare Worker 또는 자체 호스팅 Go 서버에서 실행됩니다.</p>

Worker는 D1 / PostgreSQL, Go는 SQLite / PostgreSQL을 사용하며 프런트엔드는 공유합니다. [Go 시작하기](backends/go/README.md).

<p align="center">
  <a href="README.md">English</a> · <a href="README-zh-CN.md">简体中文</a> · <a href="README-zh-TW.md">繁體中文（台灣）</a> · <a href="README-zh-HK.md">繁體中文（香港）</a> · <a href="README-ja-JP.md">日本語</a> · <strong>한국어</strong> · <a href="README-fr-FR.md">Français</a> · <a href="README-pt-BR.md">Português (Brasil)</a> · <a href="README-ru-RU.md">Русский</a>
</p>

<p align="center">
  <a href="https://developers.cloudflare.com/workers/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&amp;logo=cloudflare&amp;logoColor=white" height="20" alt="Cloudflare Workers에서 실행"></a>
  <a href="backends/go/README.md"><img src="https://img.shields.io/badge/Go-Backend-00ADD8?style=flat-square&amp;logo=go&amp;logoColor=white" height="20" alt="Go backend"></a>
  <a href="frontend/README.md"><img src="https://img.shields.io/badge/React-TypeScript-3178C6?style=flat-square&amp;logo=react&amp;logoColor=white" height="20" alt="React와 TypeScript로 만든 프런트엔드"></a>
  <a href="agent/README.md"><img src="https://img.shields.io/badge/Rust-Agent-93450A?style=flat-square&amp;logo=rust&amp;logoColor=white" height="20" alt="Rust로 만든 Polaris Agent"></a>
  <a href="docs/configuration.md"><img src="https://img.shields.io/badge/Storage-D1%20%2F%20SQLite%20%2F%20PostgreSQL-4169E1?style=flat-square&amp;logo=postgresql&amp;logoColor=white" height="20" alt="Storage: D1, SQLite, PostgreSQL"></a>
</p>

<p align="center">
  <a href="#빠른-시작">빠른 시작</a> · <a href="#cloudflare에-배포">배포</a> · <a href="#deploy-go">Go 배포</a> · <a href="#호스트-모니터링">Agent</a> · <a href="#문서">문서</a>
</p>

Uptime Polaris는 공개 상태 페이지, 관리 콘솔, 예약 검사를 하나의 애플리케이션으로 제공합니다. HTTP/TCP 검사를 실행하고, Push 하트비트를 받고, `polaris-agent`로 호스트 지표를 수집하며, 모니터 상태가 바뀌면 알림을 보냅니다.

## 백엔드 선택

배포마다 백엔드 하나를 고릅니다. Go는 Cloudflare 계정, D1, R2가 필요 없습니다.

저장: Worker는 D1 또는 PostgreSQL을 쓰고 테마 자산은 R2에 둡니다. Go는 SQLite 또는 PostgreSQL을 쓰고 데이터와 테마를 데이터 디렉터리에 저장합니다. 프로브: Go는 UDP, ICMP, DNS, TLS, WebSocket을 직접 실행합니다. Worker는 이를 직접 실행할 수 없고 UDP와 ICMP는 온라인 Agent에 맡깁니다.

[백엔드 비교 및 시작 방법](docs/backends.md)

## 주요 기능

<p align="center">
  <img src="assets/readme/check.svg" width="24" height="24" alt="서비스 검사 아이콘"><br>
  <strong>서비스 검사와 하트비트</strong><br>
  HTTP와 TCP 검사에 응답, 인증서, 도메인, DNS 판정을 추가할 수 있습니다. Push 모니터는 예약 작업이 보내는 하트비트를 받습니다.
</p>

<p align="center">
  <img src="assets/readme/host.svg" width="24" height="24" alt="호스트 모니터링 아이콘"><br>
  <strong>호스트 지표와 프로브</strong><br>
  <code>polaris-agent</code>가 CPU, 메모리, 디스크, 네트워크 지표를 보고합니다. 호스트에서 HTTP/TCP 검사를 실행할 수도 있습니다.
</p>

<p align="center">
  <img src="assets/readme/bell.svg" width="24" height="24" alt="상태 알림 아이콘"><br>
  <strong>상태 페이지와 알림</strong><br>
  공개 페이지에는 현재 상태와 이벤트 기록이 표시됩니다. 표시 범위와 알림 대상은 그룹, 유지보수 시간대, 알림 채널이 결정합니다.
</p>

<p align="center">
  <img src="assets/readme/layers.svg" width="24" height="24" alt="저장소와 테마 아이콘"><br>
  <strong>저장소와 테마</strong><br>
  Worker는 데이터를 D1 또는 PostgreSQL, 테마 자산을 R2에 저장합니다. Go는 데이터를 SQLite 또는 PostgreSQL, 테마를 데이터 디렉터리에 저장합니다.
</p>

Push 모니터는 지연 시간을 측정하지 않으며 공개 지연 필드는 `null`입니다. 백엔드별 프로브 종류는 [백엔드 비교](docs/backends.md)에 있습니다. 설정과 제한은 [사용 안내서](docs/usage.md)를 참고하세요.

## 빠른 시작

백엔드를 골라 해당 가이드대로 배포하세요. `/setup`에서 관리자 계정을 만들고 `/admin`에서 첫 모니터를 추가하세요.

### Cloudflare Worker

[Cloudflare에 배포](#cloudflare에-배포)

### Go

Go 실행 파일에는 웹 화면이 포함됩니다. Releases에서 운영체제에 맞는 파일을 내려받아 [Go 안내서](backends/go/README.md#english)대로 시작하세요.

## Cloudflare에 배포

[![Cloudflare에 배포](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/XingLingQAQ/UptimePolaris)

버튼은 저장소를 포크하고 배포를 시작합니다. Worker와 데이터베이스에 새 이름을 지정하고 `ADMIN_TOKEN`에 긴 임의 값을 넣어 Worker Secret으로 저장하세요. 데이터베이스 ID가 없으면 Cloudflare에서 D1 데이터베이스를 찾거나 만들고, 포크한 `wrangler.jsonc`의 `database_id` 자리 표시자를 실제 ID로 바꾼 뒤 다시 배포하세요. 자세한 단계는 [배포 안내서](docs/deployment.md#通过-cloudflare-按钮部署)에 있습니다.

버튼 템플릿은 D1, 정적 자산, 스케줄만 바인딩합니다. R2 테마와 Analytics Engine은 포함되지 않습니다. Agent 설치에는 GitHub Release 다운로드 접근 권한이 필요합니다.

<a id="deploy-go"></a>

## Go 백엔드 배포

프로젝트 [Releases](https://github.com/XingLingQAQ/UptimePolaris/releases)에서 운영체제에 맞는 파일을 내려받아 [Go 설치 안내서](backends/go/README.md#install-and-start)대로 시작하세요. 웹 화면은 바이너리에 포함됩니다. 데이터 디렉터리는 영구 저장하고 접근 권한을 제한하세요. 백업은 데이터베이스를 포함해 디렉터리 전체를 받으세요.

## 호스트 모니터링

콘솔 Agent 페이지에서 머신을 만들고 플랫폼과 설치 모드를 고른 뒤 생성된 명령을 대상 머신에서 실행하세요. 설치 프로그램은 해당 플랫폼의 최신 안정 버전을 내려받습니다.

설치 프로그램은 `polaris-agent` 서비스와 `pa` 명령을 등록합니다. 둘 다 같은 프로그램, 설정, 서비스를 다룹니다.

```sh
pa status
pa restart
pa logs -f
```

`pa start`, `stop`, `restart`에는 서비스 관리자가 필요합니다. 수동 설치에서는 포그라운드로 실행합니다. `pa logs`는 설치가 만든 로그 파일을 읽습니다. 설치 명령에는 현재 사이트의 프로토콜, 도메인, 포트가 들어가므로 오래 쓸 주소에서 생성하세요. 설치 모드, 플랫폼 제한, 설정, 업데이트, 제거는 [Agent 안내서](docs/agents.md)에 있습니다.

## 사용과 공개 정보

공개 상태 페이지는 익명으로 볼 수 있습니다. 모니터를 추가하기 전에 이름, 대상 경로, 호스트 이름, 내부 주소에 민감한 정보가 없는지 확인하세요. 공개 API는 인증 정보를 제거하지만 이름이나 경로에 민감한 내용이 있는지는 검사하지 않습니다. 자세한 내용은 [공개 데이터 설명](docs/usage.md#公开数据)을 참고하세요.

알림 채널은 Telegram, Feishu, Slack, Discord, Webhook, Apprise, Server酱입니다. 채널은 모니터 그룹 단위로 범위를 제한할 수 있습니다. 설정과 전송 문제 해결은 [알림 안내서](docs/notifications.md)에 있습니다.

## 문서

| 원하는 작업 | 문서 |
| --- | --- |
| 사이트 배포, 도메인 또는 PostgreSQL 설정 | [배포 안내서](docs/deployment.md) |
| 백엔드 비교 | [Worker / Go](docs/backends.md#english) · [Go](backends/go/README.md#english) |
| 모니터 생성, 상태와 공개 데이터 확인 | [사용 안내서](docs/usage.md) |
| 호스트 Agent 설치 및 관리 | [Agent 안내서](docs/agents.md) |
| 바인딩, 환경 변수와 관리 설정 구성 | [설정 참조](docs/configuration.md) |
| 알림 채널과 범위 설정 | [알림 안내서](docs/notifications.md) |
| 상태 페이지 테마 설치 또는 설정 | [테마 안내서](docs/themes.md#english) |
| API 호출 또는 Push 연동 | [API 참조](docs/api.md) |
| 백업, 업그레이드와 문제 해결 | [운영 안내서](docs/operations.md) · [자주 묻는 질문](docs/troubleshooting.md) |

전체 색인: [docs/README.md](docs/README.md).

## 라이선스

이 프로젝트는 [MIT 라이선스](LICENSE)로 배포됩니다.
