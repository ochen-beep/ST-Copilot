// Синтетический LLM-бэкенд для повторяемых живых тестов ST-Copilot.
//
// КАК ЗАПУСКАТЬ (не vitest — живая таверна + браузерная автоматизация):
//   1. Открыть таверну, дождаться загрузки, перехватить fetch:
//      содержимое этого файла вставляется как тело tab.playwright.evaluate(...)
//      (файл — валидный IIFE для страницы).
//   2. window.__synth.setMode('pathological-stream' | 'tool-rounds-5' |
//      'mid-stream-drop' | 'stall' | null) и отправлять сообщения через
//      копилот-UI как обычно.
//   3. window.__synth.requests — журнал перехваченных generate-запросов.
//
// Механика: патчим window.fetch на эндпоинте /api/backends/chat-completions/
// generate. Запросы идут через ConnectionManagerService самого ST, поэтому
// ответы должны удовлетворять его парсеру: SSE `data: {"choices":[{"delta":
// {"content":"..."}}]}` для stream:true, JSON chat-completion иначе.
(function () {
    if (window.__synth && window.__synth._installed) {
        console.log('[synth] already installed');
        return;
    }
    const state = window.__synth = { requests: [], mode: null, round: 0, _installed: true };

    const sse = (text) => new Response(
        'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

    // Сценарии: функция (номер запроса, тело запроса) → Response.
    const scenarios = {
        // Патологический стрим: незакрытый фенс, memory-блок в середине,
        // закрытие фенса, очень длинная строка. Инвариант проверки: итоговый
        // DOM == полному рендеру stripped-текста.
        'pathological-stream': (n) => {
            if (n > 1) return sse('финал');
            const giant = 'X'.repeat(50000);
            const text = 'Начало\n```js\nconst x = 1;\n'
                + '\n```memory-update\n[{"action":"add","scope":"character","key":"K","value":"V"}]\n```\n'
                + 'середина ' + giant + '\nконец\n```tool_call\n{"name":"get_chat_stats","input":{}}\n```\nхвост';
            return sse(text);
        },
        // 5 tool-раундов впритык к лимиту, затем финальный текст. Счёт по номеру
        // запроса: компакция старых tool_results убирает <tool_results> из
        // контекста, поэтому считать по содержимому сообщений нельзя.
        'tool-rounds-5': (n) => {
            if (n <= 5) return sse('\n```tool_call\n{"name": "get_chat_stats", "input": {"round": ' + (n - 1) + '}}\n```');
            return sse('Все 5 раундов завершены. Финал.');
        },
        // Обрыв соединения посреди стрима после двух чанков.
        'mid-stream-drop': (n) => {
            if (n > 1) return sse('восстановление');
            const enc = new TextEncoder();
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: 'первый чанк. ' } }] }) + '\n\n'));
                    setTimeout(() => {
                        controller.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: 'второй чанк. ' } }] }) + '\n\n'));
                        controller.error(new TypeError('network dropped'));
                    }, 400);
                },
            });
            return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        },
        // Сервер принял, данных нет — проверка stall-watchdog.
        'stall': () => new Promise(() => {}), // никогда не резолвится
    };

    const origFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (state.mode && /\/api\/backends\/chat-completions\/generate/.test(url)) {
            state.requests.push({ ts: Date.now(), mode: state.mode, round: ++state.round });
            let body = null;
            try { body = JSON.parse(args[1]?.body || '{}'); } catch (_) {}
            const fn = scenarios[state.mode];
            return fn ? await fn(state.requests.length, body) : origFetch(...args);
        }
        return origFetch(...args);
    };

    state.setMode = (mode) => { state.mode = mode; state.round = 0; state.requests = []; };
    console.log('[synth] installed; use __synth.setMode("pathological-stream"|"tool-rounds-5"|"mid-stream-drop"|"stall"|null)');
})();
