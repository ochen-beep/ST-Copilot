# Project State — ST-Copilot

Снимок состояния на **2026-10-28**. Обновлять при существенных изменениях (версия, архитектура, крупные фиксы).

## Что это

SillyTavern-расширение «Copilot» — боковое окно-ассистент поверх основного чата: собственные сессии диалога с моделью, инструменты (tool calling), управление лорбуком/карточкой персонажа/сообщениями чата через structured-блоки в ответах модели, память (memories), статистика, темы. Версия **2.10.0** (`manifest.json`).

## Архитектура (краткая карта)

```
index.js            — точка входа: init, CHAT_CHANGED, хоткеи, слушатели панели
src/
  session.js        — хранилище сессий: bucket-файл на чат (copilot_sess_*.json через
                      /api/files/upload, base64), save-queue с дебаунсом 1с, epoch-guard,
                      session overrides, системный кэш-инвалидации
  api.js            — сборка запроса: buildSystemContent (кэш с сигнатурой),
                      assembleMessages (system + roleplay_context + история сессии),
                      генерация (стрим/не-стрим, custom/ConnectionManager/ST-сервисы),
                      tool-раунды, fetch-патч нормализации тела запроса, requestLog
  state.js          — глобальный state + кэш системного промпта (dirty-flag + сигнатура)
  constants.js      — дефолты настроек, промпты, changelog
  features/         — 12 модулей: memory, tools (engine/ui), lorebook (engine/ui),
                      character (engine/ui/manager), chatedit (engine/ui), attachments, stats
  ui/               — ui-chat (2288 строк: рендер сессии, экшены сообщений, поиск,
                      чат-пикер), ui-window, ui-settings, ui-widgets, ui-launcher,
                      render/ (stream-renderer + find-safe-boundary)
  integrations/     — regex, summaryception, evolutia
  utils/            — текст, ST-хелперы, хэш, DOM, дебаг
```

Модель пишет structured-блоки, которые парсит расширение: ```` ```memory-update ````, ```` ```tool_call ````, блоки изменений лорбука / карточки / сообщений чата.

## Хранение данных

- Сессии чата — bucket-файл `copilot_sess_*.json` в user files ST, ссылка в `chatMetadata.st_copilot` (формат v4, привязка к chat_id). В bucket — все сессии чата + `activeSessionId`.
- Памяти, статистика, настройки — в `extensionSettings.ST-Copilot` (settings.json ST).
- Tool-сообщения раундов — временные (`_tcTemp`), на диск не пишутся.

## Состояние на дату снимка

- Тесты: **176 / 176 проходят** (15 файлов, vitest).
- Репозиторий: ~52 МБ на диске (46 МБ — игнорируемый node_modules); история переписана `git filter-repo` (вырезан Assets/DS, −28 МБ; `.git` 43→4,6 МБ). `.gitignore` расширен (`*.log`, `Thumbs.db`, `.DS_Store`, `dist/`).
- Рабочее дерево: фикс инвалидации кэша сессий (`createSession`/`deleteCurrentSession`/`importSession` → `invalidateSystemPromptCache`) + `CODE_REVIEW.md` + `PROJECT_STATE.md` — **не закоммичено**.
- **Force-push в origin отложен**: аккаунт `ochen-beep` не имеет прав записи в `Supker/ST-Copilot` (403). После получения прав: `git push origin main --force`. Старая история сохранена в локальной ветке `backup/pre-filter-repo` (удалить после проверки: `git branch -D backup/pre-filter-repo`).

## История недавних изменений

- `6292961` chore: stream-fence tests, render/stability fixes, extend .gitignore
- `ba77f6d` fix(tools): порядок плейсхолдеров tool_call
- `7467fa8` feat: надёжность правок/сессий, инспектор запросов, UX-волна
- `4254139` docs(qa): manual test plan and test report
- До этого: нативный function calling, веб-тулы, инспектор контекста, session overrides, lorebook manager.

## Известные проблемы

Полный список с приоритетами и местами в коде — **[CODE_REVIEW.md](CODE_REVIEW.md)** (промежуточное ревью от 2026-10-28). Верхний уровень:

1. **P0:** двойное удаление сообщения в чат-редакторе (`feature-chatedit-engine.js:359`).
2. **P1:** дублирование tool-истории между раундами (`api.js:1300`); транспортная ошибка трактуется как порча bucket (`session.js:356`); ReferenceError `EXT_DISPLAY` в свайп-гуардах (`ui-chat.js:682`); правки authors_note/persona не инвалидируют кэш промпта (`feature-character-engine.js:527`); zombie-генерация после смены чата (`ui-chat.js:2167`); `characterId`-индекс как ключ памятей/статистики (`session.js:161`).
3. **Гигиена:** `style.css` 5201 строк (лимит 800), 10 JS-файлов за хард-капом 700 (хуже всех `ui-chat.js` — 2288), `README.md` 274 строки RU (лимит 80, EN).

Исправлено в этом цикле: утечка session-scoped памятей в новые сессии (кэш системного промпта теперь сбрасывается при создании/удалении/импорте сессии).

## Открытые вопросы / следующие шаги

1. Закоммитить фикс кэша + доки (после решения по P0 — чинить ли сразу).
2. Получить права записи на GitHub → force-push (см. выше).
3. Разобрать P0/P1 из CODE_REVIEW.md в порядке рекомендаций (раздел «Рекомендованный порядок работ»).
4. Долгосрочно: распил `ui-chat.js` и `style.css`, переписать README (beep-hygiene), пересмотреть ключ персонажа для памятей.
