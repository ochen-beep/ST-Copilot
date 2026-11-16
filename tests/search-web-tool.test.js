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
    expect(calls).toHaveLength(4);
  });

  it('rejects unknown providers and searxng without a URL', async () => {
    expect((await engine.executeTool('search_web', { query: 'q', provider: 'koboldcpp' })).error).toContain('Unknown provider');
    expect((await engine.executeTool('search_web', { query: 'q', provider: 'searxng' })).error).toContain('searxng_url');
    expect(calls).toHaveLength(0);
  });
});
