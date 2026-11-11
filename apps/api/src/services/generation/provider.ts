/**
 * Provider boundary for US03. Services depend on these interfaces, never on the Gemini SDK,
 * so tests and degraded modes do not need network access (ai.md §9 repository boundaries).
 */

export type ProviderFailure = 'quota' | 'timeout' | 'unavailable' | 'busy' | 'blocked' | 'malformed'

export class ProviderError extends Error {
  constructor(readonly failure: ProviderFailure, readonly retryAfterSeconds?: number) {
    super(`Provider call failed: ${failure}`)
    this.name = 'ProviderError'
  }
}

export interface QueryEmbedder {
  /** Exact model ID; must equal the published embedding profile's model. */
  readonly model: string
  readonly dimensions: number
  /** Returns a finite, L2-normalized vector of `dimensions` length, or throws ProviderError. */
  embedQuery(text: string, signal: AbortSignal): Promise<number[]>
}

export type BuiltPrompt = {
  mode: 'factual'
  systemInstruction: string
  /** Structured, clearly delimited request + evidence blocks. Untrusted text lives only here. */
  contents: string
  maxOutputTokens: number
  temperature: number
}

export interface AnswerGenerator {
  readonly model: string
  /** Returns the parsed-but-untrusted JSON candidate, or throws ProviderError. */
  generate(prompt: BuiltPrompt, signal: AbortSignal): Promise<unknown>
}

/** Rejects zero, non-finite or wrong-sized vectors and L2-normalizes the rest (ai.md §4.7). */
export function normalizeVector(values: readonly number[], dimensions: number): number[] {
  if (values.length !== dimensions || !values.every(Number.isFinite)) throw new ProviderError('malformed')
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))
  if (!Number.isFinite(norm) || norm === 0) throw new ProviderError('malformed')
  return values.map((value) => value / norm)
}
