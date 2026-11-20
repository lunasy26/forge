[English](../en/development.md) · **Русский**

← [README](../../README.ru.md)

# Разработка

Как устроен репозиторий forge и как его менять. Правила для тех, кто меняет forge (в том числе для агентов), — в [AGENTS.md](../../AGENTS.md); спецификация и обоснование решений — в [docs/spec.md](../spec.md).

## Структура репозитория

```
.claude-plugin/     plugin.json (манифест, версия), marketplace.json (маркетплейс forge-dev)
hooks/              hooks.json и тонкие обёртки над lib/: JSON со stdin → JSON в stdout
lib/                вся логика: guards, shell, glob, profile, state, edits, verify, docs, changelog, release, route, detect, cli, git, paths, settings, util
config/             routing.json (роли и таблица режимов), profile.schema.json
agents/             scout, implementer, reviewer, debugger
skills/             init, mode, plan, execute, review, docs, release
bin/forge           точка входа CLI
test/               node:test; helpers.mjs — временные репозитории, запуск хуков и CLI
docs/               spec.md — спецификация и решения; en/, ru/ — эта документация
.github/workflows/  test.yml: npm test на Node 20, 22, 24
```

Устройство плагина — по [справочнику манифеста плагина](https://code.claude.com/docs/ru/plugins-reference) Claude Code.

## Запуск тестов

```bash
npm test                              # FORGE_LANG=ru node --test test/*.test.mjs (без кавычек: glob раскрывает оболочка, Node 20 его не умеет)
node --test test/guards.test.mjs      # один файл (без FORGE_LANG — английский; тестам русских сообщений нужен FORGE_LANG=ru)
```

`npm test` идёт с `FORGE_LANG=ru`, поэтому большинство тестов проверяют русские сообщения. Английские лежат в `test/*-en.test.mjs` (`cli-en`, `core-en`, `guards-en`, `hooks-en`) и сами задают язык. Выбор языка и тест паритета каталогов — в `test/i18n.test.mjs`.

## Как тестируются хуки

`runHookScript(name, input, { projectDir })` из `test/helpers.mjs` запускает `node hooks/<name>.mjs`, подаёт событие JSON на stdin, задаёт `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT` и изолированный `CLAUDE_CONFIG_DIR` (настройки разработчика не читаются) и возвращает код выхода, stdout и разобранный JSON. Проекты-фикстуры — `gitRepo(branch)` (временный репозиторий без подписи коммитов и git-хуков), `writeProfile`, `write`; CLI — `runCli(args, { cwd })`.

## Новое правило охраны

1. Логика — в `lib/guards.mjs` (`checkPush`, `checkCommit`, `checkGit`, `checkRm` или новая ветка по имени команды в `checkBash`); вердикт — `deny(…)` или `ask(…)` с причиной, начинающейся с `forge:`, на обоих языках (см. [«Новое сообщение»](#новое-сообщение)). Разбор команды — `lib/shell.mjs`.
2. Тесты в `test/guards.test.mjs`: запрещённые написания и похожие разрешённые; изменения разбора — в `test/glob-shell.test.mjs`.
3. [Таблица правил](guards.md#правила-охраны) здесь и в [английской версии](../en/guards.md#guard-rules) и запись в `CHANGELOG.md`.

## Новое сообщение

Всё, что видит пользователь, идёт через каталог; строки для пользователя прямо в коде не пишутся.

1. В модуле, рядом с кодом, который его использует, есть каталог: `const MSG = defineCatalog({ en: { … }, ru: { … } })` (`defineCatalog` из `lib/i18n.mjs`). Ключ добавляется в оба языка. Сообщение — строка с подстановками `{name}` или, если текст надо собирать (числа, списки), функция от параметров.
2. Использование — `t(MSG, 'key', { name: value })`. Для отсутствующего ключа каталог откатывается на английский, но ключ, которого нет в `en`, бросает исключение.
3. Собирайте текст лениво: вызывайте `t` там, где формируется сообщение, а не при загрузке модуля, потому что язык выбирается во время работы через `initLang` (в каждом хуке и в CLI). Готовые строки в константах верхнего уровня не держите.
4. `test/i18n.test.mjs` импортирует все модули `lib/` и проверяет, что у каждого зарегистрированного каталога в `en` и `ru` одинаковые ключи, типы значений и `{подстановки}`; нехватка перевода роняет `npm test`.
5. Тесты текста сообщений: русские — в обычных файлах (`npm test` идёт с `FORGE_LANG=ru`), английские — в `test/*-en.test.mjs`.
6. Логи, комментарии в коде, скиллы и агенты остаются английскими и не переводятся.

## Новая роль

1. `config/routing.json`: `roles.<role>.agent` (существующий агент или `null` — основная сессия) и строка роли в каждом из `eco`, `normal`, `max`.
2. `config/profile.schema.json`: роль в `$defs.routingMode.properties` — там `additionalProperties: false`, без этого переопределение не пройдёт схему.
3. Если роль стоит на [лестнице](routing.md#лестница-повторов) — [инварианты](routing.md#инварианты) в `checkTable` (`lib/route.mjs`) и тесты в `test/route-profile.test.mjs`: встроенная таблица их проходит, нарушающие переопределения отклоняются.
4. Новый агент — `agents/<name>.md` с `model`/`effort`, равными строке `normal`, и его имя в списке теста frontmatter в `test/route-profile.test.mjs`.
5. Скиллы, которые вызывают роль; [страница маршрутизации](routing.md) на обоих языках и `CHANGELOG.md`.
