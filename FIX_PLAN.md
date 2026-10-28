# Fix & Refactor Plan — ST-Copilot

План работ по итогам [CODE_REVIEW.md](CODE_REVIEW.md) от 2026-10-28. Статусы обновляются по мере выполнения.

Процесс: каждый пункт — отдельный коммит; после **каждого** фикса — `vitest run` (176 базовых тестов — красная линия) **и** проверка на живой таверне `http://127.0.0.1:8001/` (инициализация расширения без ошибок консоли + функциональная проверка конкретного пути, где возможна без LLM). Фиксы и рефакторинг не смешиваются в одном коммите.

## Фаза 0 — зафиксировать текущее

- [x] Фикс инвалидации кэша системного промпта при смене активной сессии (`session.js`)
- [x] `CODE_REVIEW.md`, `PROJECT_STATE.md`
- [ ] Коммит фазы 0

## Фаза 1 — P0 и острые P1

- [ ] **1.1 (P0)** Двойное удаление сообщения: одиночный `delete` → паттерн `msg_indices`-ветки (splice + `_saveChatAfterDelete`, без `ctx.deleteMessage`) — `feature-chatedit-engine.js:359`
- [ ] **1.2 (P1)** Дубли tool-раундов: пушить только дельту раунда, компакция применяется и к запушенным `_tcTemp`; чистая функция + юнит-тест — `api.js:1300-1321`
- [ ] **1.3 (P1)** Транспорт ≠ порча: `loadSessionFile` → `null` на HTTP-сбой, `false` только на порчу; recovery только на порчу — `session.js:356, 476`
- [ ] **1.4 (P1)** Импорт `EXT_DISPLAY` в `ui-chat.js:682`
- [ ] **1.5 (P1)** Инвалидация промпта в ветках `saveCharacterField` (authors_note/persona/evolutia) — `feature-character-engine.js:527+`
- [ ] **1.6 (P1)** `onChatChanged` → `generationStopped = true`; сброс флага в `_runSwipeRegen` — `ui-chat.js:2167, 842`

## Фаза 2 — устойчивость (P2)

- [ ] UI-гварды: edit/delete/regen во время генерации; закрытие чат-пикера в `onChatChanged`; fallback tool-карточек в `restoreMessageDOM` + `postProcessHTMLBlocks` для reasoning
- [ ] Атомарность применений: сериализация `applyLBChanges` per-book; embedded-книга — честный провал + guard в `deleteEntryDetail`; ремаппинг индексов батча чат-редактора; char-ui сверка applied/pending
- [ ] `ask_user`: привязка к abort/Stop + таймаут
- [ ] Персистентность сессий (одним заходом): await flush в `initChatBucket`; tombstone пустого bucket; стратегия закрытия вместо keepalive (64 KiB); ретрай + тост на провал сейва
- [ ] Сигнатура системного промпта: stats из хэша, покрытие live-входов, тесты `decideSystemPromptCache` (до распила api.js)
- [ ] Памяти: ключ по `avatar` с миграцией; лимит аппенда при повторном `add` (дефолтный scope не менять)

## Фаза 3 — P3 sweep (1–2 коммита)

- [ ] Поисковые хайлайты при «показать ещё»; rewrite-кейс стрим-рендерера; позиция курсора; ре-чек мобильности; retry импорта regex; function-replacer в summaryception; try/catch в `init()`; подрезка бакетов статистики

## Фаза 4 — рефакторинг монолитов (отдельные коммиты «только сплит»)

- [ ] `ui-chat.js` 2288 → render/ actions/ search/ chat-picker/ chat-events
- [ ] `style.css` 5201 → ≤800 + `styles/*.css` через `@import`
- [ ] `api.js` 1683 → prompt-builder / generation / tool-rounds / request-inspector
- [ ] `constants.js` (changelog → данные), `feature-lorebook-ui.js` 1344, `ui-settings.js` 1289, `ui-widgets.js` 1241, character-модули, `chatedit-ui.js` 719
- [ ] README ≤80 строк EN + `USER_GUIDE.md` (RU)
