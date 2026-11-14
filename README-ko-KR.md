<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/overview-ko-KR-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/overview-ko-KR-light.svg">
  <img src="assets/readme/overview-ko-KR-light.svg" width="100%" alt="Uptime Polaris: 서비스 가용성 및 호스트 모니터링">
</picture>

<a href="README.md">English</a> · <a href="README-zh-CN.md">简体中文</a> · <a href="README-zh-TW.md">繁體中文（台灣）</a> · <a href="README-zh-HK.md">繁體中文（香港）</a> · <a href="README-ja-JP.md">日本語</a> · <strong>한국어</strong> · <a href="README-fr-FR.md">Français</a> · <a href="README-pt-BR.md">Português (Brasil)</a> · <a href="README-ru-RU.md">Русский</a>

# Uptime Polaris - 셀프호스팅 상태 페이지와 가동률 모니터링

Uptime Polaris는 웹사이트, 포트, 예약 작업을 주기적으로 확인하고 서버 지표를 수집하며, 상태가 바뀌면 알림을 보냅니다.<br>
서버를 따로 관리하지 않고 Cloudflare Workers에 배포하거나, 직접 운영하는 서버에서 Go 백엔드로 실행할 수 있습니다.<br>
공개 상태 페이지와 관리 콘솔이 함께 제공되며, 인터페이스는 9개 언어를 지원합니다.

<p>
  <a href="https://developers.cloudflare.com/workers/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&amp;logo=cloudflare&amp;logoColor=white" height="20" alt="Cloudflare Workers에서 실행"></a>
  <a href="backends/go/README.md"><img src="https://img.shields.io/badge/Go-Backend-00ADD8?style=flat-square&amp;logo=go&amp;logoColor=white" height="20" alt="Go backend"></a>
  <a href="frontend/README.md"><img src="https://img.shields.io/badge/React-TypeScript-3178C6?style=flat-square&amp;logo=react&amp;logoColor=white" height="20" alt="React와 TypeScript로 만든 프런트엔드"></a>
  <a href="https://github.com/XingLingQAQ/polaris-agent"><img src="https://img.shields.io/badge/Rust-Agent-93450A?style=flat-square&amp;logo=rust&amp;logoColor=white" height="20" alt="Rust로 만든 Polaris Agent"></a>
  <a href="docs/configuration.md"><img src="https://img.shields.io/badge/Storage-D1%20%2F%20SQLite%20%2F%20PostgreSQL-4169E1?style=flat-square&amp;logo=postgresql&amp;logoColor=white" height="20" alt="Storage: D1, SQLite, PostgreSQL"></a>
</p>

<p><a href="#기능">기능</a> · <a href="#배포">배포</a> · <a href="#빠른-시작">빠른 시작</a> · <a href="#호스트-모니터링">Agent</a> · <a href="#데이터와-공개-범위">공개 범위</a> · <a href="#자주-묻는-질문">자주 묻는 질문</a> · <a href="#문서">문서</a></p>

</div>

## Uptime Polaris를 선택하는 이유

- **서버를 관리하지 않아도 됩니다**: Cloudflare Workers에 배포하면 검사, 알림, 상태 페이지가 모두 Cloudflare에서 동작합니다. 내부 네트워크를 확인하거나 검사 주기를 줄여야 할 때는 Go 백엔드로 바꿀 수 있고, 두 백엔드는 같은 인터페이스를 씁니다.
- **상태는 실제 결과에서 나옵니다**: 페이지에는 실제 검사와 보고로 얻은 데이터만 표시합니다. 데이터가 없으면 대기로 표시하며, 빈 구간을 정상으로 채우지 않습니다.
- **예약 작업도 감시합니다**: 백업 스크립트와 cron 작업이 제때 하트비트를 보내고, 정해진 시간 안에 오지 않으면 장애로 처리합니다.
- **서버 지표**: `polaris-agent`가 CPU, 메모리, 디스크, 부하, 네트워크를 보고하며, 접근할 수 있는 호스트에서 내부 서비스도 확인할 수 있습니다.
- **두 가지 공개 페이지**: 모니터 상태 페이지와 머신 상태 페이지가 분리되어 있고 각각 도메인을 지정할 수 있습니다. 유지보수 중에는 둘 다 유지보수 페이지로 바뀝니다.
- **그룹별 알림**: Telegram, Feishu, Slack, Discord, Webhook, Apprise, ServerChan을 지원하며, 채널마다 담당할 그룹을 지정할 수 있습니다.
- **데이터베이스 선택**: Worker는 D1 또는 PostgreSQL, Go는 SQLite 또는 PostgreSQL을 사용하며, 기존 데이터는 PostgreSQL로 옮길 수 있습니다.

