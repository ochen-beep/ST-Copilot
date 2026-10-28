# Project State — ST-Copilot

Снимок состояния на **2026-10-28**. Обновлять при существенных изменениях (версия, архитектура, крупные фиксы).

## Что это

SillyTavern-расширение «Copilot» — боковое окно-ассистент поверх основного чата: собственные сессии диалога с моделью, инструменты (tool calling), управление лорбуком/карточкой персонажа/сообщениями чата через structured-блоки в ответах модели, память (memories), статистика, темы. Версия **2.10.0** (`manifest.json`).

## Архитектура (краткая карта)

```
index.js            — точка входа: init, CHAT_CHANGED, хоткеи, слушатели панели
style.css           — корень: только @import-порядок; секции в styles/*.css (18 файлов)
src/
  session.js        — хранилище сессий: bucket-файл на чат, save-queue, epoch-guard
  api.js            — генерация (транспорт/стрим, tool-раунды, runGenerate/runContinue);
  api/prompt-builder.js  — buildSystemContent + сигнатура кэша + assembleMessages + токены
  api/request-inspector.js — журнал запросов, редакция секретов, перехват fetch
  changelog.js      — данные changelog (вынесены из constants)
  state.js          — глобальный state + кэш системного промпта
  constants.js      — дефолты настроек, промпты, темы (changelog → changelog.js)
  features/         — 12 модулей: memory, tools, lorebook, character, chatedit,
                      attachments, stats (каждый engine/ui-парой где применимо)
  ui/
    ui-chat.js      — фасад (72 строки); реализация в 5 модулях:
    render-msg.js   — markdown/HTML-блоки/tool-плейсхолдеры/тело сообщения
    msg-actions.js  — свайпы, edit/regen/delete, скролл-хелперы, код-блоки
    session-view.js — renderSession/appendMsgEl/updateMsgCount, onChatChanged
    search.js       — поиск по сессии
    chat-picker.js  — выбор сообщений основного чата
    chat-shared.js  — общие модульные ссылки + окно ленивого рендера
    ui-window/ui-settings/ui-widgets/ui-launcher, render/ (stream-renderer,
    find-safe-boundary, render-window)
  integrations/     — regex, summaryception, evolutia
  utils/            — текст, ST-хелперы, хэш, DOM, дебаг
```

Модель пишет structured-блоки, которые парсит расширение: ```` ```memory-update ````, ```` ```tool_call ````, блоки изменений лорбука / карточки / сообщений чата.

## Хранение данных

- Сессии чата — bucket-файл `copilot_sess_*.json` в user files ST, ссылка в `chatMetadata.st_copilot` (формат v4, привязка к chat_id). В bucket — все сессии чата + `activeSessionId`.
- Памяти, статистика, настройки — в `extensionSettings.ST-Copilot` (settings.json ST).
- Tool-сообщения раундов — временные (`_tcTemp`), на диск не пишутся.

## Состояние на дату снимка

- Тесты: **208 / 208 проходят** (20 файлов, vitest).
- Репозиторий: ~52 МБ на диске (46 МБ — игнорируемый node_modules); история переписана `git filter-repo` (вырезан Assets/DS, −28 МБ; `.git` 43→4,6 МБ). `.gitignore` расширен (`*.log`, `Thumbs.db`, `.DS_Store`, `dist/`).
- Рабочее дерево: чистое; фазы 0–4 плана фиксов закоммичены полностью.
- **Режим работы: только локально.** Пуш в GitHub (в т.ч. force-push переписанной истории) не выполняется по решению владельца; origin `Supker/ST-Copilot` остаётся позади локального main и синхронизируется вручную, когда и если понадобится. Старая история сохранена в локальной ветке `backup/pre-filter-repo` (удалить после проверки: `git branch -D backup/pre-filter-repo`).

## История недавних изменений

- `6292961` chore: stream-fence tests, render/stability fixes, extend .gitignore
- `ba77f6d` fix(tools): порядок плейсхолдеров tool_call
- `7467fa8` feat: надёжность правок/сессий, инспектор запросов, UX-волна
- `4254139` docs(qa): manual test plan and test report
- До этого: нативный function calling, веб-тулы, инспектор контекста, session overrides, lorebook manager.

## Известные проблемы

Полный список с приоритетами и местами в коде — **[CODE_REVIEW.md](CODE_REVIEW.md)** (промежуточное ревью от 2026-10-28; находки 1.2 опровергнуты живым тестом — см. отзыв в тексте). Статус после фаз 0–2 плана [FIX_PLAN.md](FIX_PLAN.md):

**Исправлено (фазы 0–2, коммиты `0a2931b`…`1a9e82c`):**
- P0 двойное удаление сообщения в чат-редакторе; утечка session-scoped памятей в новые сессии; транспортные сбои хранилища больше не считают порчей; `EXT_DISPLAY` в свайп-гуардах; инвалидация промпта при правке authors_note/persona; зомби-генерация после смены чата; гонки и молчаливые потери при записи bucket; дубли tool-раундов (отозвано — бага не было).
- Фаза 2: гварды edit/delete на время генерации, закрытие пикера при смене чата, fallback tool-карточек и HTML-блоков reasoning; сериализация применений лорбука и честный провал embedded-книг; ремаппинг индексов батчей чат-редактора; сверка applied/pending в UI персонажей; `ask_user` не залипает (Stop/смена чата/таймаут); надёжность записи bucket (await-flush, visibilitychange, ретрай); сигнатура промпта без stats-churn и с живыми входами; памяти на стабильном ключе `avatar` с identity-safe миграцией и капом значения.

**Осталось (фаза 4 — распил монолитов):** см. FIX_PLAN.md. Из заметного: `style.css` 5201 строк (лимит 800), 10 JS-файлов за хард-капом 700, `README.md` 274 строки RU (лимит 80 EN), ключ `characterId` в статистике (памяти уже переведены на `avatar`). P3-мелочи закрыты в фазе 3; единственное осознанно отложенное — слоты tool-плейсхолдеров при пустых фенсах (см. пометку в FIX_PLAN).

## Открытые вопросы / следующие шаги

1. Фаза 4: распил монолитов `ui-chat.js` / `style.css` / `api.js` и остальных за капом, README → 80 строк EN + `USER_GUIDE.md` (RU).
2. Пуш в GitHub не выполняется (работа только локально, по решению владельца).
