<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/overview-ru-RU-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/readme/overview-ru-RU-light.svg">
    <img src="assets/readme/overview-ru-RU-light.svg" width="100%" alt="Uptime Polaris: мониторинг доступности сервисов и хостов">
  </picture>
</h1>

<p align="center"><strong>Проверки HTTP/TCP, Push-сигналы, метрики хостов</strong><br>Работает на Cloudflare Workers или на собственном сервере Go.</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README-zh-CN.md">简体中文</a> · <a href="README-zh-TW.md">繁體中文（台灣）</a> · <a href="README-zh-HK.md">繁體中文（香港）</a> · <a href="README-ja-JP.md">日本語</a> · <a href="README-ko-KR.md">한국어</a> · <a href="README-fr-FR.md">Français</a> · <a href="README-pt-BR.md">Português (Brasil)</a> · <strong>Русский</strong>
</p>

<p align="center">
  <a href="https://developers.cloudflare.com/workers/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&amp;logo=cloudflare&amp;logoColor=white" height="20" alt="Работает на Cloudflare Workers"></a>
  <a href="backends/go/README.md"><img src="https://img.shields.io/badge/Go-Backend-00ADD8?style=flat-square&amp;logo=go&amp;logoColor=white" height="20" alt="Go backend"></a>
  <a href="frontend/README.md"><img src="https://img.shields.io/badge/React-TypeScript-3178C6?style=flat-square&amp;logo=react&amp;logoColor=white" height="20" alt="Фронтенд на React и TypeScript"></a>
  <a href="https://github.com/XingLingQAQ/polaris-agent"><img src="https://img.shields.io/badge/Rust-Agent-93450A?style=flat-square&amp;logo=rust&amp;logoColor=white" height="20" alt="Polaris Agent на Rust"></a>
  <a href="docs/configuration.md"><img src="https://img.shields.io/badge/Storage-D1%20%2F%20SQLite%20%2F%20PostgreSQL-4169E1?style=flat-square&amp;logo=postgresql&amp;logoColor=white" height="20" alt="Storage: D1, SQLite, PostgreSQL"></a>
</p>

<p align="center">
  <a href="#быстрый-старт">Быстрый старт</a> ·
  <a href="#развёртывание-в-cloudflare">Развёртывание</a> · <a href="#deploy-go">Развернуть Go</a> ·
  <a href="#мониторинг-хостов">Agent</a> ·
  <a href="#документация">Документация</a>
</p>

Uptime Polaris регулярно проверяет сайты и порты, принимает сигналы от планировщика, собирает метрики CPU, памяти и дисков серверов и отправляет уведомление при изменении состояния монитора. Публичная страница статуса и панель администратора входят в поставку.

## Выбор бэкенда

Для каждого развёртывания выберите один бэкенд. Оба используют одинаковый интерфейс.

| | Cloudflare Worker | Go |
| --- | --- | --- |
| Где работает | Cloudflare | Свой сервер или контейнер |
| База данных | D1 или PostgreSQL | SQLite или PostgreSQL |
| Прямые проверки | HTTP, TCP (UDP и ICMP через Agent) | HTTP, TCP, UDP, ICMP, DNS, TLS, WebSocket |
| Минимальный интервал | 60 секунд | 5 секунд |
| Файлы тем | R2 (необязательно) | Каталог данных |

Выбирайте Worker, если не хотите обслуживать сервер. Выбирайте Go, если нужны проверки внутренней сети, больше протоколов или короткий интервал. Подробнее — в [сравнении бэкендов](docs/backends.md).

## Возможности

<p align="center">
  <img src="assets/readme/check.svg" width="24" height="24" alt="Значок проверки сервиса"><br>
  <strong>Проверки сервисов и сигналы</strong><br>
  Проверки HTTP и TCP с дополнительным контролем ответа, сертификата, срока действия домена и DNS. Push-мониторы подходят для cron и скриптов резервного копирования: если сигнал не пришёл вовремя, монитор считается недоступным.
</p>

<p align="center">
  <img src="assets/readme/host.svg" width="24" height="24" alt="Значок мониторинга хоста"><br>
  <strong>Мониторинг серверов</strong><br>
  <code>polaris-agent</code> передаёт метрики CPU, памяти, дисков, нагрузки и сети. Он также может выполнять проверки HTTP/TCP с самого хоста, чтобы охватить внутренние сервисы.
</p>

<p align="center">
  <img src="assets/readme/bell.svg" width="24" height="24" alt="Значок уведомлений о статусе"><br>
  <strong>Страница статуса и уведомления</strong><br>
  Страница статуса показывает текущее состояние и историю событий, поддерживает группы и окна обслуживания. Уведомления отправляются в Telegram, Feishu, Slack, Discord, Webhook, Apprise и Server酱; каждый канал можно ограничить группами мониторов.
</p>

<p align="center">
  <img src="assets/readme/layers.svg" width="24" height="24" alt="Значок хранилища и тем"><br>
  <strong>Хранилище и темы</strong><br>
  Worker хранит данные в D1 или PostgreSQL, а темы — в R2; Go использует SQLite или PostgreSQL и держит темы в каталоге данных.
</p>

## Быстрый старт

