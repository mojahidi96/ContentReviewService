/** Contract-conformant Python responses for "The report have several mistake." */
export function validAnalysisResponse(requestId: string) {
  return {
    requestId,
    offsetUnit: 'codepoint' as const,
    model: 'gpt-test',
    findings: [
      {
        category: 'grammar' as const,
        severity: 'medium' as const,
        originalText: 'report have',
        suggestedText: 'report has',
        explanation: 'The verb should agree with a singular subject.',
        startOffset: 4,
        endOffset: 15,
      },
      {
        category: 'grammar' as const,
        severity: 'medium' as const,
        originalText: 'several mistake',
        suggestedText: 'several mistakes',
        explanation: 'A plural quantifier requires a plural noun.',
        startOffset: 16,
        endOffset: 31,
      },
    ],
  };
}
