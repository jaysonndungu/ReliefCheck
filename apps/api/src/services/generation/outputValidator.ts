import { z } from 'zod'

/** Untrusted model output shape (ai.md §8). Unknown keys are rejected. */
export const generatedAnswerSchema = z.strictObject({
  answerability: z.enum(['supported', 'partial', 'insufficient']),
  claims: z.array(z.strictObject({
    text: z.string().trim().min(1).max(2_000),
    citationIds: z.array(z.string().trim().min(1).max(100)).min(1).max(6),
  })).max(12),
  limitations: z.array(z.string().trim().min(1).max(1_000)).max(12),
})
export type GeneratedAnswer = z.infer<typeof generatedAnswerSchema>

export type ValidationResult =
  | { ok: true; answer: GeneratedAnswer }
  | { ok: false; reason: string }

// Bare hostnames are allowed: warning sources legitimately name lookalike domains, and claims
// render as plain, non-clickable text. Scheme URLs and markdown links are rejected.
const LINK = /\b[a-z][a-z0-9+.-]*:\/\/|\]\(/iu
const MARKUP = /<\s*\/?\s*[a-z!][^>]*>|javascript:/iu
const DONATION_INSTRUCTION =
  /(^|[.!?]\s+)(please\s+)?(donate|send|transfer|wire|give|pay)\b|\b(you should|we recommend|we urge you to|go ahead and)\s+(donate|give|send|transfer|wire|pay)\b/iu

function unsafeText(text: string): string | null {
  if (LINK.test(text)) return 'raw link'
  if (MARKUP.test(text)) return 'markup'
  if (DONATION_INSTRUCTION.test(text)) return 'donation instruction'
  return null
}

/**
 * Structural validation only. It cannot prove that a claim follows from its citation;
 * held-out human review (US09) measures semantic support (ai.md §8).
 */
export function validateGeneratedAnswer(candidate: unknown, allowedCitationIds: ReadonlySet<string>): ValidationResult {
  const parsed = generatedAnswerSchema.safeParse(candidate)
  if (!parsed.success) return { ok: false, reason: 'schema' }
  const answer = parsed.data

  if (answer.answerability === 'insufficient' && answer.claims.length > 0) {
    return { ok: false, reason: 'insufficient answer with claims' }
  }
  if (answer.answerability !== 'insufficient' && answer.claims.length === 0) {
    return { ok: false, reason: 'answer without claims' }
  }
  for (const claim of answer.claims) {
    if (claim.citationIds.some((id) => !allowedCitationIds.has(id))) return { ok: false, reason: 'unknown citation' }
    const unsafe = unsafeText(claim.text)
    if (unsafe) return { ok: false, reason: unsafe }
  }
  for (const limitation of answer.limitations) {
    const unsafe = unsafeText(limitation)
    if (unsafe) return { ok: false, reason: unsafe }
  }
  return {
    ok: true,
    answer: {
      ...answer,
      claims: answer.claims.map((claim) => ({ ...claim, citationIds: [...new Set(claim.citationIds)] })),
    },
  }
}
