/** Contract-conformant Python responses for "The report have several mistake." */
export function validContentReviewResponse(requestId: string) {
  return {
    requestId,
    issues: [
      {
        id: 'issue-3f9a1c2b7d10',
        issueType: 'grammar' as const,
        severity: 'medium' as const,
        original: 'report have',
        improved: 'report has',
        suggestion: 'The verb should agree with a singular subject.',
        location: { prefix: 'The ', suffix: ' several mistake.' },
      },
      {
        id: 'issue-8b21de44a0c9',
        issueType: 'grammar' as const,
        severity: 'medium' as const,
        original: 'several mistake',
        improved: 'several mistakes',
        suggestion: 'A plural quantifier requires a plural noun.',
        location: { prefix: 'The report have ', suffix: '.' },
      },
    ],
    model: 'gemini-test',
    usage: { inputTokens: null, outputTokens: null },
  };
}
