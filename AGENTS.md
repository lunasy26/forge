# AGENTS.md — forge

Инструкции для агентов, которые меняют сам forge. Пользовательская справка — короткие обзоры [README.md](README.md) и [README.ru.md](README.ru.md) и страницы [docs/en/](docs/en/) и [docs/ru/](docs/ru/); обоснование решений — [docs/spec.md](docs/spec.md).

## Ориентация

forge — плагин Claude Code на Node ≥ 20 (ESM, `.mjs`, ни одной зависимости, без сборки). Хуки в `hooks/` — тонкие обёртки: читают событие со stdin, зовут `lib/` и печатают JSON. Вся логика — в `lib/`, её же использует CLI `bin/forge` → `lib/cli.mjs`, поэтому она покрыта юнит-тестами. Скиллы и агенты — markdown-инструкции для модели; механика (то, что должно происходить всегда) живёт в хуках и CLI, а не в тексте скиллов.

| Где | Что |
|---|---|
| `.claude-plugin/` | `plugin.json` (версия плагина), `marketplace.json` (маркетплейс `forge-dev`) |
| `hooks/hooks.json` | события, матчеры, таймауты; `hooks/*.mjs` — по скрипту на событие; обычные хуки идут через `runHook` из `lib/util.mjs`, охранные `pre-bash` и `pre-edit` — без него (см. «Fail-open») |
| `lib/guards.mjs`, `lib/shell.mjs`, `lib/pwsh.mjs`, `lib/glob.mjs` | охрана Bash, PowerShell и файлов (`checkBash`, `checkPowerShell`, общий `checkWords`), разбиение команд Bash и PowerShell, glob-шаблоны |
| `lib/profile.mjs` + `config/profile.schema.json` | профиль: значения по умолчанию, валидация, схема для редактора — держи их в согласии; `work`/`workPaths` — пути спеки и плана (`forge work`) |
| `lib/state.mjs`, `lib/edits.mjs` | `.forge/state.json` и журнал правок `.forge/edits.jsonl` с курсорами |
| `lib/verify.mjs`, `lib/sh.mjs`, `lib/cli.mjs` | запуск команд проверки (оболочка — `/bin/sh` или Git Bash на Windows, `lib/sh.mjs`); команды CLI и `verifyAndRecord` (общая с Stop-хуком) |
| `lib/route.mjs` + `config/routing.json` | роли, таблица режимов, инварианты `checkTable` |
| `lib/detect.mjs` | автоопределение стека для `forge init` |
| `lib/docs.mjs` | агентские файлы: `checkDocs` и `fixDocs` (`forge docs`), `rootDocStatus` (строка начала сессии), `docsReminder` (напоминание в `Stop`, с памятью `state.docs.reminded`); `DEFAULT_DOCS_WATCH` и `DEFAULT_DOCS_MAX_LINES` живут в `lib/profile.mjs` |
| `lib/changelog.mjs` | журнал в формате Keep a Changelog: `parseChangelog`, `checkChangelog` (коды замечаний), `suggestBump` (уровень по записям `[Unreleased]`), `releaseChangelog` (перенос в версию и ссылки сравнения, остальное байт в байт), `bumpVersion`, `compareVersions` (semver — re-export из `lib/semver.mjs`) |
| `lib/semver.mjs` | единственная реализация SemVer: `parseSemver`, `compareSemver`/`compareVersions`, `bumpVersion` (из пре-релиза — как в npm); из модулей forge зависит только от `i18n.mjs` (тексты ошибок), её импортируют `changelog`, `release`, `git`, `detect` |
| `lib/release.mjs` | `release` профиля: обработчики файлов версии (`readVersion`/`writeVersion`: json, pyproject, Cargo, pom, csproj, `{path, pattern}` — правят только текст версии), `releaseReminder` (напоминание в `Stop`, память `state.release.reminded`); команду `forge release` (проверка, предпросмотр, выпуск с откатом) исполняет `cmdRelease` в `lib/cli.mjs`, признаки для `forge init` — `detectRelease` в `lib/detect.mjs` |
| `lib/paths.mjs`, `git.mjs`, `settings.mjs`, `util.mjs` | корень проекта (и `mainWorktree`: в linked worktree без своего профиля `loadProfile` читает профиль основного checkout, state и планы — свои), git, настройки Claude Code, ввод-вывод |
| `agents/`, `skills/` | промпты ролей и скиллов; `skills/docs/` — `/forge:docs` (`SKILL.md` и `guide.md` рядом, подгружается по требованию); `skills/release/` — `/forge:release` (проверка, уровень, `forge release --yes`, push и шаги проекта только с согласия пользователя) |
| `test/` | `node:test`; `helpers.mjs` — временные репозитории, запуск хуков и CLI |
| `docs/en/`, `docs/ru/` | пользовательская справка по страницам (одинаковый набор и структура на двух языках) |
| `docs/spec.md` | спецификация и решения |

