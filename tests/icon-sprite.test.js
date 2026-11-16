// Icon sprite: the 27 raw svgs in constants.js are split once into a shared
// <symbol> sprite plus tiny <use> references. Guards the contract the rest of
// the UI relies on: every I.<name> resolves to a <use> pointing at a symbol
// that actually exists in SPRITE_SVG, with the icon's original size kept on
// the outer <svg> (CSS targets the outer element, symbols carry the paint).

import { describe, it, expect } from 'vitest';
import { I, SPRITE_SVG, MSG_CV_MIN_CHARS } from '../src/constants.js';

const USE_RE = /<use href="#scp-ic-([A-Za-z0-9_]+)"><\/use>/;

describe('icon sprite', () => {
    it('every I entry is a <use> reference to a symbol present in the sprite', () => {
        const names = Object.keys(I);
        expect(names.length).toBeGreaterThanOrEqual(27);
        for (const name of names) {
            const m = I[name].match(USE_RE);
            expect(m, `I.${name} must embed a <use> reference`).toBeTruthy();
            expect(SPRITE_SVG).toContain(`symbol id="scp-ic-${m[1]}"`);
        }
    });

    it('symbols keep the original shapes and paint attributes', () => {
        expect(SPRITE_SVG).toContain('symbol id="scp-ic-starFill"');
        expect(SPRITE_SVG).toContain('fill="currentColor"'); // starFill polygon
        expect(SPRITE_SVG).toContain('stroke-width="2.5"'); // x icon
        expect(SPRITE_SVG).toContain('stroke-linecap="round"');
    });

    it('outer svg keeps the icon size and carries no duplicated markup', () => {
        expect(I.send).toContain('width="16"'); // send is the 16px outlier
        expect(I.copy).toContain('width="13"');
        expect(I.copy).not.toContain('xmlns'); // shape markup lives in the symbol
        expect(I.copy).not.toContain('<rect'); // no path duplication per instance
    });

    it('MSG_CV_MIN_CHARS is in the giant-message range', () => {
        expect(MSG_CV_MIN_CHARS).toBeGreaterThanOrEqual(20000);
    });
});
