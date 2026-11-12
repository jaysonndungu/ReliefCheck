import { waitForAbortable } from '../../abortable.js'
import {
  chatResponseSchema,
  type ChatRequest, type ChatResponse, type Citation,
} from '@reliefcheck/contracts'
import {
  RETRIEVAL_CONFIG, fuseAndSelect,
  type FusedChunk, type RetrievalConfig, type RetrievalRepository, type SemanticHit, type Snapshot,
} from '../retrieval/retriever.js'
import { buildFactualPrompt, type PromptEvidence } from './promptBuilder.js'
import { validateGeneratedAnswer } from './outputValidator.js'
import { ProviderError, type AnswerGenerator, type QueryEmbedder } from './provider.js'
import { redactPersonalData } from './redact.js'

export type AnswerDeps = {
  retrieval: RetrievalRepository
  /** null when Gemini is not configured: lexical retrieval + excerpts only, no provider calls. */
  embedder: QueryEmbedder | null
  generator: AnswerGenerator | null
  config?: RetrievalConfig
  /** Initial budgets from ai.md §10; must be validated on the chosen host. */
  deadlines?: { totalMs: number; embedMs: number; generateMs: number }
  now?: () => Date
}

export type AnswerOutcome =
  | { kind: 'answered'; response: ChatResponse }
  | { kind: 'corpus_unavailable' }
  | { kind: 'changed' }

const DEFAULT_DEADLINES = { totalMs: 25_000, embedMs: 6_000, generateMs: 15_000 }

export const LIMITATION_TEXT = {
  insufficient: 'The reviewed sources for this disaster do not contain enough evidence to answer this question.',
  partial: 'Parts of this question are not covered by the reviewed sources.',
  lexicalOnly: 'Semantic search was unavailable, so these results use keyword matching only.',
  fallback: 'A generated answer was unavailable or failed validation. These are retrieved source excerpts, not a synthesized answer.',
  evidenceOnly: 'ReliefCheck summarizes reviewed sources. It cannot certify that an organization, website or appeal is safe.',
} as const

function stageSignal(parent: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(ms)])
}

function toCitation(chunk: FusedChunk, id: string): Citation {
  return {
    id,
    sourceVersionId: chunk.sourceVersionId,
    title: chunk.title,
    sourceUrl: chunk.sourceUrl,
    publicationDate: chunk.publicationDate,
    reviewedAt: chunk.reviewedAt,
    locator: chunk.locator,
    excerpt: chunk.text,
  }
}

/**
 * US03 grounded-answer pipeline for factual chat:
 * snapshot → embed (optional) → hybrid retrieval → sufficiency → prompt → generate → validate
 * → epoch recheck → respond. No evidence means no Gemini call (ai.md §5, §8).
 */
