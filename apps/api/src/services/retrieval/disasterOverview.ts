import {
  rankEvidence, selectEvidence,
  type RetrievalConfig, type RetrievalRepository, type SemanticHit,
} from './retriever.js'

const OVERVIEW_QUESTIONS = [
  /^what (?:did|do) (?:the )?(?:(?:published|reviewed|available) )?(?:sources|resources|reports|articles) (?:say|report|document) about (?:this |the (?:selected )?)disaster$/iu,
  /^(?:(?:can|could) you )?summari[sz]e (?:what (?:the )?(?:(?:published|reviewed) )?(?:sources|resources|reports) (?:say|said|report|reported) about )?(?:this |the (?:selected )?)disaster$/iu,
  /^(?:(?:give me|provide) )?an overview of (?:this |the (?:selected )?)disaster$/iu,
  /^what happened(?: (?:during|in) (?:this |the (?:selected )?)disaster)?$/iu,
]

export function isDisasterOverview(question: string): boolean {
  return OVERVIEW_QUESTIONS.some((pattern) => pattern.test(question))
}

export const OVERVIEW_EMBEDDING_QUERY =
  'What impacts, humanitarian needs, relief and recovery efforts, and donation warnings were documented after the disaster?'

// The published index uses exact terms. Include common singular/plural and
// Spanish variants so the lexical route can work without query embeddings.
const TOPIC_QUERIES = [
  'damage damaged destroyed destruction impact flooding flood homes housing affected displaced losses infraestructura daños viviendas inundación inundaciones afectadas afectados',
  'relief aid assistance response recovery food meals shelter water sanitation supplies health reconstruction ayuda asistencia respuesta recuperación alimentos agua refugio reconstrucción',
  'fraud warning warnings advisory scam scams fake fraudulent donation donations impersonation websites estafa estafas fraude advertencia alerta donaciones sitios falsos',
]

export async function retrieveDisasterOverview(
  repository: RetrievalRepository,
  scope: { releaseId: string; disasterId: string },
  semantic: SemanticHit[],
  config: RetrievalConfig,
) {
  const lists = await Promise.all(TOPIC_QUERIES.map(async (question) => {
    const lexical = await repository.lexicalSearch({ ...scope, question, limit: config.candidatesPerModality })
    return rankEvidence({ ...scope, question, semantic: [], lexical }, config)
  }))
  lists.push(rankEvidence({
    ...scope, question: OVERVIEW_EMBEDDING_QUERY, semantic, lexical: [],
  }, config))

  // Interleave the rankings before applying the shared evidence limits so
  // several strong hits on a single topic do not take every available slot.
  const ranked = Array.from({ length: Math.max(...lists.map((list) => list.length)) }, (_, index) =>
    lists.flatMap((list) => list.slice(index, index + 1)),
  ).flat()
  return selectEvidence(ranked, config, true)
}
