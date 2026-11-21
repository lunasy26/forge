[English](../en/routing.md) · **Русский**

← [README](../../README.ru.md)

# Маршрутизация моделей

Каждая роль получает модель и effort из таблицы режима. Основную сессию forge не трогает: её модель выбирает пользователь. Роли вызывают скиллы [`/forge:plan`, `/forge:execute`, `/forge:review` и `/forge:docs`](skills.md); сами агенты — [субагенты](https://code.claude.com/docs/ru/sub-agents) Claude Code.

**На этой странице:**

- [Роли](#роли)
- [Модели по режимам](#модели-по-режимам)
- [Как скиллы вызывают роль](#как-скиллы-вызывают-роль)
- [Лестница повторов](#лестница-повторов)
- [Инварианты](#инварианты)
- [Переопределения из профиля](#переопределения-из-профиля)
- [Другие модели](#другие-модели)
- [Ограничения](#ограничения)

## Роли

| Роль | Кто исполняет | Для чего |
|---|---|---|
| `scout` | `forge:scout` (Read, Grep, Glob) | Найти и прочитать код, вернуть выжимку с `path:line` |
| `mechanic` | `forge:implementer` | Правка по точной инструкции |
| `implementer` | `forge:implementer` (Read, Grep, Glob, Edit, Write, Bash) | Задача плана |
| `senior` | `forge:implementer` | Задача, которую нельзя описать до конца или где ошибка дорога; первый повтор после падения implementer |
| `architect` | основная сессия (`agent=main`) | Спека и план; строка таблицы справочная |
| `reviewer` | `forge:reviewer` (Read, Grep, Glob, Bash) | Ревью диффа |
| `debugger` | `forge:debugger` (все инструменты) | Эскалация после повторных падений |

## Модели по режимам

| Роль | eco | normal | max |
|---|---|---|---|
| scout | haiku / low | haiku / low | sonnet / medium |
| mechanic | sonnet / low | sonnet / medium | sonnet / high |
| implementer | sonnet / medium | sonnet / high | opus / high |
| senior | sonnet / high | opus / high | opus / xhigh |
| architect | sonnet / high | opus / high | opus / xhigh |
| reviewer | sonnet / high | opus / high | fable / high |
| debugger | opus / high | fable / high | fable / high |

Сила сравнивается сначала по модели (`haiku` < `sonnet` < `opus` < `fable`), затем по effort (`low` < `medium` < `high` < `xhigh` < `max`). Режим переключают [`/forge:mode`](skills.md#forgemode) и [`forge mode`](cli.md#команды); значение по умолчанию — из поля профиля [`mode`](profile.md#поля-профиля).

## Как скиллы вызывают роль

Скилл выполняет [`forge route <role>`](cli.md#команды) и получает `role=… mode=… agent=… model=… effort=…`, затем вызывает агента из `agent=` с этими `model` и `effort`; при `agent=main` работу делает сама сессия. Поэтому `/forge:mode eco` меняет модели следующих вызовов без правки файлов агентов. `model` и `effort` во frontmatter агентов равны строке `normal` и нужны только как запасной вариант, если агента вызвали без них. У `mechanic` и `senior` своего файла нет: без `forge route` они получают значения implementer — `sonnet/high`, то есть senior окажется слабее, чем по таблице.

## Лестница повторов

Её применяет [`forge:execute`](skills.md#forgeexecute):

| Упала роль | Первый повтор, с логом падения | Второе падение |
|---|---|---|
| `mechanic` | `implementer` | `debugger` с обоими логами |
| `implementer` | `senior` | `debugger` |
| `senior` | `senior` | `debugger` |
| любая другая (например, `scout`) | та же роль | `debugger` |

Если и `debugger` не справился, скилл останавливается и сообщает пользователю, что заблокировано. Отдельно Stop-хук подсказывает `debugger` на [втором падении проверки подряд](hooks.md#падения-подряд).

## Инварианты

`checkTable` в `lib/route.mjs`, для каждого режима:

- у каждой роли значение `model/effort` с известной моделью и effort; неизвестных ролей нет;
- reviewer не слабее implementer; senior не слабее implementer; reviewer не слабее senior; debugger не слабее senior;
- в `eco` нет `fable`.

Тесты дополнительно требуют, чтобы во встроенной таблице senior был строго сильнее implementer, frontmatter агентов совпадал со строкой `normal`, у scout не было Edit, Write и Bash, а у reviewer — Edit и Write.

## Переопределения из профиля

[`routing`](profile.md#поля-профиля) накладывается на встроенную таблицу по режимам и ролям, и результат проверяется теми же инвариантами. Любая ошибка — и игнорируется весь блок `routing` во всех режимах, действует встроенная таблица. Об этом сообщают [начало сессии](hooks.md#контекст-в-начале-сессии) (числом), `forge doctor` (строки `✗ routing: …`), `forge mode` (строка `! переопределения routing из профиля проигнорированы: …` в stdout) и `forge route` (в stderr). Переопределение может уравнять senior и implementer — тогда первый повтор просто повторит ту же модель.

## Другие модели

forge нигде не называет конкретную модель. Таблица, [`forge route`](#как-скиллы-вызывают-роль) и frontmatter агентов используют только псевдонимы `haiku`, `sonnet`, `opus` и `fable`, а скиллы передают псевдоним субагенту как есть (параметр `model` инструмента Agent принимает псевдоним, а не полное имя модели). Claude Code сам превращает каждый псевдоним в настоящую модель, а какую именно — выбираете вы; подробнее — [настройка модели](https://code.claude.com/docs/ru/model-config) в документации Claude Code.

### Как сопоставить псевдонимы с моделями

| Псевдоним | Переменная окружения |
|---|---|
| `haiku` | `ANTHROPIC_DEFAULT_HAIKU_MODEL` |
| `sonnet` | `ANTHROPIC_DEFAULT_SONNET_MODEL` |
| `opus` | `ANTHROPIC_DEFAULT_OPUS_MODEL` |
| `fable` | `ANTHROPIC_DEFAULT_FABLE_MODEL` |

Значение — полное имя модели или равнозначный идентификатор вашего провайдера. Задайте их в оболочке, из которой запускается Claude Code, или в блоке `env` файла настроек:

```json
{
  "env": {
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "<быстрая модель>",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "<модель на каждый день>",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "<сильная модель>",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "<самая сильная модель>"
  }
}
```

То же сопоставление работает:

- через LLM-шлюз, заданный `ANTHROPIC_BASE_URL`: эта переменная меняет, куда уходят запросы, а четыре переменные выше — какие модели запрашиваются у шлюза (см. [LLM-шлюзы](https://code.claude.com/docs/ru/llm-gateway); направлять Claude Code через шлюз к моделям не Claude Anthropic не поддерживает);
- на Amazon Bedrock, Google Cloud Agent Platform (Vertex AI) и Microsoft Foundry: значения — идентификаторы провайдера (ARN профиля инференса, имя версии, имя развёртывания). Документация Claude Code и так советует закреплять их там.

### Что от модели не зависит

[Хуки](hooks.md), [охрана](guards.md), линт и проверка, напоминания в конце хода, [профиль](profile.md) и [CLI `forge`](cli.md) — код на Node и shell: они ведут себя одинаково, какая бы модель ни работала в сессии и в субагентах. [Скиллы](skills.md) — инструкции: следовать им может любая модель, но насколько хорошо она планирует, ревьюит и держится шагов, зависит от модели.

### Оговорки

- **Сохраняйте порядок псевдонимов.** Сила сравнивается по псевдониму (`haiku` < `sonnet` < `opus` < `fable`), а не по моделям за ними. [Инварианты](#инварианты) — reviewer не слабее implementer, debugger не слабее senior и остальные — имеют смысл, только если ваше сопоставление сохраняет этот порядок: более сильная модель — за более поздним псевдонимом.
- **Effort нужна поддержка в модели.** Claude Code включает уровни effort, узнавая идентификатор модели. Для идентификатора, которого он не знает (ARN в Bedrock, имя развёртывания в Foundry), effort выключен, и `effort` роли не применяется, пока вы не объявите поддержку в `ANTHROPIC_DEFAULT_<ALIAS>_MODEL_SUPPORTED_CAPABILITIES`, например `effort,xhigh_effort,max_effort` (`xhigh` и `max` — отдельные возможности). Эти переменные действуют на Bedrock, Agent Platform и Foundry.
- **`CLAUDE_CODE_SUBAGENT_MODEL` сам по себе роли не меняет**: это модель для субагентов, которым модель не задана иначе, а forge задаёт её всегда. Если же добавить `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`, все субагенты работают на этой одной модели — модель из вызова и `model` агентов игнорируются, — и режимы и роли больше не выбирают модели.
- **`CLAUDE_CODE_EFFORT_LEVEL`** важнее effort из вызова и `effort` агентов: если он задан, все роли работают на этом уровне.
- **Псевдоним семейства следует за основной сессией.** Если основная сессия работает на модели того же семейства, субагент с этим псевдонимом работает на версии основной сессии: при основной сессии на конкретной версии Opus роли `opus` работают на ней же.

## Ограничения

- Что скилл вызовет роль через `forge route` с нужными `model` и `effort`, обеспечивает модель, а не механика ([Как скиллы вызывают роль](#как-скиллы-вызывают-роль)).