export async function answerQuestion(
  deps: AnswerDeps,
  request: ChatRequest,
  parentSignal: AbortSignal = new AbortController().signal,
): Promise<AnswerOutcome> {
  const config = deps.config ?? RETRIEVAL_CONFIG
  const deadlines = deps.deadlines ?? DEFAULT_DEADLINES
  const signal = stageSignal(parentSignal, deadlines.totalMs)

  signal.throwIfAborted()
  const corpus = await waitForAbortable(deps.retrieval.activeCorpus(), signal)
  signal.throwIfAborted()
  if (!corpus) return { kind: 'corpus_unavailable' }
  const snapshot: Snapshot = { ...corpus.snapshot, asOf: (deps.now?.() ?? new Date()).toISOString() }
  const { releaseId } = corpus.snapshot
  const { disasterId } = request

  // Normalize sentence endings without changing punctuation inside names, dates, or amounts.
  const normalized = request.question.normalize('NFC').replace(/\s+/gu, ' ').trim()
  const question = normalized.replace(/[.!?。！？؟]+$/u, '').trimEnd() || normalized
  const providerQuestion = redactPersonalData(question)

  let semantic: SemanticHit[] = []
  let hybrid = false
  const profileMatches = deps.embedder !== null &&
    corpus.embeddingProfile.model === deps.embedder.model &&
    corpus.embeddingProfile.dimensions === deps.embedder.dimensions
  if (deps.embedder && profileMatches) {
    const embeddingSignal = stageSignal(signal, deadlines.embedMs)
    try {
      const vector = await waitForAbortable(deps.embedder.embedQuery(providerQuestion, embeddingSignal), embeddingSignal)
      signal.throwIfAborted()
      semantic = await waitForAbortable(deps.retrieval.semanticSearch({
        releaseId, disasterId, profileId: corpus.embeddingProfile.id, vector, limit: config.candidatesPerModality,
      }), signal)
      hybrid = true
    } catch (error) {
      signal.throwIfAborted()
      if (!(error instanceof ProviderError) && !embeddingSignal.aborted) throw error
      // Embedding quota/timeout/unavailable: degrade to scoped lexical retrieval (ai.md §10).
    }
  }

  signal.throwIfAborted()
  const lexical = await waitForAbortable(deps.retrieval.lexicalSearch({
    releaseId, disasterId, question, limit: config.candidatesPerModality,
  }), signal)
  signal.throwIfAborted()
  const selected = fuseAndSelect({ semantic, lexical, question, releaseId, disasterId }, config)
  const retrievalMode = hybrid ? 'hybrid' : 'lexical_only'
  const baseLimitations: string[] = hybrid ? [] : [LIMITATION_TEXT.lexicalOnly]

  const finish = async (response: Omit<ChatResponse, 'requestId' | 'snapshot' | 'mode' | 'retrievalMode'>): Promise<AnswerOutcome> => {
    signal.throwIfAborted()
    const current = await waitForAbortable(deps.retrieval.currentSnapshot(), signal)
    signal.throwIfAborted()
    if (!current || current.releaseId !== releaseId || current.epoch !== corpus.snapshot.epoch) {
      return { kind: 'changed' }
    }
    const parsed = chatResponseSchema.safeParse({
      requestId: request.requestId, snapshot, mode: 'factual', retrievalMode, ...response,
    })
    if (!parsed.success) throw new Error('Assembled chat response failed contract validation')
    return { kind: 'answered', response: parsed.data }
  }

  if (selected.length === 0) {
    return finish({
      status: 'insufficient_evidence', claims: [], citations: [],
      limitations: [LIMITATION_TEXT.insufficient, ...baseLimitations],
    })
  }

  const citations = selected.map((chunk, index) => toCitation(chunk, `S${index + 1}`))
  const extractive = () => finish({
    status: 'extractive_fallback', claims: [], citations,
    limitations: [LIMITATION_TEXT.fallback, ...baseLimitations],
  })

  if (!deps.generator) return extractive()

  const evidence: PromptEvidence[] = citations.map((citation) => ({
    citationId: citation.id,
    title: citation.title,
    publicationDate: citation.publicationDate,
    reviewedAt: citation.reviewedAt,
    locator: citation.locator,
    text: citation.excerpt,
  }))
  const prompt = buildFactualPrompt({ question: providerQuestion, disasterName: null, evidence })

  let candidate: unknown
  signal.throwIfAborted()
  const generationSignal = stageSignal(signal, deadlines.generateMs)
  try {
    candidate = await waitForAbortable(deps.generator.generate(prompt, generationSignal), generationSignal)
  } catch (error) {
    signal.throwIfAborted()
    if (!(error instanceof ProviderError) && !generationSignal.aborted) throw error
    return extractive()
  }

  // No second unrestricted generation on failure (ai.md §8).
  const validated = validateGeneratedAnswer(candidate, new Set(citations.map((citation) => citation.id)))
  if (!validated.ok) return extractive()
  const answer = validated.answer

  if (answer.answerability === 'insufficient') {
    return finish({
      status: 'insufficient_evidence', claims: [], citations: [],
      limitations: [LIMITATION_TEXT.insufficient, ...baseLimitations],
    })
  }

  const citedIds = new Set(answer.claims.flatMap((claim) => claim.citationIds))
  // Keep room for the server-owned limitations within the 12-item contract cap.
  const limitations = answer.limitations.slice(0, 9)
  if (answer.answerability === 'partial' && limitations.length === 0) limitations.push(LIMITATION_TEXT.partial)
  limitations.push(...baseLimitations, LIMITATION_TEXT.evidenceOnly)

  return finish({
    status: answer.answerability === 'supported' ? 'supported' : 'partial',
    claims: answer.claims,
    citations: citations.filter((citation) => citedIds.has(citation.id)),
    limitations,
  })
}
