// ST-Copilot mock LLM: deterministic OpenAI-compatible endpoint for manual QA
// of the generation pipeline — no real API spend, every regression reproducible.
//
// RUNBOOK
//   1. node tests/live/mock-llm.mjs          → http://127.0.0.1:8901/v1
//   2. Copilot settings: Источник подключения = Custom,
//      URL = http://127.0.0.1:8901/v1, key = anything.
//   3. Set the model name to the scenario below, send a message from the UI.
//   4. GET /__journal  — every received request (count rounds, inspect prompts);
//      GET /__journal/reset — zero the journal and the per-burst counters.
//
// Scenarios (model name steers behavior):
//   scp-mock      — plain short answer (smoke)
//   scp-short     — one sentence
//   scp-empty     — empty content → GEN_EMPTY_FINAL_TEXT path
//   scp-badjson   — garbage that is not JSON/fence (parse-fail path)
//   scp-escaped   — \`\`\`-escaped tool_call fences (regression f637e78: escaped
//                   fences must not execute as tool calls)
//   scp-toolloop3 — three search_lorebook tool rounds, then a final answer
//                   (dedup + budget + final no-tools pass)
//   scp-slow      — SSE drip, 12 chunks x 500 ms (stream renderer under load)
//   scp-timeout   — opens SSE then never sends data (stall watchdog fires)
//   scp-round2err — request 1: answer + one tool_call; request 2+: HTTP 500.
//                   Pins the salvage fix: text of completed rounds must survive
//                   the failed round (no silent message removal).
//
// A "burst" = requests closer than 60 s apart; toolloop/round2err count inside
// the current burst. Streaming: SSE deltas when the request has stream:true.
import http from 'node:http';

const PORT = 8901;
const journal = [];
let burstSeq = 0;
let lastAt = 0;

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const fence = (name, input) => '```tool_call\n' + JSON.stringify({ name, input }) + '\n```';

function finalAnswer(model, text) {
    return { id: 'mock-' + model, object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] };
}

function sse(res, chunks, { holdOpen = false, chunkMs = 500 } = {}) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...CORS });
    let i = 0;
    const timer = setInterval(() => {
        if (i < chunks.length) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`);
            return;
        }
        if (holdOpen) return; // scp-timeout: stream open, silence forever
        res.write('data: [DONE]\n\n');
        res.end();
        clearInterval(timer);
    }, chunkMs);
}

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    if (req.method === 'GET' && req.url === '/__journal') {
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        res.end(JSON.stringify({ burstSeq, entries: journal }, null, 1));
        return;
    }
    if (req.method === 'GET' && req.url === '/__journal/reset') {
        journal.length = 0;
        burstSeq = 0;
        lastAt = 0;
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        res.end('{"ok":true}');
        return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        res.end(JSON.stringify({
            data: ['scp-mock', 'scp-short', 'scp-empty', 'scp-badjson', 'scp-escaped', 'scp-toolloop3', 'scp-slow', 'scp-timeout', 'scp-round2err'].map(id => ({ id })),
        }));
        return;
    }
    if (req.method !== 'POST' || !(req.url === '/v1/chat/completions' || req.url === '/chat/completions')) {
        res.writeHead(404, CORS); res.end(); return;
    }

    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* tolerate */ }
        const model = parsed.model || 'scp-mock';
        const now = Date.now();
        if (now - lastAt > 60000) burstSeq = 0; // new burst = new generation
        lastAt = now;
        const round = burstSeq++;
        journal.push({ t: now, round, model, url: req.url, stream: !!parsed.stream, messages: parsed.messages });

        const respondJson = obj => {
            res.writeHead(200, { 'content-type': 'application/json', ...CORS });
            res.end(JSON.stringify(obj));
        };
        const respondSse = (text, opts) => sse(res, text.match(/[\s\S]{1,80}/g) || [], opts);

        if (model === 'scp-round2err') {
            if (round === 0) {
                const answer = 'Ищу в лорбуке.\n\n' + fence('search_lorebook', { query: 'mock' });
                parsed.stream ? respondSse(answer) : respondJson(finalAnswer(model, answer));
            } else {
                res.writeHead(500, { 'content-type': 'application/json', ...CORS });
                res.end(JSON.stringify({ error: { message: 'mock round-2 failure' } }));
            }
            return;
        }
        if (model === 'scp-toolloop3') {
            if (round < 3) {
                const answer = `Раунд ${round + 1}: уточняю данные.\n\n` + fence('search_lorebook', { query: `mock-${round}` });
                parsed.stream ? respondSse(answer) : respondJson(finalAnswer(model, answer));
            } else {
                const answer = 'Готово: три раунда инструментов отработали, вот финальный ответ.';
                parsed.stream ? respondSse(answer) : respondJson(finalAnswer(model, answer));
            }
            return;
        }
        if (model === 'scp-escaped') {
            const answer = 'Текст с экранированными фенсами: \\`\\`\\`tool_call\\n{"name":"search_lorebook","input":{"query":"escaped"}}\\n\\`\\`\\`';
            parsed.stream ? respondSse(answer) : respondJson(finalAnswer(model, answer));
            return;
        }
        if (model === 'scp-timeout') {
            sse(res, ['Загрузка'], { holdOpen: true, chunkMs: 200 });
            return;
        }
        if (model === 'scp-slow') {
            sse(res, Array.from({ length: 12 }, (_, i) => `кусок ${i + 1}; `), { chunkMs: 500 });
            return;
        }
        if (model === 'scp-badjson') {
            const answer = 'это вообще не {json: и не фенс }}}';
            parsed.stream ? respondSse(answer) : respondJson(finalAnswer(model, answer));
            return;
        }
        if (model === 'scp-empty') {
            parsed.stream ? respondSse('') : respondJson(finalAnswer(model, ''));
            return;
        }
        if (model === 'scp-short') {
            const answer = 'Короткий ответ мока.';
            parsed.stream ? respondSse(answer) : respondJson(finalAnswer(model, answer));
            return;
        }
        // scp-mock: echo the last user line so journal/DOM checks are easy
        const users = (parsed.messages || []).filter(m => m.role === 'user');
        const last = users.length ? String(users[users.length - 1].content).split('\n').pop() : '';
        const answer = `Мок-ответ на: ${last}`;
        parsed.stream ? respondSse(answer) : respondJson(finalAnswer(model, answer));
    });
});

server.listen(PORT, () => console.log(`scp mock LLM on http://127.0.0.1:${PORT}/v1`));
