import type pg from 'pg'
import { disastersResponseSchema } from '@reliefcheck/contracts'
import { contentTerms, type RetrievalRepository, type RetrievedChunk, type Snapshot } from '../services/retrieval/retriever.js'
import type { SourceEvidenceRepository } from '../services/sources/sourceEvidence.js'

type Queryable = Pick<pg.Pool, 'query'>
type ActiveRow = { releaseId: string; epoch: number; profileId: string; model: string; dimensions: number }
type ChunkRow = Omit<RetrievedChunk, 'reviewedAt'> & { reviewedAt: Date }

const chunkFields = `
  chunk_id AS "chunkId", source_version_id AS "sourceVersionId", text, locator, title,
  source_url AS "sourceUrl", publication_date AS "publicationDate", reviewed_at AS "reviewedAt",
  release_id AS "memberReleaseId", disaster_id AS "disasterId", review_state AS "reviewState"`

function snapshot(row: { releaseId: string; epoch: number }): Snapshot {
  return { releaseId: row.releaseId, epoch: row.epoch, asOf: new Date().toISOString() }
}

export function createPublishedCorpus(pool: Queryable) {
  const retrieval: RetrievalRepository = {
    async activeCorpus() {
      const { rows: [row] } = await pool.query<ActiveRow>(`
        SELECT release_id AS "releaseId", epoch, profile_id AS "profileId", model, dimensions
        FROM relief.active_corpus`)
      return row ? {
        snapshot: snapshot(row),
        embeddingProfile: { id: row.profileId, model: row.model, dimensions: row.dimensions },
      } : null
    },
    async currentSnapshot() {
      return (await retrieval.activeCorpus())?.snapshot ?? null
    },
    async semanticSearch({ releaseId, disasterId, profileId, vector, limit }) {
      if (vector.length !== 768 || vector.some(value => !Number.isFinite(value))) {
        throw new Error('Invalid query embedding')
      }
      const { rows } = await pool.query<ChunkRow & { cosineSimilarity: number }>(`
        SELECT ${chunkFields},
               1 - (embedding OPERATOR(extensions.<=>) $4::extensions.vector) AS "cosineSimilarity"
        FROM relief.published_chunks
        WHERE release_id = $1 AND disaster_id = $2 AND profile_id = $3 AND embedding IS NOT NULL
        ORDER BY embedding OPERATOR(extensions.<=>) $4::extensions.vector, chunk_id
        LIMIT $5`, [releaseId, disasterId, profileId, JSON.stringify(vector), limit])
      return rows.map(row => ({ ...row, reviewedAt: row.reviewedAt.toISOString() }))
    },
    async lexicalSearch({ releaseId, disasterId, question, limit }) {
      // Search meaningful words independently. The answer service checks the
      // minimum overlap before it uses any passage as evidence.
      const terms = [...contentTerms(question)].join(' OR ')
      if (!terms) return []
      const { rows } = await pool.query<ChunkRow>(`
        SELECT ${chunkFields}
        FROM relief.published_chunks
        CROSS JOIN websearch_to_tsquery('pg_catalog.simple', $3) AS query
        WHERE release_id = $1 AND disaster_id = $2 AND search_vector @@ query
        ORDER BY ts_rank_cd(search_vector, query) DESC, chunk_id
        LIMIT $4`, [releaseId, disasterId, terms, limit])
      return rows.map(row => ({ ...row, reviewedAt: row.reviewedAt.toISOString() }))
    },
  }

  const sourceEvidence: SourceEvidenceRepository = {
    currentSnapshot: retrieval.currentSnapshot,
    async lookup(sourceVersionId) {
      const { rows: [row] } = await pool.query<{
        releaseId: string; epoch: number; title: string | null; sourceUrl: string | null
        publicationDate: string | null; reviewedAt: Date | null
        excerpts: { locator: string; excerpt: string }[] | null
      }>(`
        SELECT a.release_id AS "releaseId", a.epoch, c.title, c.source_url AS "sourceUrl",
               c.publication_date AS "publicationDate", c.reviewed_at AS "reviewedAt", c.excerpts
        FROM relief.active_corpus a
        LEFT JOIN LATERAL (
          SELECT title, source_url, publication_date, reviewed_at,
                 json_agg(json_build_object('locator', locator, 'excerpt', text)
                          ORDER BY ordinal, chunk_id) AS excerpts
          FROM (
            SELECT DISTINCT chunk_id, ordinal, locator, text, title, source_url, publication_date, reviewed_at
            FROM relief.published_chunks
            WHERE release_id = a.release_id AND source_version_id = $1
            ORDER BY ordinal, chunk_id LIMIT 20
          ) excerpts
          GROUP BY title, source_url, publication_date, reviewed_at
        ) c ON true`, [sourceVersionId])
      if (!row) return { snapshot: null, record: null }
      return {
        snapshot: snapshot(row),
        record: row.title && row.reviewedAt && row.excerpts ? {
          sourceVersionId, title: row.title, sourceUrl: row.sourceUrl, publicationDate: row.publicationDate,
          reviewedAt: row.reviewedAt.toISOString(), excerpts: row.excerpts,
          reviewState: 'approved', releaseState: 'published', memberReleaseId: row.releaseId,
        } : null,
      }
    },
  }

  return {
    retrieval,
    sourceEvidence,
    async listDisasters() {
      const { rows } = await pool.query('SELECT id, slug, name FROM relief.disasters ORDER BY name LIMIT 100')
      return disastersResponseSchema.parse({ disasters: rows })
    },
  }
}
