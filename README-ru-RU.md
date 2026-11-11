<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/overview-ru-RU-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/readme/overview-ru-RU-light.svg">
    <img src="assets/readme/overview-ru-RU-light.svg" width="100%" alt="Uptime Polaris: мониторинг доступности сервисов и хостов">
  </picture>
</h1>

<p align="center"><strong>Проверки HTTP/TCP, Push-сигналы, метрики хостов</strong><br>Работает на Cloudflare Workers или на собственном сервере Go.</p>

Worker использует D1 или PostgreSQL, Go — SQLite или PostgreSQL. Интерфейс общий. [Запуск Go](backends/go/README.md).

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

Uptime Polaris объединяет публичную страницу статуса, консоль администратора и мониторинг по расписанию в одном приложении. Он выполняет проверки HTTP/TCP, принимает Push-сигналы, собирает метрики хостов через `polaris-agent` и отправляет уведомления при изменении состояния монитора.

## Выбор бэкенда

Для каждого развёртывания выбирается один бэкенд. Go работает без учётной записи Cloudflare, D1 и R2.

Хранение: Worker использует D1 или PostgreSQL, темы лежат в R2. Go использует SQLite или PostgreSQL и хранит данные и темы в каталоге данных. Проверки: Go напрямую выполняет UDP, ICMP, DNS, TLS и WebSocket. Worker не умеет выполнять их напрямую; UDP и ICMP идут через онлайн-агент.

[Сравнение и запуск бэкендов](docs/backends.md)

## Возможности

<p align="center">
  <img src="assets/readme/check.svg" width="24" height="24" alt="Значок проверки сервисов"><br>
  <strong>Проверки сервисов и сигналы о работе</strong><br>
  Проверки HTTP и TCP с дополнительными условиями на ответ, сертификат, домен и DNS. Push-мониторы принимают сигналы от задач по расписанию.
</p>

<p align="center">
  <img src="assets/readme/host.svg" width="24" height="24" alt="Значок мониторинга хостов"><br>
  <strong>Метрики и проверки хостов</strong><br>
  <code>polaris-agent</code> передаёт метрики CPU, памяти, диска и сети. Он также может выполнять HTTP/TCP-проверки с хоста.
</p>

<p align="center">
  <img src="assets/readme/bell.svg" width="24" height="24" alt="Значок уведомлений о статусе"><br>
  <strong>Страница статуса и уведомления</strong><br>
  Публичная страница показывает текущее состояние и историю событий. Группы, окна обслуживания и каналы определяют, что видно и кому приходят уведомления.
</p>

<p align="center">
  <img src="assets/readme/layers.svg" width="24" height="24" alt="Значок хранилища и тем"><br>
  <strong>Хранение и темы</strong><br>
  Worker хранит данные в D1 или PostgreSQL, темы — в R2. Go хранит данные в SQLite или PostgreSQL, темы — в каталоге данных.
</p>

Push-мониторы не измеряют задержку; публичное поле задержки равно `null`. Проверки каждого бэкенда перечислены в [сравнении бэкендов](docs/backends.md). Настройка и ограничения — в [руководстве пользователя](docs/usage.md).

## Быстрый старт

Выберите бэкенд и следуйте его руководству по развёртыванию. Откройте `/setup`, создайте администратора и добавьте первый монитор в `/admin`.

### Cloudflare Worker

[Развёртывание в Cloudflare](#развёртывание-в-cloudflare)

### Go

Исполняемый файл Go включает веб-интерфейс. Загрузите версию для своей ОС со страницы Releases и следуйте [руководству Go](backends/go/README.md#english).

## Развёртывание в Cloudflare

[![Развернуть в Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/XingLingQAQ/UptimePolaris)

Кнопка создаёт форк репозитория и запускает развёртывание. Задайте новые имена Worker и базы данных, установите `ADMIN_TOKEN` в длинное случайное значение и сохраните его как секрет Worker. Если идентификатор базы отсутствует, найдите или создайте D1 в Cloudflare, замените заглушку `database_id` в `wrangler.jsonc` форкнутого репозитория и повторите развёртывание. Точные шаги — в [руководстве по развёртыванию](docs/deployment.md#通过-cloudflare-按钮部署).

Шаблон кнопки привязывает только D1, статические файлы и расписания. Тем в R2 и Analytics Engine в нём нет. Для установки Agent нужен доступ к загрузкам GitHub Release.

<a id="deploy-go"></a>

## Развёртывание бэкенда Go

Загрузите версию для своей ОС со страницы [Releases](https://github.com/XingLingQAQ/UptimePolaris/releases) и следуйте [руководству по установке Go](backends/go/README.md#install-and-start). Бинарный файл включает веб-интерфейс. Каталог данных должен быть постоянным; ограничьте к нему доступ и делайте резервную копию вместе с базой.

## Мониторинг хостов

Создайте машину на странице Agent в консоли, выберите платформу и режим установки, затем выполните сгенерированную команду на целевой машине. Установщик загружает последнюю стабильную версию для этой платформы.

Установщик регистрирует службу `polaris-agent` и команду `pa`. Обе работают с одной программой, конфигурацией и службой.

```sh
pa status
pa restart
pa logs -f
```

`pa start`, `stop` и `restart` требуют менеджера служб; при ручной установке программа запускается в терминале. `pa logs` читает файл журнала, созданный установкой. Команда установки содержит протокол, домен и порт текущего сайта, поэтому создавайте её по адресу, который планируете использовать постоянно. Режимы установки, ограничения платформ, настройка, обновление и удаление — в [руководстве по Agent](docs/agents.md).

## Использование и публичные данные

Публичная страница статуса доступна анонимно. Перед добавлением монитора убедитесь, что его имя, путь к цели, имя хоста и внутренние адреса не содержат чувствительных данных. Публичный API удаляет данные аутентификации, но не проверяет имена и пути на чувствительное содержимое. Подробнее см. [описание публичных данных](docs/usage.md#公开数据).

Каналы уведомлений: Telegram, Feishu, Slack, Discord, Webhook, Apprise и Server酱. Канал можно ограничить группами мониторов. Настройка и диагностика доставки — в [руководстве по уведомлениям](docs/notifications.md).

## Документация

| Задача | Документ |
| --- | --- |
| Развернуть сайт, настроить домен или PostgreSQL | [Руководство по развёртыванию](docs/deployment.md) |
| Сравнение бэкендов | [Worker / Go](docs/backends.md#english) · [Go](backends/go/README.md#english) |
| Создать мониторы и посмотреть статусы или публичные данные | [Руководство пользователя](docs/usage.md) |
| Установить Agent на хост и управлять им | [Руководство по Agent](docs/agents.md) |
| Настроить привязки, переменные окружения и параметры администрирования | [Справочник конфигурации](docs/configuration.md) |
| Настроить каналы уведомлений и область их действия | [Руководство по уведомлениям](docs/notifications.md) |
| Установить или настроить тему страницы статуса | [Руководство по темам](docs/themes.md#english) |
| Использовать API или подключить Push | [Справочник API](docs/api.md) |
| Сделать резервную копию, обновить систему и устранить неполадки | [Руководство по эксплуатации](docs/operations.md) · [Частые вопросы](docs/troubleshooting.md) |

Полный индекс: [docs/README.md](docs/README.md).

## Лицензия

Проект распространяется по [лицензии MIT](LICENSE).
