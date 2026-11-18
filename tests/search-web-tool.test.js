// search_web contract: normalized {title,url,snippet} results, tail-trim instead
// of mid-JSON cuts, and provider fallback when the requested provider has no key.
import { describe, it, expect, beforeEach } from 'vitest';

let engine;
const ctx = SillyTavern.getContext();

const ok = (data) => ({ status: 200, ok: true, text: async () => JSON.stringify(data) });
const noKey = () => ({ status: 400, ok: false, text: async () => '' });

const serperPayload = (n = 10, urlLen = 30) => ({
  organic: Array.from({ length: n }, (_, i) => ({
    title: `Result ${i}`,
    link: `https://example.com/${String(i)}${'u'.repeat(urlLen)}`,
    snippet: 'snippet text',
  })),
});
const zaiPayload = { search_result: [{ title: 'ZAI', link: 'https://z.ai/1', content: 'zai content' }] };
const exaPayload = { requestId: 'r1', results: [{ title: 'EXA', url: 'https://exa.ai/1', text: 'exa page text' }, { title: 'EXA2', url: 'https://exa.ai/2', summary: 'exa summary', highlights: ['h1', 'h2'] }] };
const tavilyPayload = { answer: 'direct answer', results: [{ title: 'T', url: 'https://t.com', content: 'tavily content' }] };

let calls;
let route;

beforeEach(async () => {
  engine = await import('../src/features/feature-tools-engine.js');
  ctx.extensionSettings['st_copilot'] = { toolsEnabled: true };
  calls = [];
  route = () => ok({});
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return route(String(url));
  };
});

describe('search_web normalization', () => {
  it('maps serper organic[] to title/url/snippet', async () => {
    route = () => ok(serperPayload(2));
    const r = await engine.executeTool('search_web', { query: 'q', provider: 'serper' });
    expect(r.provider).toBe('serper');
    expect(r.results).toHaveLength(2);
    expect(r.results[0]).toEqual({ title: 'Result 0', url: expect.stringContaining('example.com'), snippet: 'snippet text' });
    expect(JSON.stringify(r)).not.toContain('searchParameters');
  });

  it('maps zai search_result[] (link/content fields)', async () => {
    route = () => ok(zaiPayload);
    const r = await engine.executeTool('search_web', { query: 'q', provider: 'zai' });
    expect(r.results[0]).toEqual({ title: 'ZAI', url: 'https://z.ai/1', snippet: 'zai content' });
  });

  it('keeps the tavily answer field', async () => {
    route = () => ok(tavilyPayload);
    const r = await engine.executeTool('search_web', { query: 'q', provider: 'tavily' });
    expect(r.answer).toBe('direct answer');
    expect(r.results[0].snippet).toBe('tavily content');
  });

  it('maps exa results (text | summary | highlights fallbacks)', async () => {
    route = () => ok(exaPayload);
    const r = await engine.executeTool('search_web', { query: 'q', provider: 'exa' });
    expect(r.provider).toBe('exa');
    expect(r.results[0]).toEqual({ title: 'EXA', url: 'https://exa.ai/1', snippet: 'exa page text' });
    expect(r.results[1].snippet).toBe('exa summary');
    expect(r.results).toHaveLength(2);
  });

  it('exa request carries trimmed contents and num_results', async () => {
    route = () => ok(exaPayload);
    let body = null;
    globalThis.fetch = async (url, opts) => { body = JSON.parse(opts.body); return ok(exaPayload); };
    await engine.executeTool('search_web', { query: 'q', provider: 'exa', num_results: 8 });
    expect(body.contents).toEqual({ text: { maxCharacters: 600 } });
    expect(body.numResults).toBe(8);
    await engine.executeTool('search_web', { query: 'q', provider: 'exa' });
    expect(body.numResults).toBeUndefined();
  });

  it('caps snippet length at 300 chars', async () => {
    route = () => ok({ organic: [{ title: 't', link: 'https://e.com', snippet: 'x'.repeat(500) }] });
    const r = await engine.executeTool('search_web', { query: 'q', provider: 'serper' });
    expect(r.results[0].snippet).toHaveLength(300);
  });

  it('drops tail results over the 3800-char budget with a note, never mid-JSON', async () => {
    route = () => ok(serperPayload(10, 400));
    const r = await engine.executeTool('search_web', { query: 'q', provider: 'serper' });
    expect(r.results.length).toBeLessThan(10);
    expect(r.results.length).toBeGreaterThan(1);
    expect(r.note).toMatch(/trimmed/);
    expect(JSON.parse(JSON.stringify(r.results))).toBeInstanceOf(Array);
  });
});

describe('search_web provider fallback', () => {
  it('falls through unconfigured providers to a working one', async () => {
    route = (url) =>
      url.endsWith('/zai') || url.endsWith('/tavily') ? noKey()
      : url.endsWith('/serper') ? ok(serperPayload(1))
      : noKey();
    const r = await engine.executeTool('search_web', { query: 'q' }); // default provider: zai
    expect(calls).toEqual(['/api/search/zai', '/api/search/tavily', '/api/search/serper']);
    expect(r.provider).toBe('serper');
    expect(r.note).toContain('served by serper');
  });

  it('reports a single error when every keyed provider is missing', async () => {
    route = () => noKey();
    const r = await engine.executeTool('search_web', { query: 'q' });
    expect(r.error).toContain('None of the search providers');
    expect(calls).toHaveLength(5); // zai, tavily, serper, serpapi, exa
  });

  it('rejects unknown providers and searxng without a URL', async () => {
    expect((await engine.executeTool('search_web', { query: 'q', provider: 'koboldcpp' })).error).toContain('Unknown provider');
    expect((await engine.executeTool('search_web', { query: 'q', provider: 'searxng' })).error).toContain('searxng_url');
    expect(calls).toHaveLength(0);
  });
});

