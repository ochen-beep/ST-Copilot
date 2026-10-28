# Fix & Refactor Plan — ST-Copilot

План работ по итогам [CODE_REVIEW.md](CODE_REVIEW.md) от 2026-10-28. Статусы обновляются по мере выполнения.

Процесс: каждый пункт — отдельный коммит; после **каждого** фикса — `vitest run` (176 базовых тестов — красная линия) **и** проверка на живой таверне `http://127.0.0.1:8001/` (инициализация расширения без ошибок консоли + функциональная проверка конкретного пути, где возможна без LLM). Фиксы и рефакторинг не смешиваются в одном коммите.

## Фаза 0 — зафиксировать текущее

- [x] Фикс инвалидации кэша системного промпта при смене активной сессии (`session.js`)
- [x] `CODE_REVIEW.md`, `PROJECT_STATE.md`
- [ ] Коммит фазы 0

## Фаза 1 — P0 и острые P1

- [x] **1.1 (P0)** Двойное удаление сообщения: одиночный `delete` → паттерн `msg_indices`-ветки (splice + `_saveChatAfterDelete`, без `ctx.deleteMessage`) — `feature-chatedit-engine.js:359` ✅ 2026-10-28: vitest 177/177 (новый регресс-тест), живая таверна: удаление ровно 1 из 4 сообщений через карточку proposals
- [x] **1.2 (P1)** Дубли tool-раундов — ❌ **ложное срабатывание ревью**, фикс не требуется. Живая проверка 2026-10-28 (перехват тел запросов, 2 tool-раунда): 3 запроса содержали 4 → 6 → 8 сообщений, по одной паре assistant/tool_results на раунд, дублей `tool_call_id` нет. Причина ошибки ревью: не учтён `session.messages.filter(m => !m._tcTemp)` в конце каждого раунда (`api.js:1370`)
- [x] **1.3 (P1)** Транспорт ≠ порча: `loadSessionFile` → контракт `object/null/false` (порча — только непарсящийся payload, с .corrupt-бэкапом), транспортные сбои бросают; `initChatBucket` через `safeLoad`/`abortIfTransport` прерывается без записей. ✅ 2026-10-28: vitest 184/184 (новый storage-transport.test.js, 7 тестов), живая таверна: fetch→503 + CHAT_CHANGED даёт тост-предупреждение, 0 записей, метаданные нетронуты; восстановление — штатная загрузка без recovery
- [x] **1.4 (P1)** Импорт `EXT_DISPLAY` в `ui-chat.js:682` ✅ 2026-10-28: гварды в бандле ссылаются на объявленную константу, страница здорова
- [x] **1.5 (P1)** Инвалидация промпта в ветках `saveCharacterField` (authors_note/persona/evolutia_user) ✅ 2026-10-28: vitest 187/187 (новый char-edit-invalidation.test.js), страница здорова
- [x] **1.6 (P1)** `onChatChanged` → `generationStopped = true` (abort сам по себе не останавливает tool-раунды: цикл проверяет флаг, а не уже занулённый контроллер); сброс флага в `_runSwipeRegen` ✅ 2026-10-28: vitest 187/187, живая таверна: смена чата посреди tool-генерации — 0 новых API-запросов за 16с наблюдения (всего 2: старт + уже запущенный раунд), панель генерации погашена

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