## Команды

```bash
npm test                                                  # все тесты
node test/run.mjs test/guards.test.mjs                    # один файл
node test/run.mjs --test-name-pattern "force" test/guards.test.mjs

# CLI против временного проекта
tmp=$(mktemp -d) && git -C "$tmp" init -q -b main
(cd "$tmp" && CLAUDE_PROJECT_DIR= node /path/to/forge/bin/forge init --yes && CLAUDE_PROJECT_DIR= node /path/to/forge/bin/forge doctor)

# хук вручную: событие на stdin, ответ в stdout
echo "{\"cwd\":\"$tmp\",\"tool_input\":{\"command\":\"git push origin main\"}}" \
  | CLAUDE_PROJECT_DIR="$tmp" node hooks/pre-bash.mjs

claude --plugin-dir .                                     # живая проверка плагина
```

`CLAUDE_PROJECT_DIR` важнее текущего каталога при поиске корня проекта. Если он задан в окружении, CLI работает с ним, а не с временным проектом, — очищай его, как это делает `runCli`.

## Инварианты и соглашения

- **Ноль зависимостей.** Только `node:*`. Никакого `npm install`, `node_modules`, транспиляции. Код должен работать на Node 20 и на Windows (CI гоняет Node 20, 22, 24 на ubuntu и windows). Пути — через `node:path`, команды профиля — POSIX sh (на Windows их исполняет Git Bash).
- **Язык.** forge говорит на языке пользователя (английский или русский; выбор — `resolveLang` в `lib/i18n.mjs`, точки входа зовут `initLang`). Всё, что видит пользователь (вывод CLI, причины хуков с префиксом `forge:`, ошибки валидации профиля, таблицы, замечания `forge docs` и `forge release`), — только через каталоги модулей `defineCatalog({ en, ru })` и `t(MSG, key, params)`; строк для пользователя прямо в коде нет, текст собирается лениво, в момент вывода. Русский — полноценный язык, не перевод «для галочки»: ключи и `{подстановки}` совпадают в обоих языках, это проверяет `test/i18n.test.mjs`. Каталоги хуков живут в `lib/hook-messages.mjs`, потому что тест паритета загружает только `lib/`; исключение — `BROKEN` в `pre-bash`/`pre-edit`: этот текст должен выводиться, даже когда `lib/` не загрузился. Логи (`.forge/log/errors.log`), скиллы, агенты и комментарии в коде — по-английски.
- **Fail-open.** Хук никогда не блокирует работу из-за своей ошибки: всё выполняется внутри `runHook`, исключение пишется в лог, выход — 0 без вывода. Не завершай хук ненулевым кодом и не бросай исключения из `loadProfile`/`loadState`. **Исключение — охранные хуки `pre-bash` и `pre-edit`: они fail-closed.** Они не используют `runHook`: чтение stdin, загрузка модулей (динамический `import()`), поиск корня проекта, `loadProfile` и проверка — всё внутри одного `try/catch`, ошибка пишется в лог и превращается в `ask` с причиной «внутренняя ошибка проверки … Подтверди». Охрана команд матчит `Bash|PowerShell`: на Windows Claude Code ведёт команды через PowerShell, и хук только на `Bash` там не сработает. Молчаливый пропуск здесь — дыра в охране: так `protected_files: ["{*}"]` ломал сопоставление шаблонов, и хук разрешал любую правку. Новый охранный хук делай так же; на нечитаемый stdin (нет команды или пути — нечего проверять) он по-прежнему молча выходит.
- **Сломанный профиль не блокирует работу.** `loadProfile` не бросает: невалидный JSON — значения по умолчанию, невалидное поле — значение по умолчанию для поля плюс текст ошибки (его показывают `forge doctor` и начало сессии). Новое поле профиля: значение по умолчанию в `defaultProfile`, проверка в `validateProfile`, слияние в `loadProfile`, описание в схеме, строка в таблице [`profile.md`](docs/ru/profile.md) (и `docs/en/profile.md`).
- **Тишина.** На разрешение охранные хуки ничего не печатают — иначе ломаются обычные разрешения Claude Code. Без `.forge/profile.json` хуки ничего не пишут в проект.
- **Бюджет хуков** (spec §14): все хуки, кроме проверки, — не больше 150 мс p95; внешние процессы — только короткие вызовы `git`. Тест `guard hooks stay fast` проверяет лишь грубую границу (медиана < 1 с), на него не полагайся. Контекст `SessionStart` — не больше 600 символов (`MAX_CONTEXT`, есть тест); добавляй строку, только если без неё модель ошибётся.
- **Состояние** меняется только через `updateState` и `forge state`. Журнал правок — только дозапись: параллельные `PostToolUse` не должны гоняться за `state.json`. У журнала три курсора: `lint_offset`, `verify.edits_offset`, `docs.offset`; новый потребитель журнала передаёт свой курсор в `maybeRotate` и обнуляет его при обнулении журнала. `docs.offset` — одно окно правок на оба напоминания `Stop` (про агентские файлы и про пустой `[Unreleased]`): они читают одни и те же файлы, и если сработали оба, причины идут одним `block`; новое напоминание подключай к этому окну, а не заводи свой курсор. Отсутствующий `docs.offset` — не 0, а «догнал»; когда оба напоминания выключены (`docs.remind: false` и нет раздела `release` или `release.remind: false`), `Stop` удаляет `state.docs`, иначе застывший курсор навсегда заблокировал бы обнуление. Рядом с курсором — память напоминаний: `docs.reminded` (см. `docsReminder`) и `release.reminded` — список ключей (ветка или `<ветка>@<последний тег>`, не больше 20; см. `releaseReminder`).
- **Агентские файлы** forge держит по своей схеме: `AGENTS.md` — источник, рядом `CLAUDE.md` с `@AGENTS.md`. Меняешь список проверок `checkDocs` (коды, уровни, `fixable`) — обнови таблицу кодов в `agent-docs.md` (`docs/en/` и `docs/ru/`) и `skills/docs/SKILL.md` (там режимы выбираются по кодам). Меняешь каталоги, команды или структуру — правь карту выше: `forge docs` и напоминание в `Stop` проверяют именно её. `.forge/` из поиска агентских файлов исключён всегда.
- **Маршрутизация.** Инварианты — в `checkTable`: reviewer ≥ implementer, senior ≥ implementer, reviewer ≥ senior, debugger ≥ senior, в `eco` нет `fable`, имена моделей, effort и ролей известны. Встроенная таблица держит senior строго сильнее implementer. `model`/`effort` во frontmatter агента обязаны совпадать со строкой `normal` — это проверяет тест, список агентов в нём задан явно. У scout нет Edit, Write и Bash, у reviewer — Edit и Write. Переопределения из профиля — всё или ничего.
- **Скиллы** (spec §9): `description` — узкий триггер («Use to…», «Use before…», «Use when…»), без «ты обязан» и «1% шанса»; тело — до ~150 строк и объясняет «почему»; тяжёлая работа уходит ролям через `forge route <role>` и вызов агента с `model` и `effort`; `context: fork` не используется — он фиксирует модель и ломает режимы; команды только для пользователя — `disable-model-invocation: true`.
- **Агенты** не коммитят, не пушат и не переключают ветки — git остаётся за вызывающей сессией.

