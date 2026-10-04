import { codePointLength } from '../../shared/utils/offsets.js';
import { sleep } from '../../shared/utils/backoff.js';
import type { PythonLlmClient } from './llm-client.js';
import { LlmAbortedError } from './llm.errors.js';
import type {
  AnalysisChunk,
  AnalysisRequest,
  AnalyzeOptions,
  FindingCategory,
  FindingSeverity,
  LlmFinding,
  LlmHealth,
} from './llm.types.js';

interface Rule {
  category: FindingCategory;
  severity: FindingSeverity;
  pattern: RegExp;
  suggest: (match: string) => string;
  explanation: string;
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
    category: 'spelling',
    severity: 'low',
    pattern: new RegExp(`\\b(${Object.keys(SPELLING).join('|')})\\b`, 'gi'),
    suggest: (m) => SPELLING[m.toLowerCase()] ?? m,
    explanation: 'This word appears to be misspelled.',
  },
  {
    category: 'grammar',
    severity: 'medium',
    pattern: /\b(report|it|he|she|this|that) have\b/gi,
    suggest: (m) => m.replace(/have$/i, 'has'),
    explanation: 'The verb should agree with a singular subject.',
  },
  {
    category: 'grammar',
    severity: 'medium',
    pattern: /\b(several|many|few|two|three) (mistake|error|issue)\b/gi,
    suggest: (m) => `${m}s`,
    explanation: 'A plural quantifier requires a plural noun.',
  },
  {
    category: 'profanity',
    severity: 'high',
    pattern: /\b(damn|crap|bloody)\b/gi,
    suggest: () => '',
    explanation: 'This word may be considered offensive in a professional context.',
  },
];

/** Deterministic, rule-based analysis used for local development (offsets in code points). */
export function analyzeWithRules(content: string, categories: FindingCategory[]): LlmFinding[] {
  const findings: LlmFinding[] = [];
  for (const rule of RULES) {
    if (!categories.includes(rule.category)) continue;
    for (const match of content.matchAll(rule.pattern)) {
      const startOffset = codePointLength(content.slice(0, match.index));
      findings.push({
        category: rule.category,
        severity: rule.severity,
        originalText: match[0],
        suggestedText: rule.suggest(match[0]),
        explanation: rule.explanation,
        startOffset,
        endOffset: startOffset + codePointLength(match[0]),
      });
    }
  }
  return findings.sort((a, b) => a.startOffset - b.startOffset);
}

export type MockHandler = (
  request: AnalysisRequest,
  callNumber: number,
) => LlmFinding[] | Promise<LlmFinding[]>;

export interface MockPythonLlmClientOptions {
  delayMs?: number;
  /** Override behavior per call (return findings or throw an LlmError). */
  handler?: MockHandler;
  healthy?: boolean;
}

/** In-process stand-in for the Python worker. Never used in production (enforced by env validation). */
export class MockPythonLlmClient implements PythonLlmClient {
  calls: AnalysisRequest[] = [];

  constructor(private options: MockPythonLlmClientOptions = {}) {}

  setHandler(handler: MockHandler | undefined): void {
    this.options = { ...this.options, handler };
  }

  async *analyze(req: AnalysisRequest, opts: AnalyzeOptions = {}): AsyncIterable<AnalysisChunk> {
    this.calls.push(req);
    if (this.options.delayMs) await sleep(this.options.delayMs, opts.signal);
    if (opts.signal?.aborted) throw new LlmAbortedError('Mock analysis aborted');
    const findings = this.options.handler
      ? await this.options.handler(req, this.calls.length)
      : analyzeWithRules(req.content, req.categories);
    yield { type: 'result', findings, model: 'mock-rules-v1' };
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