## 기능

### <img src="assets/readme/check.svg" width="20" height="20" alt=""> 검사와 하트비트

- HTTP 검사는 상태 코드, JSON 필드, 응답 헤더, 응답 시간을 확인합니다. TCP 검사는 포트 연결을 확인하고, 내용을 보내 응답을 비교할 수도 있습니다.
- Go 백엔드는 UDP, ICMP, DNS, TLS, WebSocket도 직접 검사합니다. Worker에서는 UDP와 ICMP 검사를 Agent가 수행합니다.
- 추가 검사로 SSL 인증서 만료, 도메인 만료, DNS 레코드를 확인합니다.
- Push 모니터에는 전용 URL이 발급되며, 예약 작업이 여기로 POST를 보냅니다. 정해진 시간 안에 오지 않으면 장애로 처리합니다.
- 최소 검사 주기는 Worker가 60초, Go가 5초입니다. 대상이 내부 네트워크에만 열려 있으면 Agent를 검사 원본으로 지정합니다.

모니터 유형과 각 항목은 [사용 가이드](docs/usage.md)에 정리되어 있습니다.

### <img src="assets/readme/host.svg" width="20" height="20" alt=""> 서버 모니터링

- `polaris-agent`는 Linux, macOS, Windows에서 CPU, 메모리, 디스크, 부하, 네트워크, 마운트 지점을 보고합니다. Linux에서는 Docker도 사용할 수 있습니다.
- 리소스 규칙은 임계값과 지속 시간으로 판단하므로 계속 벗어날 때만 알림을 보냅니다. 복구는 임계값 대비 비율로 판단해 경계 근처에서 알림이 반복되지 않게 합니다.
- 머신 상태 페이지는 선택적으로 켭니다. 검색, 필터, 지도 보기와 함께 2~4대 비교를 지원합니다. 기본값은 꺼짐이며, 공개하기 전까지 머신은 관리자에게만 보입니다.

설치, 관리, 업데이트는 [Agent 가이드](docs/agents.md)에 정리되어 있습니다.

### <img src="assets/readme/bell.svg" width="20" height="20" alt=""> 상태 페이지와 알림

- 상태 페이지는 현재 상태, 가동률, 이벤트 기록을 보여줍니다. 그룹으로 나눌 수 있고, 공개로 표시한 모니터만 노출됩니다.
- 유지보수 기간은 한 번만 또는 매주 반복으로 설정합니다. 시작 전에는 페이지 위에 안내를 표시하고, 진행 중에는 자동 알림을 보류합니다.
- 채널마다 메시지 언어와 담당 그룹을 지정할 수 있습니다. 콘솔에는 전송 성공, 제공자 거부, 네트워크 시간 초과를 구분한 전송 기록이 남습니다.

채널 설정과 그룹 범위는 [알림 가이드](docs/notifications.md)에 정리되어 있습니다.

### <img src="assets/readme/layers.svg" width="20" height="20" alt=""> 저장소와 테마

- Worker는 D1 또는 PostgreSQL, Go는 SQLite 또는 PostgreSQL을 사용합니다. D1과 SQLite 데이터는 모두 PostgreSQL로 이전할 수 있습니다.
- 공개 페이지에는 서드파티 테마를 설치할 수 있습니다. ZIP 업로드나 다운로드 URL로 추가하고, 적용 전에 미리 볼 수 있습니다. 테마는 Worker에서는 R2, Go에서는 데이터 디렉터리에 저장됩니다.
- 테마를 설치하지 않으면 기본 디자인을 사용합니다. 관리 콘솔은 항상 기본 인터페이스를 사용합니다.

테마 설치와 제작은 [테마 가이드](docs/themes.md)에 정리되어 있습니다.

### 그 밖에

