import { describe, expect, it } from 'vitest';
import { locateIssue } from '../../src/modules/reviews/issue-locator.js';
import { sliceByCodePoints } from '../../src/shared/utils/offsets.js';

describe('locateIssue', () => {
  it('places the documented example', () => {
    const content = 'Please recieve the document.';
    const result = locateIssue(content, {
      original: 'recieve',
      prefix: 'Please ',
      suffix: ' the document.',
    });
    expect(result).toEqual({
      found: true,
      startOffset: 7,
      endOffset: 14,
      utf16Index: 7,
      exactContext: true,
    });
  });

  it('handles empty prefix at the start and empty suffix at the end', () => {
    const content = 'teh end teh';
    expect(locateIssue(content, { original: 'teh', prefix: '', suffix: ' end' })).toMatchObject({
      startOffset: 0,
      exactContext: true,
    });
    expect(locateIssue(content, { original: 'teh', prefix: 'end ', suffix: '' })).toMatchObject({
      startOffset: 8,
      exactContext: true,
    });
  });

  it('picks the occurrence whose surrounding text matches', () => {
    const content = 'their dog. their cat. their dog.';
    const at = (prefix: string, suffix: string) =>
      locateIssue(content, { original: 'their', prefix, suffix });
    expect(at('', ' dog.')).toMatchObject({ startOffset: 0 });
    expect(at('dog. ', ' cat.')).toMatchObject({ startOffset: 11 });
    expect(at('cat. ', ' dog.')).toMatchObject({ startOffset: 22 });
  });

  it('breaks ties between identical contexts by document order', () => {
    const content = 'a teh b. a teh b.';
    const anchor = { original: 'teh', prefix: 'a ', suffix: ' b.' };
    expect(locateIssue(content, anchor)).toMatchObject({ startOffset: 2 });
    expect(locateIssue(content, anchor, 3)).toMatchObject({ startOffset: 11 });
    // Nothing exact after the cursor: fall back to the first exact match.
    expect(locateIssue(content, anchor, 15)).toMatchObject({ startOffset: 2 });
  });

  it('returns code-point offsets after astral characters', () => {
    const content = '😀😀 recieve 👍 recieve';
    const result = locateIssue(content, { original: 'recieve', prefix: '👍 ', suffix: '' });
    expect(result).toMatchObject({ found: true, startOffset: 13, endOffset: 20, utf16Index: 16 });
    if (result.found) {
      expect(sliceByCodePoints(content, result.startOffset, result.endOffset)).toBe('recieve');
    }
  });

  it('falls back to the best context match when nothing matches exactly', () => {
    const content = 'one teh two. three teh four.';
    // The service trimmed/garbled the context slightly; the second occurrence agrees more.
    const result = locateIssue(content, { original: 'teh', prefix: 'hree ', suffix: ' fou!' });
    expect(result).toMatchObject({ found: true, startOffset: 19, exactContext: false });
  });

  it('reports text that is not in the content', () => {
    expect(locateIssue('Hello world', { original: 'recieve', prefix: '', suffix: '' })).toEqual({
      found: false,
    });
  });
});
