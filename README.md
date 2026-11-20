# forge

Плагин Claude Code: дисциплина процесса через хуки, а не уговоры в промпте. Охрана git и секретов, автопроверка перед завершением хода, профиль проекта и выбор модели и effort для субагентов по ролям.

Подробности устройства — в [docs/spec.md](docs/spec.md).

## Что делает

| Механизм | Поведение |
|---|---|
| Охрана Bash | Запрещает push в защищённые ветки, `push --force` (кроме `--force-with-lease` в свою ветку), `--no-verify`. Спрашивает подтверждение на `reset --hard`, `push --all` и `rm -r` за пределами проекта |
| Охрана файлов | Запрещает правку `.env*`, ключей и путей из `protected_files` |
| Линт после правок | После каждой пачки правок запускает `format` и `lint` по изменённым файлам и возвращает ошибки Claude |
| Автопроверка | Перед завершением хода, если были правки, прогоняет `verify.steps`. Падение не даёт завершиться; на 2-м падении подряд предлагает роль debugger, на 3-м отпускает и сообщает тебе |
| Роли и модели | `forge route <role>` выдаёт модель и effort для роли по таблице режима `eco / normal / max` |
| Короткий контекст | В начале сессии — до 5 строк: режим, проверка, активная задача |

Без профиля в проекте работает только охрана; плагин ничего не пишет в репозиторий.

## Установка

Локально, для разработки:

```bash
claude --plugin-dir /path/to/forge
```

Постоянно — через этот репозиторий как маркетплейс (в Claude Code):

```
/plugin marketplace add /path/to/forge
/plugin install forge@forge-dev
```

Superpowers при этом лучше выключить: forge предупредит, если он включён.

## Использование

| Команда | Что делает |
|---|---|
| `/forge:init` | Определить стек и создать `.forge/profile.json` |
| `/forge:mode eco` | Переключить таблицу моделей (`eco`, `normal`, `max`) |
| `/forge:plan` | Короткая спека и план задач в `.forge/work/<slug>/` |
| `/forge:execute` | Выполнить план ролями-субагентами с проверкой каждой задачи |
| `/forge:review` | Ревью диффа субагентом-ревьюером с перепроверкой находок |

CLI `forge` доступен в Bash, пока плагин включён: `forge help`.

## Таблица моделей

| Роль | eco | normal | max |
|---|---|---|---|
| scout | haiku / low | haiku / low | sonnet / medium |
| mechanic | sonnet / low | sonnet / medium | sonnet / high |
| implementer | sonnet / medium | sonnet / high | opus / high |
| architect | sonnet / high | opus / high | opus / xhigh |
| reviewer | sonnet / high | opus / high | fable / high |
| debugger | opus / high | fable / high | fable / high |

Переопределения — в `routing` профиля. Они применяются, только если ревьюер остаётся не слабее исполнителя и в `eco` нет Fable.

## Разработка

```bash
npm test
```

Ноль зависимостей, Node ≥ 20.
