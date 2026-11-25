import { waitForAbortable } from '../../abortable.js'
import {
  chatResponseSchema,
  type ChatRequest, type ChatResponse, type Citation,
} from '@reliefcheck/contracts'
import {
  RETRIEVAL_CONFIG, fuseAndSelect,
  type RetrievedChunk, type RetrievalConfig, type RetrievalRepository, type SemanticHit, type Snapshot,
} from '../retrieval/retriever.js'
import { isDisasterOverview, OVERVIEW_EMBEDDING_QUERY, retrieveDisasterOverview } from '../retrieval/disasterOverview.js'
import { buildFactualPrompt, type PromptEvidence } from './promptBuilder.js'
import { validateGeneratedAnswer } from './outputValidator.js'
import { ProviderError, type AnswerGenerator, type QueryEmbedder } from './provider.js'
import { redactPersonalData } from './redact.js'
import { timeStage, type StageObserver } from '../observability/requestTelemetry.js'

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
  overviewWithoutSemantic: 'Semantic search was unavailable. The overview uses reviewed sources for the selected disaster.',
  fallback: 'A generated answer was unavailable or failed validation. These are retrieved source excerpts, not a synthesized answer.',
  overviewAbstained: 'A summary could not be generated from the available passages. These are excerpts from reviewed sources for the selected disaster.',
  evidenceOnly: 'ReliefCheck summarizes reviewed sources. It cannot certify that an organization, website or appeal is safe.',
} as const

function stageSignal(parent: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(ms)])
}

function toCitation(chunk: RetrievedChunk, id: string): Citation {
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
  /** US10: optional per-stage latency observer. Receives durations only, never request content. */
  observe?: StageObserver,
): Promise<AnswerOutcome> {
  const config = deps.config ?? RETRIEVAL_CONFIG
  const deadlines = deps.deadlines ?? DEFAULT_DEADLINES
  const signal = stageSignal(parentSignal, deadlines.totalMs)

  signal.throwIfAborted()
  const corpus = await timeStage(observe, 'snapshot', () => waitForAbortable(deps.retrieval.activeCorpus(), signal))
  signal.throwIfAborted()
  if (!corpus) return { kind: 'corpus_unavailable' }
  const snapshot: Snapshot = { ...corpus.snapshot, asOf: (deps.now?.() ?? new Date()).toISOString() }
  const { releaseId } = corpus.snapshot
  const { disasterId } = request

  // Normalize sentence endings without changing punctuation inside names, dates, or amounts.
  const normalized = request.question.normalize('NFC').replace(/\s+/gu, ' ').trim()
  const question = normalized.replace(/[.!?。！？؟]+$/u, '').trimEnd() || normalized
  const providerQuestion = redactPersonalData(question)
  const overview = isDisasterOverview(question)

  let semantic: SemanticHit[] = []
  let hybrid = false
  const profileMatches = deps.embedder !== null &&
    corpus.embeddingProfile.model === deps.embedder.model &&
    corpus.embeddingProfile.dimensions === deps.embedder.dimensions
  if (deps.embedder && profileMatches) {
    const embedder = deps.embedder
    const embeddingSignal = stageSignal(signal, deadlines.embedMs)
    try {
      const embeddingQuery = overview ? OVERVIEW_EMBEDDING_QUERY : providerQuestion
      const vector = await timeStage(observe, 'embed', () =>
        waitForAbortable(embedder.embedQuery(embeddingQuery, embeddingSignal), embeddingSignal))
      signal.throwIfAborted()
      semantic = await timeStage(observe, 'retrieve', () => waitForAbortable(deps.retrieval.semanticSearch({
        releaseId, disasterId, profileId: corpus.embeddingProfile.id, vector, limit: config.candidatesPerModality,
      }), signal))
      hybrid = true
    } catch (error) {
      signal.throwIfAborted()
      if (!(error instanceof ProviderError) && !embeddingSignal.aborted) throw error
      // Embedding quota/timeout/unavailable: degrade to scoped lexical retrieval (ai.md §10).
    }
  }

  signal.throwIfAborted()
  const scope = { releaseId, disasterId }
  const selected = await timeStage(observe, 'retrieve', async () => overview
    ? await waitForAbortable(retrieveDisasterOverview(deps.retrieval, scope, semantic, config, signal), signal)
    : fuseAndSelect({
      ...scope, semantic, question,
      lexical: await waitForAbortable(deps.retrieval.lexicalSearch({
        ...scope, question, limit: config.candidatesPerModality,
      }), signal),
    }, config))
  signal.throwIfAborted()
  const retrievalMode = hybrid ? 'hybrid' : 'lexical_only'
  const baseLimitations: string[] = hybrid ? [] : [
    overview ? LIMITATION_TEXT.overviewWithoutSemantic : LIMITATION_TEXT.lexicalOnly,
  ]

  const finish = async (response: Omit<ChatResponse, 'requestId' | 'snapshot' | 'mode' | 'retrievalMode'>): Promise<AnswerOutcome> => {
    signal.throwIfAborted()
    const current = await timeStage(observe, 'recheck', () => waitForAbortable(deps.retrieval.currentSnapshot(), signal))
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
  const extractive = (limitation: string = LIMITATION_TEXT.fallback) => finish({
    status: 'extractive_fallback', claims: [], citations,
    limitations: [limitation, ...baseLimitations],
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
  const prompt = buildFactualPrompt({ question: providerQuestion, disasterName: null, evidence, overview })

  let candidate: unknown
  signal.throwIfAborted()
  const generator = deps.generator
  const generationSignal = stageSignal(signal, deadlines.generateMs)
  try {
    candidate = await timeStage(observe, 'generate', () =>
      waitForAbortable(generator.generate(prompt, generationSignal), generationSignal))
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
    if (overview) return extractive(LIMITATION_TEXT.overviewAbstained)
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
