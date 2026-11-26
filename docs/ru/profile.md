[English](../en/profile.md) · **Русский**

← [README](../../README.ru.md)

# Профиль

Профиль проекта — `.forge/profile.json`. Его вместе с копией схемы пишет [`forge init`](#автоопределение-стека).

**На этой странице:**

- [Пример](#пример)
- [Поля профиля](#поля-профиля)
- [Сломанный профиль](#сломанный-профиль)
- [Профиль в worktree](#профиль-в-worktree)
- [Автоопределение стека](#автоопределение-стека)
- [Что пишет init](#что-пишет-init)

## Пример

```json
{
  "$schema": "./profile.schema.json",
  "version": 1,
  "commands": {
    "format": "npx prettier --write --ignore-unknown {files}",
    "lint": { "run": "npx eslint {files}", "ext": [".ts", ".tsx"] },
    "typecheck": "npx tsc --noEmit",
    "test": "npm test",
    "test_fast": { "run": "npx vitest related --run {files}", "ext": [".ts", ".tsx"] }
  },
  "verify": { "steps": ["typecheck", "lint", "test"], "on_stop": "fast", "timeout_sec": 300 },
  "git": { "protected_branches": ["main", "master", "release/*"] },
  "protected_files": ["secrets/**", "!config/dev.key"],
  "risky_paths": ["**/migrations/**", ".github/workflows/**"],
  "work": { "spec": "docs/specs/{slug}.md", "plan": "docs/plans/{slug}.md" },
  "docs": { "remind": true, "max_lines": 200 },
  "release": { "tag_prefix": "v", "version_files": ["package.json"] },
  "tdd": "encouraged",
  "mode": "normal",
  "routing": { "normal": { "implementer": "opus/medium" } }
}
```

## Поля профиля

| Поле | Тип | Если не задано | Смысл |
|---|---|---|---|
| `$schema` | string | — | `forge init` пишет `./profile.schema.json` |
| `version` | `1` | — | Версия формата |
| `commands` | объект: имя → строка или `{ "run": string, "ext": [".ext"] }` | `{}` | Команды оболочки, написанные на синтаксисе POSIX `sh`: запускаются в `/bin/sh`, на Windows — в Git Bash (из Git for Windows; без него форматирование, линт и проверка пропускаются, а не падают: пользователь получает [разовое уведомление](hooks.md#какая-оболочка-запускает-команды), а [`forge doctor`](cli.md#команды) об этом скажет). `format` и `lint` запускает [`PostToolBatch`](hooks.md#формат-и-линт-после-правок); `test_fast` подменяет `test` в быстрой проверке; любые имена можно звать из `verify.steps` |
| `verify.steps` | string[] | `[]` | Имена из `commands` по порядку ([автопроверка](hooks.md#автопроверка-при-завершении-хода)). Пустой список — автопроверки нет. Шаг, которого нет в `commands`, отбрасывается с ошибкой |
| `verify.on_stop` | `off` \| `fast` \| `full` | `fast` | `off` — Stop не проверяет; `fast` — `test_fast` вместо `test`; `full` — шаги как есть |
| `verify.timeout_sec` | целое 1–540 | `300` | Общий бюджет одной проверки на все шаги |
| `git.protected_branches` | string[] | `["main", "master"]` | [Ветки](guards.md#защищённые-ветки), куда нельзя пушить. **Заменяет** встроенный список, а не дополняет его; `[]` снимает защиту веток |
| `protected_files` | string[] | `[]` | **Дописывается** к [встроенному списку](guards.md#охрана-файлов); `!шаблон` снимает защиту. Сопоставление без учёта регистра (`.ENV` и `KEY.PEM` тоже защищены) |
| `risky_paths` | string[] | `[]` | Хуки его не применяют. Читает [`forge:plan`](skills.md#forgeplan): работа здесь — уровень 3 и роль `senior` |
| `work.spec` | string | `.forge/work/{slug}/spec.md` | Шаблон пути спеки, которую пишет [`forge:plan`](skills.md#forgeplan), от корня проекта. `{slug}` обязателен, `{date}` (локальная дата, `YYYY-MM-DD`) — по желанию; другие `{…}`, пробельные символы, одинарные кавычки, абсолютные пути (начальные `/` или `\`, буква диска) и сегменты `..` отклоняются. Пути пишутся с `/`: обратные косые черты в шаблоне заменяются. Невалидное значение даёт ошибку и заменяется значением по умолчанию. Хуки его не применяют; готовые пути печатает [`forge work <slug>`](cli.md#команды) |
| `work.plan` | string | `.forge/work/{slug}/plan.md` | То же для плана; путь должен отличаться от `work.spec` (если они совпали, оба берутся по умолчанию). По умолчанию оба файла локальные: вне git, у каждого worktree свои. С путями внутри репозитория (`docs/specs/{slug}.md`, `docs/plans/{slug}.md`) они коммитятся вместе с изменением и приезжают с веткой; forge их никогда не удаляет. `review.md` и резервные копии `forge docs` в обоих случаях остаются в `.forge/work/`. Пути сравниваются без учёта регистра, `./` и повторных разделителей: `docs/{slug}.md` и `./Docs//{slug}.md` считаются одинаковыми. При наличии [раздела `release`](releases.md#как-включить) шаблон, не подпадающий под `release.ignore` (по умолчанию тесты, `docs/**` и Markdown), считается изменением кода для [напоминания о `[Unreleased]`](releases.md#напоминание-про-пустой-unreleased) |
| `tdd` | `off` \| `encouraged` \| `required` | `encouraged` | Учитывают [скиллы](skills.md): при `required` `forge:plan` ставит тестовые задачи раньше реализации, `forge:execute` передаёт настройку исполнителю. Хуки не применяют |
| `secrets.check` | boolean | `true` | `false` выключает [проверку секретов в коммите](guards.md#секреты-в-коммите) и вопрос про `git add .env`; без профиля проверка включена |
| `secrets.ignore` | string[] | `[]` | Шаблоны файлов, которые проверка секретов пропускает (и имя, и содержимое), от корня проекта; [синтаксис](guards.md#синтаксис-шаблонов) как у `protected_files`, без учёта регистра |
| `docs.remind` | boolean | `true` | `false` отключает [напоминание про агентские файлы](agent-docs.md#напоминание-про-агентские-файлы) в конце хода; [`forge docs`](agent-docs.md#команда-forge-docs) работает всегда |
| `docs.max_lines` | целое > 0 | `200` | Длиннее этого агентский файл получает замечание [`too-long`](agent-docs.md#коды-замечаний) |
| `docs.watch` | string[] | встроенный список | **Дописывается** к встроенному (см. [Что считается изменением](agent-docs.md#что-считается-изменением)); [синтаксис](guards.md#синтаксис-шаблонов) как у `protected_files`, `!шаблон` снимает, в том числе встроенный (`"!Makefile"`) |
| `release` | объект | нет | Включает [выпуски и журнал изменений](releases.md). Без него ничего из этого не работает; `{}` включает всё со значениями ниже |
| `release.changelog` | string | `CHANGELOG.md` | Путь к журналу изменений от корня проекта. Формат — Keep a Changelog |
| `release.tag_prefix` | string | `v` | Префикс git-тега версии (`v1.2.3`); `""` даёт `1.2.3` |
| `release.version_files` | (string \| `{ "path", "pattern" }`)[] | `[]` | Файлы, где записана версия, `forge release` держит их в согласии: путь (обработчик выбирается по имени файла) или путь с `pattern` с одной группой захвата. См. [Файлы версии](releases.md#файлы-версии). Пусто — версия живёт только в журнале и тегах |
| `release.remind` | boolean | `true` | `false` отключает [напоминание про пустой `[Unreleased]`](releases.md#напоминание-про-пустой-unreleased); `forge release` работает всегда |
| `release.ignore` | string[] | встроенный список | **Дописывается** к встроенному списку файлов, правка которых не требует записи в журнале: `test/**`, `tests/**`, `**/__tests__/**`, `**/*.test.*`, `**/*.spec.*`, `docs/**`, `*.md`, `**/*.md`, `.forge/**`; [синтаксис](guards.md#синтаксис-шаблонов) как у `protected_files`, `!шаблон` снимает, в том числе встроенный (`"!docs/**"`) |
| `language` | `auto` \| `en` \| `ru` | `auto` | Язык сообщений forge. `auto` — язык, на котором вы пишете, см. [«Язык сообщений»](hooks.md#язык-сообщений) (запасной — английский); `en` или `ru` — всегда этот язык. Переменная окружения `FORGE_LANG` важнее профиля |
| `mode` | `eco` \| `normal` \| `max` | `normal` | [Режим](routing.md#модели-по-режимам) по умолчанию; режим из `forge mode` хранится в состоянии и важнее профиля |
| `routing` | `{ режим: { роль: "model/effort" } }` | `{}` | Переопределения таблицы моделей, см. [Переопределения из профиля](routing.md#переопределения-из-профиля) |

## Сломанный профиль

Сломанный профиль не блокирует работу. Профиль накладывается на значения по умолчанию. Невалидный JSON — действуют все значения по умолчанию; невалидное поле — значение по умолчанию для этого поля, остальные применяются. Ошибки показывают [`forge doctor`](cli.md#команды) и (числом) [начало сессии](hooks.md#контекст-в-начале-сессии).

## Профиль в worktree

`.forge/` не коммитится, поэтому в новом linked worktree (например, `.claude/worktrees/<имя>`, который создаёт Claude Code) своего профиля нет. Тогда forge читает профиль основного checkout: охрана, проверка, линт и переопределения маршрутизации работают так же, как там. Профиль самого worktree важнее — `forge init` в worktree заводит свой. Унаследованный профиль только читается; состояние, журнал правок и планы у worktree [свои](state.md#журнал-правок). [`forge doctor`](cli.md#команды) пишет `✓ Профиль из основного checkout <путь>`, [начало сессии](hooks.md#контекст-в-начале-сессии) — такую же строку.

Основной checkout forge находит по файлам `.git` и `commondir` без запуска процессов; для bare-репозитория и отдельного git-каталога — по первой записи `git worktree list`. У worktree bare-репозитория основного checkout нет, у submodule наследования тоже нет. Закоммиченный профиль есть в каждом worktree и наследование не нужно.

## Автоопределение стека

`forge init` выбирает первый найденный стек в порядке ниже, остальные попадают в заметки. `verify.steps` — те из `typecheck`, `lint`, `test`, что нашлись. Ветки — `main`, `master` и ветка по умолчанию у `origin`; `risky_paths` — `**/migrations/**`, `.github/workflows/**`. Отдельно от стека `forge init` предлагает [раздел `release`](releases.md#как-включить), если проект похож на тот, что выпускает версии.

Поле `work` `init` пишет всегда. Если каталог `docs/specs/` или `docs/plans/` существует, он предлагает пути внутри репозитория `docs/specs/{slug}.md` и `docs/plans/{slug}.md` (с заметкой), иначе — значения по умолчанию в `.forge/work/`. `forge init --work local|docs` выбирает явно: `local` — значения по умолчанию, `docs` — пути в репозитории; любое другое значение — код выхода 2.

| Стек | Признаки | Команды |
|---|---|---|
| Node/TS | `package.json`; npm, pnpm, yarn или bun по lock-файлу | `format`: prettier или biome; `lint`: eslint по файлам или скрипт `lint`; `typecheck`: скрипт `typecheck`/`type-check` или `tsc --noEmit` при `tsconfig.json`; `test`: скрипт `test`; `test_fast`: `vitest related` или `jest --findRelatedTests` |
| Python | `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`; префикс `uv run` или `poetry run` по lock-файлу | ruff format и check, mypy или pyright, `pytest -q` |
| Swift | `Package.swift`, `*.xcodeproj`, `*.xcworkspace` | swiftformat и swiftlint при их конфигах, `swift test` для SwiftPM; `on_stop: "off"` — тесты долгие |
| Go | `go.mod` | `gofmt -w {files}`, `go vet ./...`, `go test ./...` |
| Rust | `Cargo.toml` | `rustfmt {files}`, `cargo clippy`, `cargo test` |

## Что пишет init

| Путь | Содержимое | В git |
|---|---|---|
| `.forge/profile.json` | [профиль](#поля-профиля) проекта | на твоё усмотрение |
| `.forge/profile.schema.json` | копия схемы; профиль ссылается на неё через `"$schema"` — автодополнение в редакторе | вместе с профилем |
| `.git/info/exclude` | строки `.forge/state.json`, `.forge/edits.jsonl`, `.forge/work/`, `.forge/log/` | — |

Исключения пишутся в `info/exclude` общего git-каталога (действуют во всех worktree); `.gitignore` проекта не меняется. Закоммиченный профиль даёт всем, у кого стоит forge, те же проверки и охрану; коммить его вместе с `profile.schema.json`.
