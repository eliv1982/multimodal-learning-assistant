# Production-развёртывание

Операционный runbook для развёртывания, обновления, отката и восстановления
приложения через `docker-compose.prod.yml` за внешним Traefik. Приложение
работает в production на [learn.elivcloud.org](https://learn.elivcloud.org).

Не меняет архитектуру приложения: один процесс (`python service_main.py`,
Telegram + web в одном asyncio-процессе — см. README.md, «Единый процесс:
Telegram + web»), один embedded-режим Qdrant, один PostgreSQL.

## Текущее состояние production

- Приложение доступно по https://learn.elivcloud.org, развёртывание завершено;
  репозиторий на сервере находится на актуальной ветке `main`.
- Сервисы `app` и `postgres` — `healthy`.
- Внешняя Traefik-сеть — `n8n_n8n_network`, entrypoint — `websecure`,
  certificate resolver — `letsencrypt` (раздел 4).
- Access-логирование Traefik выключено (раздел 4a).
- Порт приложения (8000) и порт PostgreSQL (5432) наружу не публикуются.
  Приложение достигает PostgreSQL по уникальному приватному алиасу
  `mla-postgres-internal` во внутренней сети `app-internal`.
- Вход через GitHub ограничен allowlist (`GITHUB_ALLOWED_USER_IDS`);
  связывание Telegram настроено и работает.
- Первичная production smoke-проверка пройдена: web-чат, загрузка и удаление
  документов через web, RAG-поиск в связанном Telegram (раздел 11).
- Известное ограничение — переподключение к PostgreSQL после его перезапуска
  (раздел 18).

## 1. Prerequisites

- Docker Engine + Docker Compose v2 на целевом сервере.
- Работающий Traefik-стек с внешней Docker-сетью, к которой подключаются
  проксируемые приложения (см. раздел 4).
- DNS-запись `learn.elivcloud.org` указывает на этот сервер (раздел 3).
- Реальные production-креденшлы: Telegram bot token, OpenAI API key,
  Anthropic API key, отдельное GitHub OAuth App для продакшна.
- Репозиторий склонирован на сервере; рабочая директория — корень
  репозитория (где лежат `Dockerfile`, `docker-compose.prod.yml`).
- Креденшлы выпущены и проверены в соответствии с разделом 1a.

## 1a. Креденшлы: ротация и хранение

Любые значения перечисленных ниже креденшлов, которые могли быть видны вне
защищённого секрет-хранилища (рабочие материалы, логи, скриншоты и т.п.),
считаются **скомпрометированными** и НЕ ДОЛЖНЫ использоваться в production.
Их нужно выпустить заново (rotate) до запуска стека — и при любом подозрении
на компрометацию позже:

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

**НЕ входит в ротацию:**

- **`GITHUB_CLIENT_ID`** — это публичный идентификатор OAuth App, не
  секрет; ротация не требуется.
- **`TELEGRAM_ALLOWED_USER_IDS`** — это не credential (числовой Telegram
  user id, не секрет доступа сам по себе), ротация не требуется. Тем не
  менее это privacy-значение: убедитесь, что список содержит только
  реально предназначенных пользователей.
- **`GITHUB_ALLOWED_USER_IDS`** — тот же статус, что и
  `TELEGRAM_ALLOWED_USER_IDS` выше: не credential, ротация не требуется,
  но это ОБЯЗАТЕЛЬНОЕ privacy/access-control значение — продукт
  private/invite-only, а не публичный. Пусто/не задано = вход через GitHub
  запрещён всем (fail closed), НЕ "всем разрешено" — успешная GitHub OAuth-
  аутентификация сама по себе недостаточна для доступа к web-приложению
  (см. `utils/github_access_control.py`). Укажите здесь числовые GitHub user
  id (never `login`/username) владельца и каждого доверенного пользователя.

**Требования к процессу:**

- Старые (скомпрометированные) значения перечисленных выше категорий
  НЕЛЬЗЯ использовать в production ни при каких обстоятельствах.
- `.env.production` на production-сервере должен содержать ТОЛЬКО новые,
  ротированные значения.
- Новое значение должно быть проверено (например, пробный вызов API/успешный
  OAuth-обмен/успешная Telegram `get_me`) ДО запуска или перезапуска
  production-стека с ним (раздел 8).

Реальные значения секретов никогда не записываются в этот или любой другой
файл репозитория.

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
`.env`, который может существовать в директории по другой причине:
`env_file:` — это буквальный путь, на который не влияет
`docker compose --env-file`, и общее имя `.env` могло бы тихо загрузить
посторонние локальные dev-секреты (например, через `docker compose config`).
`.env.production` уже в `.gitignore` — никогда не коммитить.

Сгенерировать секреты:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"  # SESSION_SECRET_KEY
python -c "import secrets; print(secrets.token_urlsafe(32))"  # POSTGRES_PASSWORD (URL-safe — интерполируется в DSN буквально)
```

## 3. DNS

`learn.elivcloud.org` должен резолвиться на публичный IP production-сервера
**до** первого запуска (это не проверяется кодом приложения). Для нового
сервера или нового имени хоста обновите DNS-запись, `Host(...)` в Traefik-
labels `docker-compose.prod.yml` и `GITHUB_REDIRECT_URI` в `.env.production`
(он должен точно совпадать с callback URL production OAuth App).

## 4. Внешняя Traefik-сеть

`docker-compose.prod.yml` объявляет `app-public` как `external: true` —
Compose ожидает, что эта Docker-сеть **уже существует**, созданная
существующим Traefik-стеком, и никогда не создаёт/не удаляет её сама.

Значения, с которыми работает production (задаются в `.env.production`):

| Переменная | Значение в production |
|---|---|
| `TRAEFIK_NETWORK_NAME` | `n8n_n8n_network` |
| `TRAEFIK_ENTRYPOINT` | `websecure` |
| `TRAEFIK_CERT_RESOLVER` | `letsencrypt` |

Это значения конкретного сервера. При развёртывании на другом сервере
подтвердите реальные имена до первого запуска:

```bash
docker network ls                      # найти имя Traefik-сети
docker network ls | grep -i traefik    # или по известному имени сети
docker inspect <существующий-проксируемый-контейнер> --format '{{json .Config.Labels}}'  # entrypoint/certresolver-конвенции
```

Эти три переменные в `docker-compose.prod.yml` объявлены через
required-variable синтаксис (`${VAR:?...}`) — БЕЗ defaults. Пока они не
установлены, `docker compose config`/`build`/`up` завершается ошибкой
явно (fail closed), а не тихо подставляет непроверенное значение.
`.env.production.example` намеренно оставляет их пустыми.

### PostgreSQL: приватный алиас

`DATABASE_URL` приложения вычисляется Compose из `POSTGRES_*` и указывает на
уникальный алиас `mla-postgres-internal` во внутренней сети `app-internal`
(`internal: true`, без выхода в интернет), а не на обычное имя сервиса
`postgres`: `app` подключён и к `app-internal`, и к общей Traefik-сети, а на
ней посторонний контейнер может публиковать алиас `postgres` — тогда имя
`postgres` резолвилось бы в чужой контейнер. Порт 5432 никогда не
публикуется ни на хост, ни в публичную сеть.

## 4a. Security requirement: OAuth callback query-параметры в reverse-proxy логах

`GET /api/auth/github/callback` получает sensitive query-параметры
(`code`, `state` — одноразовый authorization code и CSRF-state OAuth 2.0
обмена). Приложение уже учитывает это на своей стороне (Uvicorn access
logging отключён). Но reverse-proxy (Traefik) по умолчанию может писать
полный запрошенный URL, включая query string, в свои access-логи — это
самостоятельная утечка sensitive данных, независимая от логирования
приложения.

**Состояние в production:** access-логирование Traefik выключено, поэтому
query-параметры callback не попадают в access-логи Traefik.

**Требование (остаётся в силе при любом изменении конфигурации Traefik и
при развёртывании на другом сервере):** для маршрута
`/api/auth/github/callback` на стороне Traefik должно быть выполнено одно из:

- access logging отключён (глобально или для этого конкретного маршрута); ИЛИ
- query string / sensitive параметры (`code`, `state`) редактируются
  (redacted) в access-логе.

Конкретный Traefik-синтаксис здесь намеренно не фиксируется — он зависит
от версии/конфигурации Traefik на сервере (статический vs динамический
конфиг, уже используемые middleware у других проксируемых приложений).
Проверка (повторяйте после любого изменения конфигурации логирования):

1. Убедитесь, что требование отражено в реальной Traefik-конфигурации
   маршрута `mla` (см. `docker-compose.prod.yml`'s
   `traefik.http.routers.mla.*` labels и конфигурацию самого Traefik).
2. Выполните dummy-запрос на `/api/auth/github/callback` с тестовыми
   `code`/`state` значениями (реальный OAuth-обмен для этого не нужен —
   подходит любой GET-запрос с этими query-параметрами, даже если
   приложение ответит ошибкой из-за невалидного `state`).
3. Просмотрите Traefik access-логи (если они включены) за это время.
4. Подтвердите, что значения `code`/`state` НЕ присутствуют в
   просмотренных логах (ни в открытом виде, ни частично).

## 5. Сборка

```bash
docker compose -f docker-compose.prod.yml --env-file ./.env.production build
```

Собирает `Dockerfile` из репозитория: multi-stage сборка (frontend на
Node 24, runtime на Python 3.12), приложение работает под непривилегированным
пользователем (UID/GID 10001). Каталоги, в которые приложение пишет во время
работы (`data/qdrant`, `data/documents/uploads`, `data/generated_images`,
`bot.log`), создаются и передаются этому пользователю при сборке образа —
без `data/generated_images` процесс падал бы при старте.

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

## 10. HTTPS и маршрутизация

После каждого (пере)развёртывания и любого изменения Traefik-конфигурации:

- `curl -I https://learn.elivcloud.org/healthz` → `200`, валидный TLS-сертификат.
- Реальные Traefik-labels (`entrypoints`/`certresolver`) соответствуют
  конфигурации Traefik на сервере (раздел 4).
- Порт 8000 НЕ достижим напрямую с хоста/извне, только через Traefik;
  порт 5432 не опубликован вообще.

## 11. Smoke-проверка

Выполняйте после первого запуска на новом окружении и после значимых
обновлений. На текущем production первичная smoke-проверка пройдена.

- **Telegram:** написать боту от аккаунта из `TELEGRAM_ALLOWED_USER_IDS`,
  получить ответ. Неавторизованный `from_user.id` получает отказ (fail
  closed).
- **Web-вход:** войти через GitHub аккаунтом из `GITHUB_ALLOWED_USER_IDS`.
  Аккаунт вне списка не входит и не оставляет следа в таблицах идентичности.
- **Связывание Telegram:** на сайте «Link Telegram» → открыть диплинк в
  Telegram и нажать Start → «Check link status» показывает связанный
  аккаунт. Связывайте аккаунты ДО загрузки документов через web: документы
  GitHub-стороны при слиянии не переносятся и блокируют связывание.
- **Web-чат:** отправить сообщение, получить ответ.
- **Документы:** загрузить документ через web и удалить его.
- **RAG в связанном Telegram:** загрузить документ через web, в Telegram
  включить `/mode rag` и задать вопрос по этому документу — ответ строится
  по загруженному документу. (Web-чат RAG не использует.)

## 12. Persistence-проверки

```bash
docker volume ls | grep <project>_          # postgres_data, qdrant_data, uploads_data
docker compose -f docker-compose.prod.yml --env-file ./.env.production restart app postgres
# данные должны остаться
```

Если перезапускается только `postgres` при работающем `app` — см. раздел 18.

`/app/data/generated_images` и `/app/bot.log` **намеренно** не
volume-mounted: вывод DALL-E эфемерен, а файловый лог избыточен поверх
`docker compose logs`, который пишет то же самое в консоль.

**Operational note: рост `/app/bot.log`.** Это ожидаемое поведение, не баг:

- `/app/bot.log` эфемерен — живёт в writable-слое контейнера, не в
  named volume, и не переживает пересоздание контейнера
  (`up --force-recreate`, замену образа и т.п.).
- Все те же записи доступны через `docker compose ... logs app`
  (тот же `configure_logging()` пишет и в файл, и в консоль) — файл не
  является единственным источником логов.
- `FileHandler` пишет в `bot.log` БЕЗ ротации, поэтому файл может расти
  неограниченно в течение всего времени жизни контейнера.
- Operator должен учитывать использование storage контейнера
  (`docker system df`, `docker inspect` container size) на длинных
  интервалах между пересозданиями.
- При аномальном росте допустимо controlled пересоздание контейнера
  (`docker compose ... up -d --force-recreate app`) ПОСЛЕ того, как
  нужные логи уже сохранены через `docker compose ... logs app` — это
  операция над контейнером, а не настройка logrotate на хосте.

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

После обновления выполните разделы 9–10 (health, HTTPS/routing) и, для
значимых изменений, раздел 11.

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
прерывает выполнение и `psql` возвращает ненулевой exit code.

Креденшлы (`POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`) никогда не
хардкодятся в команде и никогда не выводятся на экран — обе команды
ссылаются на них только по имени переменной, значения которых Compose
уже передал контейнеру.

### Qdrant (embedded local-path режим)

Приложение открывает Qdrant через `QdrantClient(path=...)` — эксклюзивная
блокировка каталога на диске, никакого сетевого API/snapshot-эндпоинта
здесь не задействовано. Копирование файлов ДЕЙСТВУЮЩЕГО каталога, пока
процесс держит блокировку и потенциально пишет, транзакционно небезопасно
(не гарантировано текущим кодом) — поэтому backup требует короткого окна
обслуживания:

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

## 18. Известные ограничения

- **Переподключение к PostgreSQL после его перезапуска.** Smoke-проверка
  перезапуска PostgreSQL показала, что первый запрос / первая сессия после
  перезапуска базы могут завершиться ошибкой из-за необходимости
  переподключения. Вероятная причина — устаревшие соединения в пуле: общий
  SQLAlchemy engine (`db/engine.py`) создаётся без `pool_pre_ping`. Это
  принято как известное ограничение и не блокирует эксплуатацию. Если после
  перезапуска только `postgres` ошибки сохраняются, перезапустите и `app`
  (`docker compose -f docker-compose.prod.yml --env-file ./.env.production restart app`).
  Улучшение устойчивости, отложенное на после развёртывания: включить
  `pool_pre_ping` для engine.
- **Одна реплика приложения.** Embedded Qdrant держит эксклюзивную
  блокировку каталога, поэтому второй экземпляр `app`, использующий тот же
  volume, не запустится; масштабирование `app` в несколько реплик не
  поддерживается.
- **Backup Qdrant и uploads требует окна обслуживания** (остановка `app`) —
  см. раздел 15.