## Тесты

- `npm test` идёт с `FORGE_LANG=ru`: тесты сообщений проверяют русский текст, английский — в `test/*-en.test.mjs`, где язык задаётся явно. Новое пользовательское сообщение — ключ в обоих языках каталога модуля (`defineCatalog`); без перевода падает тест паритета в `test/i18n.test.mjs`.
- Логика `lib/` — юнит-тесты. Хуки — сквозные: `runHookScript(name, input, { projectDir })` подаёт JSON на stdin и проверяет код выхода, stdout и разобранный JSON. CLI — `runCli(args, { cwd })`.
- Фикстуры — `gitRepo(branch)` (подпись коммитов и глобальные git-хуки выключены), `writeProfile`, `write`, изолированный `CLAUDE_CONFIG_DIR`. Тест не должен читать `~/.claude` разработчика, подписывать коммиты или запускать его git-хуки.
- Любое изменение правила охраны — тесты в `test/guards.test.mjs` и на запрещённое написание, и на похожее разрешённое: ложное срабатывание — тоже баг. Изменения разбора команд — ещё и в `test/glob-shell.test.mjs`.
- Отказ охранных хуков проверяется подменой `lib/guards.mjs` на заглушки, которые бросают исключение: `test/throwing-guards.mjs`, подключается через `NODE_OPTIONS=--import=…` (тест `guard hooks fail closed`); переменная `FORGE_TEST_BROKEN_MODULE` в нём же заставляет выбранный модуль не загрузиться. В продакшен-коде для этого нет шва.
- Новая роль: `config/routing.json` (роль и строка в каждом режиме), `$defs.routingMode` в схеме, инварианты и их тест, при новом агенте — его файл и имя в тесте frontmatter (`test/route-profile.test.mjs`).

