import { describe, it, expect } from 'vitest';
import { redactRequestBody } from '../src/api.js';

describe('redactRequestBody — вымывание секретов из журнала запросов', () => {
    it('редактирует ключи по имени поля на любой глубине', () => {
        const body = {
            model: 'gpt-4',
            api_key: 'sk-secret-123',
            include_headers: { Authorization: 'Bearer abc' },
            messages: [{ role: 'user', content: 'hi', password: 'p', session_token: 't' }],
        };
        const r = redactRequestBody(body);
        expect(r.api_key).toBe('***REDACTED***');
        expect(r.include_headers.Authorization).toBe('***REDACTED***');
        expect(r.messages[0].password).toBe('***REDACTED***');
        expect(r.messages[0].session_token).toBe('***REDACTED***');
        expect(r.messages[0].content).toBe('hi');
        expect(r.model).toBe('gpt-4');
    });

    it('НЕ редактирует max_tokens и прочие не-секреты', () => {
        const r = redactRequestBody({ max_tokens: 800, tokens_used: 5 });
        expect(r.max_tokens).toBe(800);
        expect(r.tokens_used).toBe(5);
    });

    it('длинные строки (base64) схлопываются в размер', () => {
        const r = redactRequestBody({ image: 'x'.repeat(9000) });
        expect(r.image).toBe('… (9 KB)');
    });

    it('примитивы и null проходят как есть', () => {
        expect(redactRequestBody(null)).toBe(null);
        expect(redactRequestBody(42)).toBe(42);
        expect(redactRequestBody('short')).toBe('short');
    });
});