- **명령 팔레트**: 콘솔에서 `Ctrl+K`(macOS는 `⌘K`)를 누르면 페이지, 모니터, Agent를 검색할 수 있습니다.
- **상태 팝오버**: 콘솔 상단에 장애가 있는 모니터와 오프라인 Agent를 모아 보여주며, 일시 중지, 즉시 검사, 요약 복사를 할 수 있습니다.
- **API**: 관리 엔드포인트는 베어러 토큰으로 인증하며, 스크립트에서 모니터를 만들고 관리할 수 있습니다. [API 참고](docs/api.md)를 보세요.
- **인터페이스 언어**: 중국어 간체, 중국어 번체(대만, 홍콩), 영어, 일본어, 한국어, 프랑스어, 포르투갈어, 러시아어.

## 배포

배포마다 백엔드 하나를 선택하며, 두 백엔드 모두 같은 인터페이스를 사용합니다.

| | Cloudflare Worker | Go |
| --- | --- | --- |
| 실행 환경 | Cloudflare | 직접 운영하는 서버 또는 컨테이너 |
| 데이터베이스 | D1 또는 PostgreSQL | SQLite 또는 PostgreSQL |
| 직접 검사 | HTTP, TCP (UDP, ICMP는 Agent 경유) | HTTP, TCP, UDP, ICMP, DNS, TLS, WebSocket |
| 최소 검사 주기 | 60초 | 5초 |
| 테마 저장소 | R2 (선택) | 데이터 디렉터리 |

서버를 유지하고 싶지 않다면 Worker를 선택하세요. 내부 서비스를 확인해야 하거나, 더 많은 프로토콜이 필요하거나, 검사 주기를 줄여야 한다면 Go를 선택합니다. 자세한 비교는 [백엔드 선택](docs/backends.md)에 있습니다.

### Cloudflare에 배포

1. 이 저장소를 fork합니다.
2. Cloudflare 대시보드에서 **Workers & Pages → Create application → GitHub**을 열고 fork한 저장소를 고릅니다. 빌드 명령에는 `npm run build`, 배포 명령에는 `npm run deploy`를 지정합니다.
3. 배포가 끝나면 사이트를 엽니다. 설정 페이지가 먼저 바인딩과 시크릿을 확인하므로, 안내에 따라 Worker의 **Settings**에서 다음을 설정합니다.
   - **D1(선택)**: D1을 사용하려면 **Bindings**에서 데이터베이스를 추가하고 변수 이름을 `DB`로 지정합니다. D1을 바인딩하지 않으면 초기 설정에서 PostgreSQL만 선택할 수 있습니다.
   - **KV(필수)**: **Bindings**에서 변수 이름 `CONFIG`인 KV 네임스페이스를 추가합니다. 데이터베이스 선택과 암호화된 연결 주소를 저장합니다.
   - **초기 설정 키**: **Variables and Secrets**에서 Secret `ADMIN_TOKEN`을 추가합니다. 값은 `openssl rand -hex 32`의 출력처럼 충분히 긴 무작위 문자열을 사용합니다.
   - **Analytics Engine(필수)**: 대시보드에서 Analytics Engine을 활성화하고 **Bindings**에 데이터셋을 추가한 뒤 변수 이름을 `UPTIME`으로 지정합니다.
   - **R2(선택)**: 서드파티 테마에 필요합니다. **Bindings**에 버킷을 추가하고 변수 이름을 `THEMES`로 지정하며, 설정 후에 추가해도 됩니다.
4. 초기 설정 페이지에서 다시 확인을 누릅니다. 필수 항목을 통과하면 `ADMIN_TOKEN`을 입력해 데이터베이스를 설정하고 검증한 다음 관리자 계정을 만듭니다.

아래 버튼으로도 배포할 수 있습니다. 이 버튼은 fork가 아니라 GitHub 계정에 새 저장소를 만들기 때문에 나중에 Sync fork로 업데이트할 수 없습니다. 데이터베이스와 시크릿은 설정 페이지의 안내에 따라 같은 방식으로 구성합니다.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/XingLingQAQ/UptimePolaris)

명령줄 배포와 PostgreSQL 설정은 [배포 가이드](docs/deployment.md)에 정리되어 있습니다.

<a id="deploy-go"></a>

### Go 백엔드 배포