## Git

Разработчик один, pull request'ов нет.

1. Короткая ветка от свежего `main`: `feat/…`, `fix/…`, `docs/…`.
2. Коммиты — conventional commits по-русски: `feat(routing): …`, `fix(guards): …`, `docs: …`, `test: …`, `chore: …`.
3. `npm test` зелёный.
4. Локальное слияние в `main` (fast-forward или merge-коммит), ветку удалить, `git push origin main`. CI (`.github/workflows/test.yml`) гоняет `npm test` на ubuntu и windows на push в `main`; ветку можно прогнать вручную — `gh workflow run test.yml --ref <ветка>` (ветка должна быть на GitHub).

Охрана самого forge в этом репозитории настроена локальным `.forge/profile.json` (каталог `.forge/` в `.gitignore`) с `"git": { "protected_branches": [] }`, поэтому push в `main` разрешён. В свежем клоне без этого профиля действуют встроенные `main`/`master`, и push в `main` будет отклонён — сначала создай профиль. `.forge/` не коммить.

## CHANGELOG

- Изменение, заметное тому, кто поставил плагин (поведение хуков и охраны, команды `forge`, скиллы, агенты, формат профиля), получает запись в `CHANGELOG.md` под `[Unreleased]` в той же ветке. Разделы — Added, Changed, Fixed, Removed и «Обновление» (что сделать при переходе).
- Выпуск делает `forge release` (в этом репозитории раздел `release` есть в локальном `.forge/profile.json`; он перечисляет `package.json`, `.claude-plugin/plugin.json` и бейдж версии в обоих README как `version_files`). Сначала `forge release --check`, затем предпросмотр `forge release` — уровень и список файлов; когда они верны, `forge release <уровень> --yes` (чистое дерево; переносит `[Unreleased]` в `[x.y.z] — YYYY-MM-DD`, правит ссылки сравнения и файлы версий, коммит `chore(release): x.y.z`, тег `vx.y.z`; сам ничего не пушит). Потом отправить ветку и тег: `git push origin main && git push origin vx.y.z`. Если локального профиля нет, то же вручную: перенести `[Unreleased]`, поднять `version` в `.claude-plugin/plugin.json`, `package.json` и бейджах README, закоммитить, поставить тег.
- После push — GitHub-релиз на этот тег (с согласия пользователя, как любой шаг выпуска): заголовок `forge x.y.z`, текст — раздел этой версии из `CHANGELOG.md` (от её заголовка до следующего, без самого заголовка), а в конце строка `**Полный список изменений:** https://github.com/lunasy26/forge/compare/vПРЕД...vx.y.z`. Относительные ссылки раздела (`](docs/…`) в тексте релиза не работают — замени их на `https://github.com/lunasy26/forge/blob/vx.y.z/…`. Текст положи во временный файл и выполни `gh release create vx.y.z --verify-tag --title "forge x.y.z" --notes-file <файл> --latest`. Релизы есть для всех версий начиная с 0.1.0 — не пропускай ни одной.
- Меняешь формат журнала, уровни, файлы версий или `release` профиля — обнови `releases.md` в `docs/en/` и `docs/ru/`, `skills/release/SKILL.md` и эту секцию.

## Где решения

- `docs/spec.md` — цели, принципы, архитектура, план версий. Меняешь дизайнерское решение — обнови спеку.
- Спека и план отдельной фичи (`/forge:plan`) лежат по путям поля `work` профиля (`forge work <slug>`); в этом репозитории локальный профиль оставляет умолчание `.forge/work/<slug>/`, в git они не попадают. Когда фича влита, то, что нужно знать дальше, переносится в `docs/spec.md`, AGENTS.md или страницы `docs/en/` и `docs/ru/`; история — в git.
- `README.md` (английский) и `README.ru.md` (русский) — короткие обзоры со ссылками на справку. Сама справка — в `docs/en/` и `docs/ru/`: одинаковый набор страниц (`hooks`, `guards`, `profile`, `routing`, `agent-docs`, `releases`, `skills`, `cli`, `state`, `development`) и одинаковая структура разделов, по фактическому поведению. Меняешь поведение — правь нужную страницу в обоих языках сразу: охрана — `guards.md`, хуки — `hooks.md`, CLI — `cli.md`, профиль — `profile.md`, маршрутизация — `routing.md`. При выпуске — значок версии в обоих README (его правит `forge release`, если бейдж указан в `release.version_files`).