describe('search_web: unpatched server routes (404)', () => {
    beforeEach(async () => {
        engine = await import('../src/features/feature-tools-engine.js');
        ctx.extensionSettings['st_copilot'] = { toolsEnabled: true };
        calls = [];
    });

    it('404 on a provider (no route) falls through to a working one', async () => {
        globalThis.fetch = async (url) => {
            calls.push(String(url));
            const u = String(url);
            if (u.endsWith('/zai') || u.endsWith('/exa')) return { status: 404, ok: false, text: async () => '' };
            if (u.endsWith('/tavily')) return { status: 400, ok: false, text: async () => '' };
            if (u.endsWith('/serper')) return ok(serperPayload(1));
            return { status: 400, ok: false, text: async () => '' };
        };
        const r = await engine.executeTool('search_web', { query: 'q', provider: 'exa' });
        expect(calls.map(c => c.split('/').pop())).toEqual(['exa', 'zai', 'tavily', 'serper']);
        expect(r.provider).toBe('serper');
        expect(r.note).toContain('served by serper');
    });

    it('all-404 yields an explicit "server needs patch" error', async () => {
        globalThis.fetch = async () => ({ status: 404, ok: false, text: async () => '' });
        const r = await engine.executeTool('search_web', { query: 'q', provider: 'exa' });
        expect(r.error).toContain('needs the provider patch');
    });
});

describe('search_web: WebSearch extension as provider source of truth', () => {
    beforeEach(async () => {
        engine = await import('../src/features/feature-tools-engine.js');
        ctx.extensionSettings['st_copilot'] = { toolsEnabled: true };
        calls = [];
        globalThis.fetch = async (url, opts) => {
            calls.push(String(url));
            const u = String(url);
            if (u.endsWith('/serper')) return ok(serperPayload(1));
            if (u.endsWith('/searxng')) return ok({ results: [] });
            return noKey();
        };
    });

    it('defaults to the WebSearch extension source when set', async () => {
        ctx.extensionSettings['websearch'] = { source: 'serper' };
        const r = await engine.executeTool('search_web', { query: 'q' });
        expect(calls[0]).toBe('/api/search/serper');
        expect(r.provider).toBe('serper');
        expect(r.note).toBeUndefined();
    });

    it('explicit provider in the call wins over the WebSearch source', async () => {
        ctx.extensionSettings['websearch'] = { source: 'serper' };
        await engine.executeTool('search_web', { query: 'q', provider: 'zai' });
        expect(calls[0]).toBe('/api/search/zai');
    });

    it('ignores WebSearch sources without server routes (extras/plugin)', async () => {
        ctx.extensionSettings['websearch'] = { source: 'plugin' };
        const r = await engine.executeTool('search_web', { query: 'q' });
        expect(calls[0]).toBe('/api/search/zai');
        expect(r.note).toContain('served by');
    });

    it('no WebSearch extension → legacy zai default', async () => {
        const r = await engine.executeTool('search_web', { query: 'q' });
        expect(calls[0]).toBe('/api/search/zai');
    });

    it('searxng_url is taken from the WebSearch extension when not passed', async () => {
        ctx.extensionSettings['websearch'] = { source: 'searxng', searxng_url: 'http://searx.lan' };
        let body = null;
        globalThis.fetch = async (url, opts) => { body = JSON.parse(opts.body); calls.push(String(url)); return ok({ results: [] }); };
        const r = await engine.executeTool('search_web', { query: 'q' });
        expect(r.provider).toBe('searxng');
        expect(body.baseUrl).toBe('http://searx.lan');
    });

    it('explicit searxng_url still wins over the extension value', async () => {
        ctx.extensionSettings['websearch'] = { source: 'searxng', searxng_url: 'http://searx.lan' };
        let body = null;
        globalThis.fetch = async (url, opts) => { body = JSON.parse(opts.body); calls.push(String(url)); return ok({ results: [] }); };
        await engine.executeTool('search_web', { query: 'q', searxng_url: 'http://override.lan' });
        expect(body.baseUrl).toBe('http://override.lan');
    });
});

describe('search_web: rate-limited providers (429)', () => {
    beforeEach(async () => {
        engine = await import('../src/features/feature-tools-engine.js');
        ctx.extensionSettings['st_copilot'] = { toolsEnabled: true };
        calls = [];
        globalThis.fetch = async (url) => { calls.push(String(url)); return noKey(); };
    });

    it('429 on a provider silently falls through to a working one', async () => {
        globalThis.fetch = async (url) => {
            calls.push(String(url));
            const u = String(url);
            if (u.endsWith('/zai') || u.endsWith('/tavily')) return { status: 429, ok: false, text: async () => '' };
            if (u.endsWith('/serper')) return ok(serperPayload(1));
            return noKey();
        };
        const r = await engine.executeTool('search_web', { query: 'q', provider: 'zai' });
        expect(r.provider).toBe('serper');
        expect(r.note).toContain('served by serper');
    });

    it('all-429 yields a rate-limit error, no partial results', async () => {
        globalThis.fetch = async () => ({ status: 429, ok: false, text: async () => '' });
        const r = await engine.executeTool('search_web', { query: 'q' });
        expect(r.error).toContain('rate-limited');
        expect(r.results).toBeUndefined();
    });
});
