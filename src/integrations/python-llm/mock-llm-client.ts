import { sleep } from '../../shared/utils/backoff.js';
import { sha256Hex } from '../../shared/utils/hash.js';
import type { PythonLlmClient } from './llm-client.js';
import { LlmAbortedError } from './llm.errors.js';
import type {
  ContentReviewIssue,
  ContentReviewRequest,
  ContentReviewResponse,
  FindingSeverity,
  IssueType,
  LlmHealth,
  ReviewContentOptions,
} from './llm.types.js';

interface Rule {
  issueType: IssueType;
  severity: FindingSeverity;
  pattern: RegExp;
  suggest: (match: string) => string;
  suggestion: string;
}

const SPELLING: Record<string, string> = {
  teh: 'the',
  recieve: 'receive',
  seperate: 'separate',
  definately: 'definitely',
  occured: 'occurred',
  untill: 'until',
  wich: 'which',
  acheive: 'achieve',
};

const RULES: Rule[] = [
  {
    issueType: 'spelling',
    severity: 'low',
    pattern: new RegExp(`\\b(${Object.keys(SPELLING).join('|')})\\b`, 'gi'),
    suggest: (m) => matchCase(m, SPELLING[m.toLowerCase()] ?? m),
    suggestion: 'Correct the spelling mistake.',
  },
  {
    issueType: 'grammar',
    severity: 'medium',
    pattern: /\b(report|it|he|she|this|that) have\b/gi,
    suggest: (m) => m.replace(/have$/i, 'has'),
    suggestion: 'The verb should agree with a singular subject.',
  },
  {
    issueType: 'grammar',
    severity: 'medium',
    pattern: /\b(several|many|few|two|three) (mistake|error|issue)\b/gi,
    suggest: (m) => `${m}s`,
    suggestion: 'A plural quantifier requires a plural noun.',
  },
  {
    issueType: 'vulgarity',
    severity: 'high',
    pattern: /\b(damn|crap|bloody)\b/gi,
    suggest: () => '',
    suggestion: 'This word may be considered offensive in a professional context.',
  },
];

/** Characters of context sent on each side of an issue, like the Python service. */
const CONTEXT_CHARS = 20;

function matchCase(source: string, replacement: string): string {
  const first = source.charAt(0);
  return first !== first.toLowerCase()
    ? replacement.charAt(0).toUpperCase() + replacement.slice(1)
    : replacement;
}

/** Deterministic, rule-based analysis used for local development. Issues are in document order. */
export function analyzeWithRules(content: string): ContentReviewIssue[] {
  const matches: { index: number; rule: Rule; text: string }[] = [];
  for (const rule of RULES) {
    for (const match of content.matchAll(rule.pattern)) {
      matches.push({ index: match.index, rule, text: match[0] });
    }
  }
  return matches
    .sort((a, b) => a.index - b.index)
    .map(({ index, rule, text }) => {
      const end = index + text.length;
      return {
        id: `issue-${sha256Hex(`${index}:${rule.issueType}:${text}`).slice(0, 12)}`,
        issueType: rule.issueType,
        severity: rule.severity,
        original: text,
        improved: rule.suggest(text),
        suggestion: rule.suggestion,
        location: {
          prefix: safeSlice(content, Math.max(0, index - CONTEXT_CHARS), index),
          suffix: safeSlice(content, end, end + CONTEXT_CHARS),
        },
      };
    });
}

/** Slice that never splits a surrogate pair at either edge. */
function safeSlice(text: string, start: number, end: number): string {
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start++;
  if (end < text.length && isLowSurrogate(text.charCodeAt(end))) end--;
  return text.slice(start, Math.max(start, end));
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export type MockHandler = (
  request: ContentReviewRequest,
  callNumber: number,
) => ContentReviewIssue[] | Promise<ContentReviewIssue[]>;

export interface MockPythonLlmClientOptions {
  delayMs?: number;
  /** Override behavior per call (return issues or throw an LlmError). */
  handler?: MockHandler;
  healthy?: boolean;
}

/** In-process stand-in for the Python service. Never used in production (enforced by env validation). */
export class MockPythonLlmClient implements PythonLlmClient {
  calls: ContentReviewRequest[] = [];

  constructor(private options: MockPythonLlmClientOptions = {}) {}

  setHandler(handler: MockHandler | undefined): void {
    this.options = { ...this.options, handler };
  }

  async reviewContent(
    req: ContentReviewRequest,
    opts: ReviewContentOptions = {},
  ): Promise<ContentReviewResponse> {
    this.calls.push(req);
    if (this.options.delayMs) await sleep(this.options.delayMs, opts.signal);
    if (opts.signal?.aborted) throw new LlmAbortedError('Mock analysis aborted');
    const issues = this.options.handler
      ? await this.options.handler(req, this.calls.length)
      : analyzeWithRules(req.content);
    return {
      requestId: req.requestId,
      issues,
      model: 'mock-rules-v2',
      usage: { inputTokens: null, outputTokens: null },
    };
  }

  checkHealth(): Promise<LlmHealth> {
    return Promise.resolve({
      status: this.options.healthy === false ? 'unavailable' : 'ok',
      latencyMs: 0,
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
