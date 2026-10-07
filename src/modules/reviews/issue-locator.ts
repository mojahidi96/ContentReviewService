import { codePointLength } from '../../shared/utils/offsets.js';

export interface IssueAnchor {
  original: string;
  prefix: string;
  suffix: string;
}

export type LocateResult =
  | {
      found: true;
      /** Code-point offsets, half-open [startOffset, endOffset). */
      startOffset: number;
      endOffset: number;
      /** UTF-16 index of the match; feed it back as `fromIndex` for the next issue. */
      utf16Index: number;
      /** False when no occurrence had exactly the given prefix and suffix around it. */
      exactContext: boolean;
    }
  | { found: false };

/**
 * Places an issue in `content`. The Python service sends no offsets; an issue is identified by
 * its `original` text plus the text immediately before (`prefix`) and after (`suffix`) it.
 *
 * Choice among occurrences of `original`:
 *  1. Occurrences whose surroundings match `prefix` and `suffix` exactly. Because issues arrive
 *     in document order, the first one at or after `fromIndex` (UTF-16) wins; if there is none
 *     after it, the first overall.
 *  2. Otherwise, the occurrence whose surroundings agree with the most characters of
 *     `prefix` and `suffix`, with the same document-order tie-break.
 *
 * Not found means the content changed since the request (Python already dropped issues whose
 * `original` is absent from the content it reviewed).
 */
export function locateIssue(content: string, anchor: IssueAnchor, fromIndex = 0): LocateResult {
  const { original, prefix, suffix } = anchor;
  if (original.length === 0) return { found: false };

  let bestIndex = -1;
  let bestScore = -1;
  let bestAfterCursor = false;
  let exactIndex = -1;

  for (let i = content.indexOf(original); i !== -1; i = content.indexOf(original, i + 1)) {
    const end = i + original.length;
    const afterCursor = i >= fromIndex;
    const prefixStart = i - prefix.length;
    if (
      prefixStart >= 0 &&
      content.startsWith(prefix, prefixStart) &&
      content.startsWith(suffix, end)
    ) {
      if (exactIndex === -1 || (afterCursor && exactIndex < fromIndex)) exactIndex = i;
      if (afterCursor) break;
      continue;
    }
    if (exactIndex !== -1) continue;
    const score =
      commonSuffixLength(content.slice(Math.max(0, i - prefix.length), i), prefix) +
      commonPrefixLength(content.slice(end, end + suffix.length), suffix);
    if (score > bestScore || (score === bestScore && afterCursor && !bestAfterCursor)) {
      bestIndex = i;
      bestScore = score;
      bestAfterCursor = afterCursor;
    }
  }

  const index = exactIndex !== -1 ? exactIndex : bestIndex;
  if (index === -1) return { found: false };
  const startOffset = codePointLength(content.slice(0, index));
  return {
    found: true,
    startOffset,
    endOffset: startOffset + codePointLength(original),
    utf16Index: index,
    exactContext: exactIndex !== -1,
  };
}

function commonSuffixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}