1. Разверните на [Cloudflare](#развёртывание-в-cloudflare) или на [своём сервере](#deploy-go).
2. Откройте `/setup`. Worker сначала проверит привязки и секреты; Go запросит ключ настройки из журнала запуска.
3. Создайте учётную запись администратора и добавьте мониторы в `/admin`.

## Развёртывание в Cloudflare

1. Сделайте Fork этого репозитория.
2. В панели Cloudflare откройте **Workers & Pages → Create application → GitHub** и выберите свой fork. Укажите `npm run build` как команду сборки и `npm run deploy` как команду развёртывания.
3. После развёртывания откройте сайт. Страница настройки сначала проверит привязки и секреты; настройте отмеченное в **Settings** воркера:
   - **D1 (необязательно)**: для D1 добавьте базу в **Bindings** с именем переменной `DB`. Без D1 при настройке доступен только PostgreSQL.
   - **Ключ настройки**: добавьте секрет `ADMIN_TOKEN` в **Variables and Secrets** с длинным случайным значением, например результатом `openssl rand -hex 32`.
   - **Analytics Engine (обязательно)**: включите Analytics Engine в панели управления и добавьте набор данных в **Bindings** с именем привязки `UPTIME`.
   - **Необязательно**: для установки сторонних тем добавьте бакет R2 с именем привязки `THEMES`. Это можно сделать после первоначальной настройки.
4. На странице настройки нажмите **Re-check**. После проверки обязательных пунктов введите `ADMIN_TOKEN`, настройте и проверьте базу, затем создайте учётную запись администратора.

Обновление выполняется кнопкой **Sync fork** на GitHub: Workers Builds пересоберёт проект автоматически и сохранит привязки, добавленные в панели.

Можно развернуть и кнопкой ниже. Она создаёт новый репозиторий в вашей учётной записи GitHub (это не fork, поэтому обновление через Sync fork недоступно); базу данных и секрет настройте по указаниям страницы настройки:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/XingLingQAQ/UptimePolaris)

Развёртывание из командной строки и настройка PostgreSQL описаны в [руководстве по развёртыванию](docs/deployment.md).

<a id="deploy-go"></a>

## Развёртывание бэкенда Go

Загрузите сборку для своей системы со страницы [Releases](https://github.com/XingLingQAQ/UptimePolaris/releases), переименуйте её в `polaris` (`polaris.exe` в Windows) и запустите:

```sh
chmod +x polaris   # Linux / macOS
./polaris --data-dir ./data
```

```powershell
.\polaris.exe --data-dir .\data
```

По умолчанию программа слушает `127.0.0.1:8080`. Для внешнего доступа измените `--addr` или настройте обратный прокси. Все данные хранятся в `./data`; каталог должен быть постоянным, доступ к нему нужно ограничить, а резервные копии — делать регулярно. Подробнее — в [описании бэкенда Go](backends/go/README.md#install-and-start).

## Мониторинг хостов

Добавьте машину на странице Agent в панели, выберите платформу и способ установки, затем выполните сгенерированную команду на целевой машине. Целевая машина должна иметь доступ к GitHub.

После установки службой управляет `pa` (короткая форма `polaris-agent`):

```sh
pa status
pa restart
pa logs -f
```

- Команда установки содержит адрес сайта и токен машины. Создавайте её на рабочем домене и не публикуйте.
- Добавление машины не создаёт монитор. Чтобы следить за доступностью или порогами ресурсов, добавьте монитор типа Agent на странице мониторов.
- При ручной установке нет менеджера служб, поэтому `pa start`, `stop` и `restart` недоступны.

Подробнее — в [руководстве по Agent](docs/agents.md).

## Использование и публичные данные

Страница статуса доступна без входа. Имена мониторов, пути к целям и имена хостов могут появляться на публичных страницах и в API, поэтому не указывайте там внутренние адреса и секреты. См. [публичные данные](docs/usage.md#公开数据) и [руководство по уведомлениям](docs/notifications.md).

## Документация

| Документ | Содержание |
| --- | --- |
| [Сравнение бэкендов](docs/backends.md) | Различия Worker и Go |
| [Руководство по развёртыванию](docs/deployment.md) | Развёртывание через fork, кнопку и вручную, домены, PostgreSQL, миграция D1 в PostgreSQL |
| [Бэкенд Go](backends/go/README.md) | Параметры запуска, переменные среды, миграция SQLite в PostgreSQL |
| [Руководство пользователя](docs/usage.md) | Настройка мониторов, Push, состояние и доступность |
| [Руководство по Agent](docs/agents.md) | Установка, управление, настройка, обновления, удаление |
| [Руководство по уведомлениям](docs/notifications.md) | Настройка каналов, область групп, журнал доставки |
| [Руководство по темам](docs/themes.md) | Установка, настройка, предпросмотр |
| [Справочник по настройке](docs/configuration.md) | Привязки, переменные среды, настройки панели |
| [Справочник API](docs/api.md) | Конечные точки, аутентификация, примеры |
| [Руководство по эксплуатации](docs/operations.md) | Резервное копирование, восстановление, обновления, хранение |
| [Устранение неполадок](docs/troubleshooting.md) | Диагностика по симптомам |

## Лицензия

Проект распространяется по [лицензии MIT](LICENSE).
