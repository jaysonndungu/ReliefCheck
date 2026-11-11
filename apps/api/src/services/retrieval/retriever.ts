import type { ChatResponse } from '@reliefcheck/contracts'

export type Snapshot = ChatResponse['snapshot']

/** One published chunk plus the provenance needed to cite it (ai.md §8 citation contract). */
export type RetrievedChunk = {
  chunkId: string
  sourceVersionId: string
  text: string
  locator: string
  title: string
  sourceUrl: string | null
  publicationDate: string | null
  reviewedAt: string
  /** Defense in depth: the service re-checks membership the SQL already enforces. */
  memberReleaseId: string
  disasterId: string
  reviewState: 'approved' | 'pending' | 'rejected'
}

export type SemanticHit = RetrievedChunk & { cosineSimilarity: number }

export type ActiveCorpus = {
  snapshot: Snapshot
  /** Embedding profile of the captured release; query vectors must use the same model. */
  embeddingProfile: { id: string; model: string; dimensions: number }
}

/**
 * Integration boundary for Anson's SQL retrieval over Jayson's published-release schema.
 * Both searches MUST hard-filter to `releaseId` + `disasterId` before LIMIT (ai.md §5) and
 * return results ordered best-first. No pgvector ANN index is assumed.
 */
export interface RetrievalRepository {
  /** Active release + epoch, or null when the knowledge base is cleared. */
  activeCorpus(): Promise<ActiveCorpus | null>
  /** Exact cosine search: ORDER BY embedding <=> $vector, chunk id. */
  semanticSearch(query: {
    releaseId: string; disasterId: string; profileId: string; vector: number[]; limit: number
  }): Promise<SemanticHit[]>
  /** websearch_to_tsquery('simple', $question) over the generated search_vector. */
  lexicalSearch(query: {
    releaseId: string; disasterId: string; question: string; limit: number
  }): Promise<RetrievedChunk[]>
  /** Re-read just before responding to detect clear/publish during the request. */
  currentSnapshot(): Promise<Snapshot | null>
}

/** Initial values from ai.md §5/§8. The similarity floor is untuned until US09's dev set exists. */
export const RETRIEVAL_CONFIG = {
  candidatesPerModality: 20,
  rrfK: 60,
  maxChunks: 6,
  maxChunksPerSource: 2,
  maxEvidenceCharacters: 12_000,
  /** INITIAL, UNTUNED. Tune on the development set, freeze, then measure on held-out (ai.md §5). */
  semanticSimilarityFloor: 0.7,
  minLexicalTermOverlap: 2,
} as const

export type RetrievalConfig = typeof RETRIEVAL_CONFIG

// Small English/Spanish function-word list; lexical overlap must come from content terms.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'what', 'which', 'who', 'whom', 'how', 'why', 'when',
  'where', 'does', 'did', 'can', 'could', 'should', 'would', 'about', 'with', 'from', 'that', 'this',
  'there', 'their', 'they', 'have', 'has', 'had', 'any', 'into', 'than', 'then', 'them', 'you', 'your',
  'los', 'las', 'del', 'por', 'para', 'con', 'una', 'uno', 'que', 'qué', 'como', 'cómo', 'cuál',
  'dónde', 'donde', 'cuando', 'cuándo', 'quién', 'son', 'está', 'esta', 'este', 'hay', 'sobre',
])

export function contentTerms(text: string): Set<string> {
  const terms = text.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return new Set(terms.filter((term) => term.length >= 3 && !STOPWORDS.has(term)))
}

export function termOverlap(question: Set<string>, text: string): number {
  const chunkTerms = contentTerms(text)
  let count = 0
  for (const term of question) if (chunkTerms.has(term)) count += 1
  return count
}

export type FusedChunk = RetrievedChunk & {
  rrfScore: number
  semanticRank: number | null
  lexicalRank: number | null
  cosineSimilarity: number | null
}

/**
 * Reciprocal rank fusion (1-based ranks, absent modality contributes 0), then the evidence
 * sufficiency gate, de-duplication and per-source / total / character caps.
 * Deterministic: ties are broken by chunk ID. Never manufactures diversity.
 */
export function fuseAndSelect(
  input: {
    semantic: SemanticHit[]
    lexical: RetrievedChunk[]
    question: string
    releaseId: string
    disasterId: string
  },
  config: RetrievalConfig = RETRIEVAL_CONFIG,
): FusedChunk[] {
  const eligible = (chunk: RetrievedChunk) =>
    chunk.memberReleaseId === input.releaseId &&
    chunk.disasterId === input.disasterId &&
    chunk.reviewState === 'approved' &&
    chunk.text.trim().length > 0

  const byId = new Map<string, FusedChunk>()
  input.semantic.filter(eligible).slice(0, config.candidatesPerModality).forEach((hit, index) => {
    if (byId.has(hit.chunkId)) return
    byId.set(hit.chunkId, {
      ...hit, semanticRank: index + 1, lexicalRank: null, cosineSimilarity: hit.cosineSimilarity, rrfScore: 0,
    })
  })
  input.lexical.filter(eligible).slice(0, config.candidatesPerModality).forEach((hit, index) => {
    const existing = byId.get(hit.chunkId)
    if (existing) {
      if (existing.lexicalRank === null) existing.lexicalRank = index + 1
      return
    }
    byId.set(hit.chunkId, {
      ...hit, semanticRank: null, lexicalRank: index + 1, cosineSimilarity: null, rrfScore: 0,
    })
  })

  const questionTerms = contentTerms(input.question)
  const requiredOverlap = Math.min(config.minLexicalTermOverlap, questionTerms.size)
  const sufficient = (chunk: FusedChunk) => {
    const semanticOk = chunk.cosineSimilarity !== null && chunk.cosineSimilarity >= config.semanticSimilarityFloor
    const lexicalOk = chunk.lexicalRank !== null && requiredOverlap > 0 &&
      termOverlap(questionTerms, chunk.text) >= requiredOverlap
    return semanticOk || lexicalOk
  }

  const ranked = [...byId.values()]
    .map((chunk) => {
      chunk.rrfScore =
        (chunk.semanticRank ? 1 / (config.rrfK + chunk.semanticRank) : 0) +
        (chunk.lexicalRank ? 1 / (config.rrfK + chunk.lexicalRank) : 0)
      return chunk
    })
    .filter(sufficient)
    .sort((a, b) => b.rrfScore - a.rrfScore || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0))

  const selected: FusedChunk[] = []
  const perSource = new Map<string, number>()
  const seenText = new Set<string>()
  let characters = 0
  for (const chunk of ranked) {
    if (selected.length >= config.maxChunks) break
    const normalized = chunk.text.replace(/\s+/gu, ' ').trim()
    if (seenText.has(normalized)) continue
    const sourceCount = perSource.get(chunk.sourceVersionId) ?? 0
    if (sourceCount >= config.maxChunksPerSource) continue
    // Skip rather than truncate: a cut excerpt could drop a negation or date.
    if (characters + chunk.text.length > config.maxEvidenceCharacters) continue
    seenText.add(normalized)
    perSource.set(chunk.sourceVersionId, sourceCount + 1)
    characters += chunk.text.length
    selected.push(chunk)
  }
  return selected
}
