import { waitForAbortable } from '../../abortable.js'
import { GoogleGenAI, Type, type Schema } from '@google/genai'
import type { GeminiConfig } from '../../config/env.js'
import {
  ProviderError, normalizeVector,
  type AnswerGenerator, type BuiltPrompt, type QueryEmbedder,
} from '../../services/generation/provider.js'

/** Structured output schema for GeneratedAnswer (ai.md §8). The server still validates it. */
const generatedAnswerResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    answerability: { type: Type.STRING, enum: ['supported', 'partial', 'insufficient'] },
    claims: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          text: { type: Type.STRING },
          citationIds: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['text', 'citationIds'],
      },
    },
    limitations: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['answerability', 'claims', 'limitations'],
}

const MAX_CONCURRENT_CALLS = 2

function statusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') {
    return error.status
  }
  return undefined
}

/**
 * Gemini Developer API adapter (official @google/genai SDK). No tools, URL context, search
 * grounding or code execution are ever configured. Errors are mapped to ProviderError so no
 * provider internals reach logs or responses.
 *
 * The concurrency cap and 429 cooldown are process-local. Durable quota admission
 * (`quota_buckets`, ai.md §10) is not implemented yet and is tracked as a US03 limitation.
 */
export function createGeminiClient(config: GeminiConfig): { embedder: QueryEmbedder; generator: AnswerGenerator; embedDocument: (text: string, signal: AbortSignal) => Promise<number[]> } {
  const ai = new GoogleGenAI({ apiKey: config.apiKey })
  let active = 0
  let cooldownUntil = 0

  async function call<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    const now = Date.now()
    if (now < cooldownUntil) throw new ProviderError('quota', Math.ceil((cooldownUntil - now) / 1000))
    if (active >= MAX_CONCURRENT_CALLS) throw new ProviderError('busy')
    if (signal.aborted) throw new ProviderError('timeout')
    active += 1
    // Cancellation ends the caller's wait. The slot stays occupied until the SDK settles.
    const operation = Promise.resolve().then(() => {
      if (signal.aborted) throw new ProviderError('timeout')
      return run()
    }).catch((error: unknown) => {
      if (statusOf(error) === 429) {
        cooldownUntil = Math.max(cooldownUntil, Date.now() + 60_000)
        throw new ProviderError('quota', 60)
      }
      if (error instanceof ProviderError) throw error
      throw new ProviderError(signal.aborted ? 'timeout' : 'unavailable')
    }).finally(() => { active -= 1 })
    try {
      return await waitForAbortable(operation, signal)
    } catch (error) {
      if (error instanceof ProviderError) throw error
      if (signal.aborted) throw new ProviderError('timeout')
      throw error
    }
  }

  const dimensions = 768
  async function embed(text: string, taskType: 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT', signal: AbortSignal) {
    const response = await call(signal, () => ai.models.embedContent({
      model: config.embeddingModel,
      contents: text,
      config: { taskType, outputDimensionality: dimensions, abortSignal: signal },
    }))
    return normalizeVector(response.embeddings?.[0]?.values ?? [], dimensions)
  }
  const embedder: QueryEmbedder = {
    model: config.embeddingModel,
    dimensions,
    embedQuery: (text, signal) => embed(text, 'RETRIEVAL_QUERY', signal),
  }
  const generator: AnswerGenerator = {
    model: config.generationModel,
    async generate(prompt: BuiltPrompt, signal) {
      const response = await call(signal, () => ai.models.generateContent({
        model: config.generationModel,
        contents: prompt.contents,
        config: {
          systemInstruction: prompt.systemInstruction,
          temperature: prompt.temperature,
          maxOutputTokens: prompt.maxOutputTokens,
          responseMimeType: 'application/json',
          responseSchema: generatedAnswerResponseSchema,
          abortSignal: signal,
        },
      }))
      if (response.promptFeedback?.blockReason) throw new ProviderError('blocked')
      const text = response.text
      if (!text) throw new ProviderError('malformed')
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new ProviderError('malformed')
      }
    },
  }

  return { embedder, generator, embedDocument: (text, signal) => embed(text, 'RETRIEVAL_DOCUMENT', signal) }
}
