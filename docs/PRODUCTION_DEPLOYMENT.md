# Production-развёртывание (Stage 8B)

Этот документ — операционный runbook для развёртывания приложения через
`docker-compose.prod.yml` на существующем production-сервере с уже
работающим Traefik. Он описывает **контракт** развёртывания; сам live
deployment на реальный сервер — отдельный этап (Stage 8C), выполняемый
только после независимого аудита Stage 8B.

Не меняет архитектуру приложения: один процесс (`python service_main.py`,
Telegram + web в одном asyncio-процессе — см. README.md, "Единый процесс:
Telegram + web (Stage 7A-3)"), один embedded-режим Qdrant, один PostgreSQL.

## 1. Prerequisites

- Docker Engine + Docker Compose v2 на целевом сервере.
- Уже работающий Traefik-стек с внешней Docker-сетью, к которой
  подключаются проксируемые приложения (см. раздел 4).
- DNS-запись `learn.elivcloud.org` уже указывает на этот сервер (раздел 3).
- Доступ к реальным production-креденшлам: Telegram bot token, OpenAI API
  key, Anthropic API key, отдельное GitHub OAuth App для продакшна.
- Репозиторий склонирован на сервере; рабочая директория — корень
  репозитория (где лежат `Dockerfile`, `docker-compose.prod.yml`).
- **Credential rotation gate пройден** — см. раздел 1a. Это обязательный
  шаг ДО первого запуска production-стека, не опциональный.

## 1a. ОБЯЗАТЕЛЬНЫЙ pre-deployment gate: ротация креденшлов

Любые значения этих креденшлов, которые существовали до/во время Stage 8B
(включая любые значения, которые могли быть видны в рабочих материалах,
логах, скриншотах или где-либо ещё вне защищённого секрет-хранилища),
считаются **скомпрометированными** и НЕ ДОЛЖНЫ использоваться в production.
Перед Stage 8C / любым live-запуском этого стека ОБЯЗАТЕЛЬНО должны быть
сгенерированы заново (rotated):

- **Anthropic API key** — новый ключ выпущен в Anthropic Console; старый
  отозван после переключения.
- **OpenAI API key** — новый ключ выпущен в OpenAI dashboard; старый
  отозван после переключения.
- **GitHub OAuth client secret** — новый secret сгенерирован для
  production OAuth App (отдельного от dev, см. раздел 4/GitHub OAuth
  ниже); старый secret отозван.
- **Telegram bot token** — новый token получен от @BotFather (`/revoke` +
  переиздание, либо создание нового бота, если revoke недоступен для
  текущего); старый token не используется нигде.
- **`SESSION_SECRET_KEY`** — сгенерирован заново
  (`python -c "import secrets; print(secrets.token_urlsafe(32))"`),
  никогда не переиспользуется значение из dev/предыдущих тестов.

**НЕ входит в обязательную ротацию:**

- **`GITHUB_CLIENT_ID`** — это публичный идентификатор OAuth App, не
  секрет; ротация не требуется.
- **`TELEGRAM_ALLOWED_USER_IDS`** — это не credential (числовой Telegram
  user id, не секрет доступа сам по себе), ротация не требуется. Тем не
  менее это privacy-значение: убедитесь, что список содержит только
  реально предназначенных пользователей перед production-запуском.
- **`GITHUB_ALLOWED_USER_IDS`** (pre-deployment corrective pass) — тот же
  статус, что и `TELEGRAM_ALLOWED_USER_IDS` выше: не credential, ротация
  не требуется, но это ОБЯЗАТЕЛЬНОЕ privacy/access-control значение —
  продукт private/invite-only, а не публичный. Пусто/не задано = вход
  через GitHub запрещён всем (fail closed), НЕ "всем разрешено" — успешная
  GitHub OAuth-аутентификация сама по себе больше не достаточна для
  доступа к web-приложению (см. utils/github_access_control.py). Укажите
  здесь числовые GitHub user id (never `login`/username) владельца и
  каждого доверенного пользователя перед production-запуском.

**Требования к процессу:**

- Старые (пред-ротационные) значения перечисленных выше credential
  категорий НЕЛЬЗЯ использовать в production ни при каких
  обстоятельствах.
- `.env.production` на production-сервере должен содержать ТОЛЬКО новые,
  ротированные значения.
- Ротация должна быть **завершена и проверена** (новое значение реально
  работает — например, пробный вызов API/успешный OAuth-обмен/успешная
  Telegram `get_me`) ДО запуска production-стека (раздел 8).

Реальные старые или новые значения секретов никогда не записываются в
этот или любой другой файл репозитория.

## 2. Переменные окружения / секреты

Шаблон — `.env.production.example` (комментарии внутри классифицируют
каждую переменную: REQUIRED/OPTIONAL/GENERATED/EXTERNAL/DEPLOYMENT).

```bash
cp .env.production.example .env.production
# отредактировать .env.production реальными значениями
```

**Важно:** файл называется именно `.env.production`, а не `.env` —
`docker-compose.prod.yml` ссылается на него явно (`env_file:
.env.production`), чтобы никогда случайно не подхватить чужой/несвязанный
`.env`, который может существовать в директории по другой причине (это
не гипотетический риск — см. раздел 15 итогового отчёта Stage 8B: именно
так в процессе верификации едва не утекли реальные dev-секреты через
`docker compose config`, пока путь не был явно разделён). `.env.production`
уже в `.gitignore` — никогда не коммитить.

Сгенерировать секреты:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"  # SESSION_SECRET_KEY
python -c "import secrets; print(secrets.token_urlsafe(32))"  # POSTGRES_PASSWORD (URL-safe — интерполируется в DSN буквально)
```

## 3. DNS

Предполагается, что `learn.elivcloud.org` уже резолвится на публичный IP
этого сервера **до** начала Stage 8C (не проверяется этим этапом и не
проверяется кодом этого приложения).

## 4. Внешняя Traefik-сеть

`docker-compose.prod.yml` объявляет `app-public` как `external: true` —
Compose ожидает, что эта Docker-сеть **уже существует**, созданная
существующим Traefik-стеком, и никогда не создаёт/не удаляет её сама.

```bash
docker network ls | grep -i traefik   # или n8n / известное имя сети
```

**НЕПОДТВЕРЖДЕНО** — см. итоговый отчёт Stage 8B, раздел "Open issues":
ожидаемое имя из исходного запроса (`n8n_n8n_network`) не совпадает с
единственной похожей сетью, реально увиденной при подготовке этого
файла (`n8n_n8n-network`, через дефис) — а эта машина является локальной
dev-машиной, не production-сервером, так что ни то, ни другое имя не
является подтверждённым фактом о реальном сервере. Перед Stage 8C:

```bash
docker network ls                      # найти реальное имя
docker inspect <существующий-plain-english-контейнер> --format '{{json .Config.Labels}}'  # entrypoint/certresolver-конвенции
```

Установить подтверждённые значения в `.env.production`:
`TRAEFIK_NETWORK_NAME`, `TRAEFIK_ENTRYPOINT`, `TRAEFIK_CERT_RESOLVER`.

Эти три переменные в `docker-compose.prod.yml` объявлены через
required-variable синтаксис (`${VAR:?...}`) — БЕЗ defaults. Пока они не
установлены, `docker compose config`/`build`/`up` завершается ошибкой
явно (fail closed), а не тихо подставляет непроверенное значение.
`.env.production.example` намеренно оставляет их пустыми.

## 4a. Security requirement: OAuth callback query-параметры в reverse-proxy логах

`GET /api/auth/github/callback` получает sensitive query-параметры
(`code`, `state` — одноразовый authorization code и CSRF-state OAuth 2.0
обмена). Application-side (Uvicorn access logging) это уже учтено и не
меняется в Stage 8B. Но reverse-proxy (Traefik) по умолчанию может писать
полный запрошенный URL, включая query string, в свои access-логи — это
самостоятельная утечка sensitive данных, независимая от логирования
приложения.

**Требование (обязательно к выполнению на Stage 8C, до открытия маршрута
наружу):** для маршрута `/api/auth/github/callback` на стороне Traefik
должно быть выполнено одно из:

- access logging отключён для этого конкретного маршрута; ИЛИ
- query string / sensitive параметры (`code`, `state`) редактируются
  (redacted) в access-логе.

Конкретный Traefik-синтаксис здесь намеренно не фиксируется — он зависит
от реальной версии/конфигурации Traefik на целевом сервере (статический
vs динамический конфиг, уже используемые middleware у других
проксируемых приложений) и не проверен в Stage 8B. Вместо этого Stage 8C
checklist должен включать:

1. Зафиксировать это security-требование как часть реальной Traefik-
   конфигурации маршрута `mla` (см. `docker-compose.prod.yml`'s
   `traefik.http.routers.mla.*` labels).
2. Реализовать actual Traefik-конфигурацию (labels/middleware/статический
   конфиг — по месту, под реальный Traefik setup сервера).
3. Выполнить dummy-запрос на `/api/auth/github/callback` с тестовыми
   `code`/`state` значениями (реальный OAuth-обмен для этого не нужен —
   подходит любой GET-запрос с этими query-параметрами, даже если
   приложение ответит ошибкой из-за невалидного `state`).
4. Проверить Traefik access-логи за это время.
5. Подтвердить, что значения `code`/`state` НЕ присутствуют в
   просмотренных логах (ни в открытом виде, ни частично).

Пока этот пункт не выполнен и не подтверждён на Stage 8C, маршрут не
считается production-ready с точки зрения privacy реверс-прокси логов.

## 5. Первичная сборка

```bash
docker compose -f docker-compose.prod.yml --env-file ./.env.production build
```

Собирает ТОТ ЖЕ принятый Stage 8A `Dockerfile` (с одним точечным
исправлением Stage 8B — см. итоговый отчёт, раздел "Files changed":
`data/generated_images` теперь тоже создаётся и `chown`-ится для
non-root runtime-пользователя, иначе процесс падал при старте).

## 6. Запуск PostgreSQL и проверка health

```bash
docker compose -f docker-compose.prod.yml --env-file ./.env.production up -d postgres
docker compose -f docker-compose.prod.yml --env-file ./.env.production ps postgres
# STATUS должен стать "healthy" (healthcheck: pg_isready)
```

Порт 5432 никогда не публикуется на хост — только приватная сеть
`app-internal` (`internal: true`, без выхода в интернет).

## 7. Явные миграции (НИКОГДА не автоматически)

Миграции запускаются только вручную, отдельным one-shot сервисом,
никогда — при обычном запуске приложения:

```bash
# Применить все миграции до head:
docker compose -f docker-compose.prod.yml --env-file ./.env.production \
  --profile tools run --rm migrate

# Проверить текущую ревизию:
docker compose -f docker-compose.prod.yml --env-file ./.env.production \
  --profile tools run --rm migrate current
```

`migrate`-сервис использует профиль `tools` — `docker compose up` (без
`--profile tools`) никогда его не запускает.

**Правило остановки при ошибке:** если команда `migrate` завершается с
ненулевым exit code, деплой немедленно останавливается — запуск/обновление
приложения (раздел 8 / раздел 13) НЕ продолжается, пока причина ошибки не
выяснена и не устранена. Никогда не запускать/перезапускать `app` поверх
БД с неизвестным/частично применённым состоянием миграций.

## 8. Запуск приложения

```bash
docker compose -f docker-compose.prod.yml --env-file ./.env.production up -d app
```

Запускает `python service_main.py` (единый Telegram+web процесс) —
требует ОДНОВРЕМЕННО валидный `TELEGRAM_BOT_TOKEN` (реальный, рабочий —
`Setup: Telegram get_me failed` останавливает весь процесс, это
намеренное fail-closed поведение) и весь web-контракт (`SESSION_SECRET_KEY`,
`GITHUB_CLIENT_*`, `DATABASE_URL` — вычисляется автоматически из
`POSTGRES_*`, см. `docker-compose.prod.yml`'s `x-database-url`).

## 9. Проверка здоровья

```bash
docker compose -f docker-compose.prod.yml --env-file ./.env.production ps app
# STATUS: healthy (встроенный HEALTHCHECK Dockerfile'а, GET /healthz)

docker compose -f docker-compose.prod.yml --env-file ./.env.production logs app --tail=50
```

## 10. HTTPS/routing — выполнить на Stage 8C (не проверяется здесь)

- `curl -I https://learn.elivcloud.org/healthz` → `200`, валидный TLS-сертификат.
- Проверить реальные Traefik-labels (`entrypoints`/`certresolver`) сматчились
  с реальной конфигурацией (раздел 4).
- Проверить, что порт 8000 НЕ достижим напрямую с хоста/извне, только через Traefik.

## 11. Telegram smoke — выполнить на Stage 8C (не проверяется здесь)

- Написать боту от аккаунта из `TELEGRAM_ALLOWED_USER_IDS`, получить ответ.
- Убедиться, что неавторизованный `from_user.id` получает отказ (fail closed).

## 12. Persistence-проверки

```bash
docker volume ls | grep <project>_          # postgres_data, qdrant_data, uploads_data
docker compose -f docker-compose.prod.yml --env-file ./.env.production restart app postgres
# данные должны остаться — проверено в Stage 8B disposable-верификации, см. итоговый отчёт
```

`/app/data/generated_images` и `/app/bot.log` **намеренно** не
volume-mounted — см. итоговый отчёт Stage 8B, раздел "Persistence" за
полным обоснованием (эфемерный DALL-E-вывод; файловый лог избыточен
поверх `docker compose logs`, который пишет то же самое в консоль).

**Operational note: рост `/app/bot.log`.** Это ожидаемое поведение
текущей Stage 8B реализации, не баг:

- `/app/bot.log` эфемерен — живёт в writable-слое контейнера, не в
  named volume, и не переживает пересоздание контейнера
  (`up --force-recreate`, замену образа и т.п.).
- Все те же записи доступны через `docker compose ... logs app`
  (тот же `configure_logging()` пишет и в файл, и в консоль) — файл не
  является единственным источником логов.
- `FileHandler` пишет в `bot.log` БЕЗ ротации, поэтому файл может расти
  неограниченно в течение всего времени жизни контейнера (это не
  меняется в Stage 8B — см. раздел "Accepted findings", logging
  implementation не трогается).
- Operator должен учитывать использование storage контейнера
  (`docker system df`, `docker inspect` container size) на длинных
  интервалах между пересозданиями.
- При аномальном росте допустимо controlled пересоздание контейнера
  (`docker compose ... up -d --force-recreate app`) ПОСЛЕ того, как
  нужные логи уже сохранены через `docker compose ... logs app` — это
  контейнер, не хостовая конфигурация logrotate/системный редизайн,
  который в Stage 8B не рассматривается.

## 13. Обновление (update procedure)

```bash
git pull                                                    # на сервере, в рабочей копии репозитория
docker compose -f docker-compose.prod.yml --env-file ./.env.production build app
docker compose -f docker-compose.prod.yml --env-file ./.env.production \
  --profile tools run --rm migrate                          # если есть новые миграции — ВСЕГДА до рестарта app
# Проверить exit code команды выше ($? в bash) ПЕРЕД следующим шагом.
# Ненулевой exit code → СТОП: не выполнять `up -d app` ниже, пока причина
# ошибки миграции не выяснена и не устранена (см. раздел 7).
docker compose -f docker-compose.prod.yml --env-file ./.env.production up -d app
```

## 14. Откат (rollback procedure)

```bash
git checkout <предыдущий-известный-хороший-коммит>
docker compose -f docker-compose.prod.yml --env-file ./.env.production build app
docker compose -f docker-compose.prod.yml --env-file ./.env.production up -d app
```

Если откатываемое изменение включало миграцию схемы — откат схемы
(`alembic downgrade`) выполняется отдельно, осознанно, только если
целевая ревизия действительно поддерживает `downgrade()` (проверить в
`alembic/versions/`); часто безопаснее откатить только код приложения,
оставив схему как есть (миграции здесь в целом аддитивны).

## 15. Backup / restore

**Общее правило для всех трёх процедур ниже:** если любая backup- или
restore-команда завершается ненулевым exit code, operator flow
немедленно останавливается — не переходить к следующему шагу (и тем
более не запускать/не считать восстановление успешным), пока причина
ошибки не выяснена и не устранена.

### PostgreSQL (logical backup)

Команды ниже — copy-paste safe: они НЕ полагаются на то, что
`$POSTGRES_USER`/`$POSTGRES_DB` экспортированы в shell на сервере
(`docker compose --env-file ...` подставляет эти значения только внутрь
контейнеров через `environment:`/`env_file:`, но НЕ экспортирует их в
host shell, из которого вы вводите эти команды — попытка положиться на
host-expansion здесь молча подставила бы пустую строку). Вместо этого
`sh -c '...'` выполняется ВНУТРИ контейнера `postgres`, где эти
переменные уже установлены самим Compose (`postgres` service's
`environment:` в `docker-compose.prod.yml`), и раскрываются там.

```bash
# Backup:
docker compose -f docker-compose.prod.yml --env-file ./.env.production \
  exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > "backup_$(date +%Y%m%d).sql"
```

Restore — ТОЛЬКО в disposable/целевую БД, никогда напрямую в production
поверх живых данных. Имя целевой БД передаётся explicit через `-e`
(тоже раскрывается внутри контейнера, не в host shell):

```bash
# Restore:
docker compose -f docker-compose.prod.yml --env-file ./.env.production \
  exec -T -e RESTORE_TARGET_DB=<disposable_или_target_db> postgres \
  sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$RESTORE_TARGET_DB"' \
  < backup_YYYYMMDD.sql
```

`-v ON_ERROR_STOP=1` обязателен: без него `psql` по умолчанию печатает
`ERROR` в stdout/stderr, но продолжает выполнять последующие statements
и завершается с exit code 0 — restore может частично провалиться и
выглядеть успешным. С `ON_ERROR_STOP=1` первая же SQL-ошибка немедленно
прерывает выполнение и `psql` возвращает ненулевой exit code (см. итоговый
отчёт, раздел D).

Креденшлы (`POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`) никогда не
хардкодятся в команде и никогда не выводятся на экран — обе команды
ссылаются на них только по имени переменной, значения которых Compose
уже передал контейнеру.

Проверено (Stage 8B corrective pass) на disposable PostgreSQL: backup
представительных данных → restore в отдельную disposable-БД → данные
подтверждены идентичными (см. итоговый отчёт, раздел F).

### Qdrant (embedded local-path режим)

Приложение открывает Qdrant через `QdrantClient(path=...)` — эксклюзивная
блокировка каталога на диске, никакого сетевого API/snapshot-эндпоинта
здесь не задействовано. Копирование файлов ДЕЙСТВУЮЩЕГО каталога, пока
процесс держит блокировку и потенциально пишет, транзакционно небезопасно
(не проверено/не гарантировано текущим кодом) — поэтому backup требует
короткого окна обслуживания. Это уже было верно и остаётся неизменным:

```bash
# Backup (app остановлен на время копирования):
docker compose -f docker-compose.prod.yml --env-file ./.env.production stop app
docker run --rm -v <project>_qdrant_data:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/qdrant_backup_$(date +%Y%m%d).tar.gz -C /data .
docker compose -f docker-compose.prod.yml --env-file ./.env.production start app
```

(`<project>` — префикс имён volume для этого Compose-проекта; узнать
точно: `docker volume ls | grep qdrant_data`.)

Restore — полный workflow с реальным подключением к работающему стеку
(не заканчивается на распаковке архива в отдельный volume — тот volume
всё равно должен стать ТЕМ volume, который использует `app`). Самый
простой, однозначный способ: раз `docker-compose.prod.yml` использует
фиксированный named volume (`qdrant_data`), восстанавливать нужно
НАПРЯМУЮ в этот volume, пока `app` остановлен — не в отдельный orphan
volume, который потом пришлось бы отдельно "подключать":

```bash
# 1. Убедиться, что app остановлен (ничего не держит Qdrant-лок и не пишет):
docker compose -f docker-compose.prod.yml --env-file ./.env.production stop app

# 2. Восстановить архив НАПРЯМУЮ в actual Compose-managed qdrant_data volume
#    (очистить существующее содержимое volume перед распаковкой, если
#    восстанавливаете поверх уже существующего volume, а не создаёте его
#    заново):
docker run --rm -v <project>_qdrant_data:/data -v "$(pwd)":/backup alpine \
  sh -c 'find /data -mindepth 1 -delete; tar xzf /backup/qdrant_backup_YYYYMMDD.tar.gz -C /data'

# 3. Владение должно соответствовать runtime UID/GID контейнера (10001:10001
#    — см. Dockerfile'а non-root user):
docker run --rm -v <project>_qdrant_data:/data alpine chown -R 10001:10001 /data

# 4. Запустить app обратно — он уже монтирует именно этот volume
#    (docker-compose.prod.yml не меняется, никакого отдельного шага
#    "подключения" не требуется, т.к. это тот же qdrant_data, что app
#    и так использует):
docker compose -f docker-compose.prod.yml --env-file ./.env.production start app

# 5. Убедиться, что embedded Qdrant открылся без ошибок и ожидаемые
#    данные присутствуют:
docker compose -f docker-compose.prod.yml --env-file ./.env.production logs app --tail=50
# (искать отсутствие ошибок открытия/блокировки Qdrant-хранилища; затем
# выполнить представительный RAG-запрос через работающее приложение и
# подтвердить, что ожидаемые данные возвращаются)
```

Проверено (Stage 8B corrective pass) на disposable volume: представительные
данные → backup → restore напрямую в volume с точным именем, которое
Compose использует для `qdrant_data` → ownership 10001:10001 подтверждён
→ содержимое подтверждено идентичным (см. итоговый отчёт, раздел G).

### Uploads

**Важно:** uploads НЕЛЬЗЯ безопасно live-копировать без quiesce. Физический
файл и sidecar-метаданные (см. `handlers/document_upload.py`) появляются
НЕ одним атомарным действием — live-архивирование может поймать
inconsistent point-in-time состояние (файл уже записан, метаданные ещё
нет, или наоборот). Используется та же quiesce-модель, что и для Qdrant:

```bash
# Backup:
docker compose -f docker-compose.prod.yml --env-file ./.env.production stop app
docker run --rm -v <project>_uploads_data:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/uploads_backup_$(date +%Y%m%d).tar.gz -C /data .
docker compose -f docker-compose.prod.yml --env-file ./.env.production start app
```

Restore — полная процедура, никогда напрямую поверх живого volume без
остановки приложения:

```bash
# 1. Остановить app:
docker compose -f docker-compose.prod.yml --env-file ./.env.production stop app

# 2. Восстановить архив в предназначенный uploads volume (тот же
#    <project>_uploads_data при восстановлении на месте, либо новый volume,
#    который затем должен использоваться как uploads_data в Compose):
docker run --rm -v <project>_uploads_data:/data -v "$(pwd)":/backup alpine \
  sh -c 'find /data -mindepth 1 -delete; tar xzf /backup/uploads_backup_YYYYMMDD.tar.gz -C /data'

# 3. Проверить владение/права (должны остаться 10001:10001, как и
#    исходно созданы Dockerfile'ом / Docker при первом монтировании):
docker run --rm -v <project>_uploads_data:/data alpine sh -c 'chown -R 10001:10001 /data && ls -la /data'

# 4. Запустить app:
docker compose -f docker-compose.prod.yml --env-file ./.env.production start app

# 5. Проверить представительное поведение upload/read через работающее
#    приложение (например, загрузить тестовый документ через веб/Telegram
#    UI и убедиться, что ранее восстановленные файлы также доступны для
#    чтения).
```

Ни одна из команд не использует host-specific пути — только named
volumes через disposable helper-контейнер (`alpine` + volume mount), что
одинаково работает на любом сервере.

Проверено (Stage 8B corrective pass) на disposable named volume:
представительный upload + sidecar-metadata файл → quiesced backup →
restore в новый disposable volume → файл и метаданные подтверждены
идентичными, UID 10001 ownership подтверждён (см. итоговый отчёт,
раздел H).

## 16. Просмотр логов

```bash
docker compose -f docker-compose.prod.yml --env-file ./.env.production logs -f app
docker compose -f docker-compose.prod.yml --env-file ./.env.production logs -f postgres
```

Файловый `/app/bot.log` внутри контейнера содержит те же записи (тот же
`configure_logging()`), но не persisted отдельно — см. раздел 12.

## 17. Остановка — normal vs destructive

**Обычная остановка/рестарт (безопасно, данные сохраняются):**

```bash
docker compose -f docker-compose.prod.yml --env-file ./.env.production stop
# или
docker compose -f docker-compose.prod.yml --env-file ./.env.production down
```

`down` (без `-v`) удаляет контейнеры и сети, но **никогда** named volumes
— `postgres_data`/`qdrant_data`/`uploads_data` переживают это.

**ДЕСТРУКТИВНО — необратимо удаляет все данные (PostgreSQL, Qdrant,
uploads). НИКОГДА не часть обычной операционной процедуры:**

```bash
docker compose -f docker-compose.prod.yml --env-file ./.env.production down -v
```

Использовать `-v` осознанно только при полном, намеренном списании
окружения — никогда как способ "просто перезапустить".
