/**
 * Text offsets across the platform are measured in Unicode code points and
 * describe half-open ranges [startOffset, endOffset).
 *
 * This matches Python's `str` indexing (content[start:end]) and JavaScript's
 * `Array.from(text).slice(start, end).join('')`. It deliberately does NOT match
 * JavaScript's native UTF-16 `String.prototype.slice`, which counts an emoji
 * such as "😀" as two units.
 */

export function codePointLength(text: string): number {
  let count = 0;
  // for..of iterates by code point.
  for (const _ of text) count++;
  return count;
}

export function toCodePoints(text: string): string[] {
  return Array.from(text);
}

export function sliceByCodePoints(text: string, start: number, end: number): string {
  return toCodePoints(text).slice(start, end).join('');
}

/** Converts a code-point offset into a UTF-16 index (useful for JS string APIs). */
export function codePointToUtf16Index(text: string, codePointOffset: number): number {
  let utf16 = 0;
  let cp = 0;
  for (const ch of text) {
    if (cp === codePointOffset) return utf16;
    utf16 += ch.length;
    cp++;
  }
  if (cp === codePointOffset) return utf16;
  throw new RangeError('Offset is outside the text.');
}

export type OffsetValidationResult =
  | { valid: true }
  | { valid: false; reason: 'NOT_INTEGER' | 'OUT_OF_RANGE' | 'EMPTY_RANGE' | 'TEXT_MISMATCH' };

/**
 * Validates that [start, end) lies within `content` (given as code points) and
 * that the referenced text is exactly `originalText`.
 */
export function validateOffsets(
  contentCodePoints: readonly string[],
  start: number,
  end: number,
  originalText: string,
): OffsetValidationResult {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return { valid: false, reason: 'NOT_INTEGER' };
  }
  if (start < 0 || end > contentCodePoints.length) return { valid: false, reason: 'OUT_OF_RANGE' };
  if (end <= start) return { valid: false, reason: 'EMPTY_RANGE' };
  if (contentCodePoints.slice(start, end).join('') !== originalText) {
    return { valid: false, reason: 'TEXT_MISMATCH' };
  }
  return { valid: true };
}
