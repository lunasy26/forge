[English](README.md) · **Русский**

# forge

Плагин Claude Code, который даёт сессии дисциплину процесса хуками, а не уговорами в промпте: охрана git и секретов, формат и линт после правок, проверка перед завершением хода, профиль проекта и выбор модели и effort для ролей-субагентов.

[![test](https://github.com/lunasy26/forge/actions/workflows/test.yml/badge.svg)](https://github.com/lunasy26/forge/actions/workflows/test.yml)
[![version](https://img.shields.io/badge/version-0.4.0-blue)](CHANGELOG.md)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![node ≥ 20](https://img.shields.io/badge/node-%E2%89%A5%2020-339933)](package.json)
[![dependencies: zero](https://img.shields.io/badge/dependencies-zero-brightgreen)](package.json)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)](https://code.claude.com/docs/ru/plugins)

Всё, что должно происходить всегда или никогда, делают хуки и CLI `forge`; скиллы остаются там, где нужно суждение.

В проекте без `.forge/profile.json` работает только [охрана Bash](docs/ru/guards.md#охрана-bash) и [охрана файлов](docs/ru/guards.md#охрана-файлов) со встроенными значениями (защищены ветки `main` и `master`, `.env*` и ключи). Линта и автопроверки нет, хуки ничего не пишут в репозиторий. В git-репозитории без профиля начало сессии добавляет одну строку с подсказкой `/forge:init`, вне git-репозитория — ничего.

> forge говорит на языке, на котором вы пишете, — по-русски или по-английски: вывод CLI, причины хуков (с префиксом `forge:`) и ошибки профиля. Язык берётся из вашего последнего сообщения в сессии, затем из запомненного языка и системной локали, иначе — английский. Закрепить язык можно полем профиля `"language": "ru"` (или `"en"`) и переменной `FORGE_LANG`; подробности — в разделе [«Язык сообщений»](docs/ru/hooks.md#язык-сообщений). В [документации](#документация) сообщения приведены по-русски дословно.

## Зачем forge

- **Механика вместо уговоров.** Правила, которые должны соблюдаться каждый раз, живут в хуках и CLI, а не в тексте промпта капслоком, который модель может и не выполнить.
- **Страховка с первой сессии.** Push в `main`, force push, `--no-verify`, правка `.env` и ключей останавливаются даже в проекте, где forge не настраивали.
- **Ход не заканчивается на красном.** После правок перед завершением хода запускается проверка; падение возвращается Claude, второе подряд передаётся роли `debugger`, а третье отпускает сессию, чтобы не зациклиться.
- **Своя модель под каждую работу.** Каждая роль-субагент получает модель и effort из таблицы, а один переключатель (`eco`, `normal`, `max`) сдвигает всю таблицу.
- **Тихо по умолчанию.** На разрешённые действия ничего не выводится, начало сессии добавляет не больше 600 символов, без профиля в репозиторий ничего не пишется.

## Возможности

| Возможность | Что даёт |
|---|---|
| [Охрана Bash](docs/ru/guards.md#охрана-bash) | `deny` для `git push` в защищённые ветки, force push, `--mirror`, `--no-verify`; `ask` перед `git reset --hard`, `git push --all` и `rm -r` за пределами проекта. Видит команды внутри `bash -c`, `eval` и `$(…)` |
| [Охрана файлов](docs/ru/guards.md#охрана-файлов) | `deny` для инструментов правки на `.env*`, ключах и путях из `protected_files` |
| [Формат и линт](docs/ru/hooks.md#формат-и-линт-после-правок) | После каждой пачки вызовов инструментов `format` и `lint` идут по только что изменённым файлам; ошибки приходят Claude как контекст |
| [Автопроверка](docs/ru/hooks.md#автопроверка-при-завершении-хода) | `verify.steps` перед завершением хода; падение не даёт завершить ход, второе подряд зовёт `debugger`, третье отпускает |
| [Агентские файлы](docs/ru/agent-docs.md#схема-файлов) | `AGENTS.md` — источник, `CLAUDE.md` подключает его; `forge docs` проверяет схему, `/forge:docs` пишет файлы. Новое в 0.3.0 |
| [Напоминание про агентские файлы](docs/ru/agent-docs.md#напоминание-про-агентские-файлы) | Если за ход поменялись команды или структура проекта, Claude один раз просят проверить `AGENTS.md`/`CLAUDE.md`. Новое в 0.3.0 |
| [Выпуски и CHANGELOG](docs/ru/releases.md) | Включаемый раздел `release`: `forge release` проверяет журнал в формате Keep a Changelog, показывает и делает выпуск (журнал, файлы версий, коммит, тег; ничего не пушит); напоминание, если код менялся, а `[Unreleased]` пуст; `/forge:release`. Новое в 0.4.0 |
| [Контекст в начале сессии](docs/ru/hooks.md#контекст-в-начале-сессии) | До 600 символов: режим, проверки, активная задача, предупреждения |
| [Профиль](docs/ru/profile.md) | `.forge/profile.json` со схемой JSON; автоопределение стека для Node/TS, Python, Swift, Go и Rust |
| [Маршрутизация моделей](docs/ru/routing.md) | Модель и effort для каждой роли из таблицы `eco`/`normal`/`max`, проверенной инвариантами; псевдонимы можно [сопоставить с другими моделями](docs/ru/routing.md#другие-модели) |
| [Скиллы](docs/ru/skills.md) | `/forge:init`, `/forge:mode`, `/forge:plan`, `/forge:execute`, `/forge:review`, `/forge:docs`, `/forge:release` |
| [CLI forge](docs/ru/cli.md) | `init`, `state`, `mode`, `route`, `verify`, `docs`, `release`, `doctor` |

## Жизненный цикл сессии

```mermaid
flowchart TD
    S["SessionStart<br/>строка контекста, строка про агентские файлы"] --> W(["Claude работает"])
    W -- "вызов инструмента" --> G{"PreToolUse<br/>охрана Bash, охрана файлов"}
    G -- "deny: причина уходит Claude" --> W
    G -- "ask: выполнится, если пользователь подтвердит" --> T["Инструмент выполняется"]
    G -- "разрешено, молча" --> T
    T --> J["PostToolUse<br/>инструменты правки пишут в журнал правок"]
    J --> B["PostToolBatch<br/>format, затем lint"]
    B -- "ошибка как additionalContext или всё в порядке" --> W
    W -- "пытается завершить ход" --> V{"Stop<br/>verify.steps"}
    V -- "падение: block<br/>второе подряд: подсказка debugger" --> W
    V -- "третье падение при повторной остановке:<br/>отпустить, сообщить пользователю" --> E(["Ход завершён"])
    V -- "прошла или нечего проверять" --> R{"Напоминания по одному окну правок<br/>агентские файлы, пустой Unreleased"}
    R -- "поменялись команды или структура, либо менялся код<br/>при пустом Unreleased:<br/>один block со всеми причинами" --> W
    R -- "напоминать не о чем" --> E
```

[SessionStart](docs/ru/hooks.md#контекст-в-начале-сессии) добавляет короткий контекст. Каждый вызов инструмента проходит [охрану Bash](docs/ru/guards.md#охрана-bash) или [охрану файлов](docs/ru/guards.md#охрана-файлов). Правки попадают в журнал, после каждой пачки идут [формат и линт](docs/ru/hooks.md#формат-и-линт-после-правок). Когда Claude пытается завершить ход, запускается [автопроверка](docs/ru/hooks.md#автопроверка-при-завершении-хода), затем одноразовые напоминания по одному общему окну правок: [про агентские файлы](docs/ru/agent-docs.md#напоминание-про-агентские-файлы) и, если в профиле есть раздел `release`, [про пустой `[Unreleased]`](docs/ru/releases.md#напоминание-про-пустой-unreleased). Если сработали оба, Claude получает один блок с обеими причинами. Все хуки — в [таблице хуков](docs/ru/hooks.md#таблица-хуков).

## Требования

- Node.js ≥ 20 в `PATH`. Зависимостей нет.
- `git` и `/bin/sh`: через него запускаются команды проверки. Поддерживаются macOS и Linux.
- Claude Code с хуками плагинов, включая событие `PostToolBatch`, и каталогом `bin/` плагина в `PATH` Bash-инструмента.

## Установка

### Из GitHub

Репозиторий публичный, учётные данные не нужны. В Claude Code:

```
/plugin marketplace add lunasy26/forge
/plugin install forge@forge-dev
```

`forge-dev` — имя маркетплейса из `.claude-plugin/marketplace.json`: репозиторий сам себе маркетплейс. Подробнее — [установка плагинов](https://code.claude.com/docs/ru/discover-plugins) и [маркетплейсы плагинов](https://code.claude.com/docs/ru/plugin-marketplaces) в документации Claude Code.

Обновление: у сторонних маркетплейсов автообновление по умолчанию выключено. Обновите список командой `/plugin marketplace update forge-dev`, затем сам плагин — `claude plugin update forge@forge-dev` в оболочке (или **Update marketplace** на вкладке **Marketplaces** в `/plugin`) и выполните `/reload-plugins`.

### Локальная разработка

```bash
claude --plugin-dir /path/to/forge
```

Пока плагин включён, CLI `forge` доступен в Bash-инструменте Claude Code. Вне Claude Code — `node /path/to/forge/bin/forge <команда>`. Работа над самим forge — в разделе [Разработка](docs/ru/development.md).

### Конфликт с Superpowers

forge заменяет Superpowers и конфликтует с ним. Если в `enabledPlugins` включён `superpowers@…` (читаются `~/.claude/settings.json` или `$CLAUDE_CONFIG_DIR/settings.json`, затем `.claude/settings.json` и `.claude/settings.local.json` проекта; более поздний файл перекрывает более ранний), forge предупреждает в [начале сессии](docs/ru/hooks.md#контекст-в-начале-сессии) и в [`forge doctor`](docs/ru/cli.md#команды). Отключи его через `/plugin`. Superpowers распознаётся только по `enabledPlugins` в этих трёх файлах настроек.

## Быстрый старт

```
/forge:init → forge doctor → /forge:docs → /forge:mode, /forge:plan → /forge:execute → /forge:review
```

1. **`/forge:init`** в проекте. Скилл запускает `forge init` (только показ), показывает стек, шаги проверки, `verify.on_stop`, защищённые ветки и рискованные пути, спрашивает только о том, что не удалось [определить](docs/ru/profile.md#автоопределение-стека), затем пишет [профиль](docs/ru/profile.md) (`forge init --yes`; см. [что пишет init](docs/ru/profile.md#что-пишет-init)) и запускает `forge doctor`.
2. **`forge doctor`.** Строки `✗` в его выводе — то, что нужно поправить (например, команда проверки, которой нет в `PATH`).
3. **`/forge:docs`**, если в проекте нет `AGENTS.md`: `/forge:init` предложит его в конце. Скилл готовит черновик [агентских файлов](docs/ru/agent-docs.md#схема-файлов) по проекту и ничего не пишет без твоего «да». Если не хватает только ссылок `CLAUDE.md`, `/forge:init` предложит `forge docs --fix`.
4. **Обычная работа.** Мелкие правки делай как обычно — [линт](docs/ru/hooks.md#формат-и-линт-после-правок) и [проверка](docs/ru/hooks.md#автопроверка-при-завершении-хода) сработают сами. `/forge:mode eco|normal|max` выбирает [таблицу моделей](docs/ru/routing.md#модели-по-режимам).
5. **Фича на несколько файлов**: `/forge:plan` (спека и план задач, ждёт «да»), затем `/forge:execute` и `/forge:review`. См. [Скиллы](docs/ru/skills.md).

## Документация

- [Хуки](docs/ru/hooks.md) — таблица хуков, fail-open и fail-closed, контекст в начале сессии, формат и линт после правок, автопроверка при завершении хода, напоминания в конце хода.
- [Охрана](docs/ru/guards.md) — охрана Bash и охрана файлов: как читается команда, правила и вердикты, сокращённые опции git, рекурсивный `rm`, защищённые ветки и файлы.
- [Профиль](docs/ru/profile.md) — `.forge/profile.json`: пример, каждое поле со значением по умолчанию, сломанный профиль, автоопределение стека, что пишет `forge init`.
- [Маршрутизация моделей](docs/ru/routing.md) — роли, модели по режимам, лестница повторов, инварианты, переопределения, другие модели и провайдеры.
- [Агентские файлы](docs/ru/agent-docs.md) — схема `AGENTS.md`/`CLAUDE.md`, `forge docs` и коды замечаний, напоминание про агентские файлы.
- [Выпуски и CHANGELOG](docs/ru/releases.md) — `forge release`, выбор уровня, файлы версии, проверки журнала, напоминание про пустой `[Unreleased]`, `/forge:release`.
- [Скиллы](docs/ru/skills.md) — все скиллы `/forge:*` и формат задачи в плане.
- [CLI forge](docs/ru/cli.md) — все команды с кодами выхода, корень проекта.
- [Файлы и состояние](docs/ru/state.md) — каталог `.forge/`, файл состояния, журнал правок и его курсоры.
- [Разработка](docs/ru/development.md) — структура репозитория, тесты, новое правило охраны или роль.

## Ссылки

### Документы проекта

- [CHANGELOG.md](CHANGELOG.md) — история изменений.
- [docs/spec.md](docs/spec.md) — спецификация и обоснование решений. Начиналась как черновик v0.1; раздел об этапах перечисляет и то, что ещё не сделано: уровни задач и `risky_paths` в хуках, `SubagentStart`, агенты `mechanic` и `architect`, скиллы `debug` и `finish`.
- [AGENTS.md](AGENTS.md) — правила разработки forge для людей и агентов.
- [LICENSE](LICENSE) — MIT.

### Документация Claude Code

- [Справочник по хукам](https://code.claude.com/docs/ru/hooks) — события, матчеры, `decision`, `additionalContext`, `PostToolBatch`.
- [Плагины](https://code.claude.com/docs/ru/plugins) и [справочник манифеста плагина](https://code.claude.com/docs/ru/plugins-reference) — устройство и манифест плагина.
- [Маркетплейсы плагинов](https://code.claude.com/docs/ru/plugin-marketplaces) — как работает `/plugin marketplace add`.
- [Субагенты](https://code.claude.com/docs/ru/sub-agents) — файлы агентов, `model` и инструменты.
- [Скиллы](https://code.claude.com/docs/ru/skills) — `SKILL.md`, `description`, `disable-model-invocation`.
- [Память](https://code.claude.com/docs/ru/memory) — `CLAUDE.md`, импорт через `@`, вложенные файлы.
- [Настройка модели](https://code.claude.com/docs/ru/model-config) — псевдонимы моделей, `ANTHROPIC_DEFAULT_*_MODEL`, effort.

### Стандарты

- [AGENTS.md](https://agents.md/) — открытый формат инструкций для агентов.
- [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/) — формат CHANGELOG.
- [Семантическое версионирование](https://semver.org/lang/ru/) — номера версий.

## Лицензия

MIT — см. [LICENSE](LICENSE).
