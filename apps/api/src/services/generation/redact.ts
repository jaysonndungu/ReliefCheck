/**
 * Heuristic redaction of obvious personal data before text reaches the provider (ai.md §10).
 * It is deliberately imperfect; the UI notice still tells users not to enter personal data.
 */
export function redactPersonalData(text: string): string {
  return text
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu, '[email removed]')
    .replace(/(?<![\p{L}\p{N}])\+?\d(?:[\s().-]*\d){6,}(?![\p{L}\p{N}])/gu, '[number removed]')
}

/** Questions containing links belong to the deterministic appeal workflow (ai.md §5 step 3). */
export function containsUrl(text: string): boolean {
  return /\bhttps?:\/\//iu.test(text) || /\bwww\.[\p{L}\p{N}-]+\.[\p{L}]{2,}/iu.test(text)
}