[Releases](https://github.com/XingLingQAQ/UptimePolaris/releases)에서 운영체제와 아키텍처에 맞는 빌드를 내려받아 `polaris`(Windows는 `polaris.exe`)로 이름을 바꾼 뒤 실행합니다.

```sh
chmod +x polaris   # Linux / macOS
./polaris --data-dir ./data
```

```powershell
.\polaris.exe --data-dir .\data
```

기본적으로 `127.0.0.1:8080`에서 대기합니다. 외부에서 접근하려면 `--addr`을 바꾸거나 리버스 프록시를 앞에 두세요. 데이터는 모두 `./data`에 저장되므로 영구 저장, 접근 권한 제한, 정기 백업이 필요합니다. 실행 옵션과 환경 변수는 [Go 백엔드 안내](backends/go/README.md#install-and-start)에 정리되어 있습니다.

## 빠른 시작

1. 사이트의 `/setup`을 엽니다. Worker는 바인딩과 시크릿을 먼저 확인한 뒤 `ADMIN_TOKEN`을 받고, Go는 시작 로그에 표시되는 설정 키를 받습니다. 이어서 관리자 계정을 만듭니다.
2. `/admin`으로 이동해 **모니터**에서 모니터를 추가합니다. 예를 들어 HTTP를 선택하고 `https://example.com/health`를 입력해 저장한 뒤 "즉시 검사"를 선택합니다.
3. **알림**에서 채널을 추가하고 테스트 메시지를 보냅니다.
4. 로그인하지 않은 브라우저 창으로 사이트 첫 화면을 열어 상태 페이지에 표시되는 내용을 확인합니다.

처음 로그인하면 개요 페이지의 "시작하기" 목록에 모니터 추가, 사이트 이름 설정, 알림 설정, Agent 연결 단계가 표시됩니다.

## 호스트 모니터링

콘솔의 **Agent 관리**에서 머신을 추가하고 플랫폼과 설치 방법을 고른 뒤, 생성된 명령을 대상 머신에서 실행합니다. 해당 머신은 GitHub에 접근할 수 있어야 합니다.

설치 후에는 `pa`(`polaris-agent`의 줄임말)로 서비스를 관리할 수 있습니다.

```sh
pa status
pa restart
pa logs -f
```

- 설치 명령에는 사이트 주소와 해당 머신의 토큰이 들어 있습니다. 실제 도메인에서 생성하고 공개하지 마세요.
- 머신을 추가해도 모니터가 자동으로 만들어지지 않습니다. **모니터**에서 "Agent 호스트" 유형의 모니터를 추가하세요.
- 수동 설치 모드에는 서비스 관리자가 없어 `pa start`, `stop`, `restart`를 사용할 수 없습니다.

설치 모드와 플랫폼별 차이는 [Agent 가이드](docs/agents.md)에 정리되어 있습니다.

## 업그레이드와 제거

### 업그레이드

먼저 데이터베이스를 백업하세요. 전체 절차는 [운영 가이드](docs/operations.md)에 있습니다.

- **Cloudflare**: fork한 경우 GitHub에서 Sync fork를 실행하면 Workers Builds가 자동으로 다시 배포하고, 대시보드에서 추가한 바인딩도 유지됩니다. 배포 버튼으로 만든 경우에는 새 버전을 생성된 저장소에 병합합니다.
- **Go**: 서비스를 중지하고 데이터 디렉터리를 백업한 뒤, 바이너리를 교체하고 같은 데이터 디렉터리로 시작합니다.
- **Agent**: 머신에서 `pa update`를 실행합니다. 관리형 설치에서는 콘솔에서 자동 업데이트를 켤 수 있으며 기본값은 꺼짐입니다.

### 제거

- **Cloudflare**: 대시보드에서 Worker를 삭제합니다. D1 데이터베이스, R2 버킷, PostgreSQL 데이터베이스는 함께 삭제되지 않으므로 더 이상 필요하지 않으면 따로 삭제하세요.
- **Go**: 서비스를 중지한 뒤 바이너리와 데이터 디렉터리를 삭제합니다. PostgreSQL을 쓴다면 해당 데이터베이스도 삭제합니다.
- **Agent**: 사이트에서 설치 스크립트를 내려받아 제거 프로그램을 실행합니다.

  ```sh
  curl -fsSL 'https://status.example.com/install.sh' -o install.sh
  sh install.sh --uninstall
  ```

  Windows 절차는 [Agent 가이드](docs/agents.md)를 보세요. Agent를 제거해도 콘솔의 모니터는 삭제되지 않습니다.

## 데이터와 공개 범위

- 데이터는 직접 운영하는 배포에 남습니다. Worker는 Cloudflare 계정의 D1 또는 직접 제공한 PostgreSQL을, Go는 데이터 디렉터리의 SQLite 또는 직접 제공한 PostgreSQL을 사용합니다.
- 상태 페이지와 공개 API는 로그인 없이 접근할 수 있습니다. 모니터 이름, HTTP 대상의 호스트와 경로, TCP 대상의 호스트와 포트는 공개되므로 내부 주소나 시크릿을 넣지 마세요.
- HTTP 대상의 사용자 이름, 비밀번호, 쿼리 문자열은 제거됩니다. 인증 정보와 Agent 토큰은 공개 데이터에 나타나지 않습니다.
- Push URL의 토큰은 해당 모니터의 보고 자격 증명입니다. 공개하지 마세요.
- 공개하지 않을 모니터는 모니터 목록에서 "상태 페이지에서 숨기기"를 선택하면 관리자에게만 보입니다.
- Worker의 SSL 검사는 공개된 인증서 투명성 로그를 조회하며, Agent는 시작할 때 머신의 공인 IP 지역을 조회하고 업데이트할 때 GitHub에 접근합니다.

공개 페이지와 API가 반환하는 항목은 [공개 데이터](docs/usage.md)에 정리되어 있습니다.

## 자주 묻는 질문

**설정 페이지가 배포 확인 단계에서 멈추고 진행되지 않습니다.**
Worker의 **Settings**에서 필수 항목인 `ADMIN_TOKEN`과 `UPTIME`을 설정하고 저장 및 배포한 후 "다시 확인"을 선택하세요. D1과 R2는 선택 항목입니다. D1 바인딩이 없으면 다음 단계에서 PostgreSQL 연결을 설정하세요.

**Push URL을 브라우저에서 열면 데이터가 없습니다.**
브라우저는 GET을 보내지만 Push는 POST만 받으므로 GET은 405를 반환합니다. `curl -X POST`를 쓰거나 예약 작업에서 POST를 보내세요.

**알림 테스트는 성공하는데 장애 때는 오지 않습니다.**
채널이 활성화되어 있는지, 그룹 범위에 해당 모니터가 포함되는지, 유지보수 기간이 아닌지 확인하세요. 그룹을 하나도 선택하지 않은 채널은 모든 모니터의 알림을 받습니다.

**Agent가 오프라인으로 표시됩니다.**
머신에서 `pa status`와 `pa logs -f`를 실행해 서비스가 동작하고 사이트 도메인에 접근할 수 있는지 확인하세요. 기본값은 60초마다 보고하며, 약 3분 동안 오지 않으면 오프라인으로 판단합니다.

그 밖의 사례는 [문제 해결](docs/troubleshooting.md)에 정리되어 있습니다. 계속 해결되지 않으면 [Issues](https://github.com/XingLingQAQ/UptimePolaris/issues)에 알려주세요.

## 문서

| 문서 | 내용 |
| --- | --- |
| [백엔드 선택](docs/backends.md) | Worker와 Go의 차이 |
| [배포 가이드](docs/deployment.md) | fork 배포, 배포 버튼, 수동 배포, 도메인, PostgreSQL, D1에서 PostgreSQL로 이전 |
| [Go 백엔드](backends/go/README.md) | 실행 옵션, 환경 변수, SQLite에서 PostgreSQL로 이전 |
| [사용 가이드](docs/usage.md) | 콘솔, 모니터 설정, Push, 상태 페이지, 유지보수 기간, 계정과 보안 |
| [Agent 가이드](docs/agents.md) | 설치, 관리, 설정, 업데이트, 제거 |
| [알림 가이드](docs/notifications.md) | 채널 설정, 그룹 범위, 전송 기록 |
| [테마 가이드](docs/themes.md) | 설치, 설정, 미리보기 |
| [설정 참고](docs/configuration.md) | 바인딩, 환경 변수, 콘솔 설정 |
| [API 참고](docs/api.md) | 엔드포인트, 인증, 예제 |
| [운영 가이드](docs/operations.md) | 백업, 복원, 업그레이드, 데이터 보존 |
| [문제 해결](docs/troubleshooting.md) | 증상별 진단 |

## 라이선스

Uptime Polaris는 [MIT 라이선스](LICENSE)로 배포됩니다.
