import { describe, expect, it } from 'vitest';
import {
  codePointLength,
  codePointToUtf16Index,
  sliceByCodePoints,
  toCodePoints,
  validateOffsets,
} from '../../src/shared/utils/offsets.js';
import { analyzeWithRules } from '../../src/integrations/python-llm/mock-llm-client.js';

/**
 * Reference values match Python 3: len(s) and s[start:end] on the same strings.
 */
describe('code-point offsets', () => {
  it.each([
    ['ASCII', 'hello', 5],
    ['emoji (surrogate pair)', '😀', 1],
    ['emoji + skin tone modifier', '👍🏽', 2],
    ['flag (two regional indicators)', '🇺🇸', 2],
    ['ZWJ family sequence', '👨‍👩‍👧', 5],
    ['precomposed é', 'café', 4],
    ['decomposed e + combining acute', 'café', 5],
    ['CJK', '日本語', 3],
    ['math alphanumeric (astral)', '𝒳', 1],
  ])('%s: length matches Python len()', (_name, text, expected) => {
    expect(codePointLength(text)).toBe(expected);
    expect(toCodePoints(text)).toHaveLength(expected);
  });

  it('slices by code point, unlike String.prototype.slice', () => {
    const text = 'I 😀 teh cake';
    // Python: text[4:7] == 'teh'
    expect(sliceByCodePoints(text, 4, 7)).toBe('teh');
    expect(text.slice(4, 7)).not.toBe('teh'); // UTF-16 indices are shifted by the emoji
  });

  it('converts code-point offsets to UTF-16 indices for JS string APIs', () => {
    const text = 'a😀b';
    expect(codePointToUtf16Index(text, 0)).toBe(0);
    expect(codePointToUtf16Index(text, 1)).toBe(1);
    expect(codePointToUtf16Index(text, 2)).toBe(3);
    expect(codePointToUtf16Index(text, 3)).toBe(4);
    expect(() => codePointToUtf16Index(text, 4)).toThrow(RangeError);
  });

  describe('validateOffsets', () => {
    const cps = toCodePoints('Hi 👋🏽 wrld');
    it('accepts an exact match', () => {
      expect(validateOffsets(cps, 6, 10, 'wrld')).toEqual({ valid: true });
      expect(validateOffsets(cps, 3, 5, '👋🏽')).toEqual({ valid: true });
    });
    it.each([
      [6.5, 10, 'wrld', 'NOT_INTEGER'],
      [-1, 3, 'Hi ', 'OUT_OF_RANGE'],
      [6, 11, 'wrld', 'OUT_OF_RANGE'],
      [6, 6, '', 'EMPTY_RANGE'],
      [7, 5, 'x', 'EMPTY_RANGE'],
      [8, 12, 'wrld', 'OUT_OF_RANGE'], // UTF-16 offsets for the same word
      [5, 9, 'wrld', 'TEXT_MISMATCH'],
    ])('rejects [%d, %d) "%s" with %s', (start, end, text, reason) => {
      expect(validateOffsets(cps, start, end, text)).toEqual({ valid: false, reason });
    });
  });

  it('mock analysis emits code-point offsets after astral characters', () => {
    const content = '🎉🎉 Please recieve teh files';
    const findings = analyzeWithRules(content, ['spelling']);
    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(
        validateOffsets(toCodePoints(content), f.startOffset, f.endOffset, f.originalText),
      ).toEqual({
        valid: true,
      });
    }
    expect(findings[0]).toMatchObject({ originalText: 'recieve', startOffset: 10, endOffset: 17 });
  });
});
