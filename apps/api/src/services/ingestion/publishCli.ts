import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type pg from 'pg'
import { z } from 'zod'
import { createGeminiClient } from '../../adapters/gemini/geminiClient.js'
import { loadConfig } from '../../config/env.js'
import { createPool } from '../../db/pool.js'
import { extractionSchema } from './extractionSchema.js'
import { preprocessDocument } from './preprocess.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const bundleSchema = z.strictObject({
  actor: z.uuid(),
  expectedEpoch: z.number().int().nonnegative(),
  sources: z.array(extractionSchema.extend({
    reviewedCleanedHash: z.string().regex(/^[a-f0-9]{64}$/),
  })).min(2).max(100),
})

async function publish(path: string) {
  const bundle = bundleSchema.parse(JSON.parse((await readFile(path, 'utf8')).replace(/^\ufeff/u, '')))
  const ids = new Set<string>()
  const disasters = new Set<string>()
  const prepared = bundle.sources.map(({ source, document, reviewedCleanedHash }) => {
    if (ids.has(source.id.toLowerCase())) throw new Error('Duplicate source ID')
    ids.add(source.id.toLowerCase())
    disasters.add(source.disaster)
    if (source.reviewStatus !== 'approved' || !z.uuid().safeParse(source.reviewedBy).success) {
      throw new Error('Each source needs explicit approval and a reviewer UUID')
    }
    const preparation = preprocessDocument(document, source)
    if (!preparation.chunks.length || preparation.cleanedHash !== reviewedCleanedHash) {
      throw new Error('An extraction has no usable passages or differs from the reviewed preview')
    }
    return { source, document, preparation }
  })
  if (disasters.size !== 2) throw new Error('The release must cover both disasters')
  if (prepared.reduce((count, entry) => count + entry.preparation.chunks.length, 0) > 2000) {
    throw new Error('The release exceeds the 2,000-passage limit')
  }
  prepared.sort((a, b) => a.source.id.localeCompare(b.source.id))

  const config = loadConfig({ ...process.env, DATABASE_URL: process.env.CORPUS_OPERATOR_DATABASE_URL })
  if (!config.database || !config.gemini) throw new Error('Set CORPUS_OPERATOR_DATABASE_URL and the Gemini settings')
  if (config.gemini.embeddingModel !== 'gemini-embedding-001') {
    throw new Error('This publisher requires the gemini-embedding-001 retrieval profile')
  }
  const pool = createPool(config.database)
  try {
    const { rows: [state] } = await pool.query<{ epoch: number; activeReleaseId: string | null }>(`
      SELECT epoch, active_release_id AS "activeReleaseId" FROM relief.kb_state
      WHERE singleton AND EXISTS (
        SELECT 1 FROM relief.staff_roles WHERE user_id = $1 AND role = 'admin' AND enabled
      )`, [bundle.actor])
    if (!state || state.epoch !== bundle.expectedEpoch) throw new Error('Admin access or release epoch check failed')
    const reviewers = [...new Set(prepared.map(entry => entry.source.reviewedBy))]
    const { rowCount } = await pool.query(`
      SELECT user_id FROM relief.staff_roles WHERE enabled AND user_id = ANY($1::uuid[])`,
    [reviewers])
    if (rowCount !== reviewers.length) {
      throw new Error('Each reviewer must be an enabled staff member')
    }

    // Complete provider calls before taking any database lock.
    const gemini = createGeminiClient(config.gemini)
    const inputs = new Map<string, string>()
    for (const entry of prepared) {
      for (const chunk of entry.preparation.chunks) {
        const input = embeddingInput(entry.source.title, entry.source.language, chunk.heading, chunk.text)
        inputs.set(hash(input), input)
      }
    }
    const { rows: cached } = await pool.query<{ hash: string; vector: string }>(`
      SELECT DISTINCT ON (c.embedding_input_hash) c.embedding_input_hash AS hash, e.embedding::text AS vector
      FROM relief.chunks c
      JOIN relief.chunk_embeddings e ON e.chunk_id = c.id
      JOIN relief.embedding_profiles p ON p.id = e.profile_id
      WHERE p.provider = 'gemini' AND p.model = $1 AND p.dimensions = 768
        AND p.input_format_version = 'title-heading-language-body-v1'
        AND c.embedding_input_hash = ANY($2::text[])
      ORDER BY c.embedding_input_hash, c.id`, [config.gemini.embeddingModel, [...inputs.keys()]])
    const vectors = new Map(cached.map(row => [row.hash, row.vector]))
    for (const [inputHash, input] of inputs) {
      if (!vectors.has(inputHash)) {
        vectors.set(inputHash, JSON.stringify(await gemini.embedDocument(input, AbortSignal.timeout(15_000))))
      }
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const profileId = await insertId(client, `
        INSERT INTO relief.embedding_profiles (provider, model, dimensions, input_format_version)
        VALUES ('gemini', $1, 768, 'title-heading-language-body-v1')
        ON CONFLICT (provider, model, dimensions, input_format_version)
        DO UPDATE SET model = EXCLUDED.model RETURNING id`, [config.gemini.embeddingModel])
      const releaseId = await insertId(client, `
        INSERT INTO relief.releases (parent_release_id, embedding_profile_id, manifest_hash, created_by)
        VALUES ($1, $2, $3, $4) RETURNING id`,
      [state.activeReleaseId, profileId, hash(JSON.stringify({
        profileId,
        sources: prepared.map(({ source, preparation }) => ({
          source, content: preparation.sourceContentHash, cleaned: preparation.cleanedHash,
          version: preparation.preprocessingVersion,
        })),
      })), bundle.actor])

      for (const { source, document, preparation } of prepared) {
        const canonicalUrl = source.reference.kind === 'web' ? source.reference.url : null
        const sourceId = await insertId(client, `
          INSERT INTO relief.sources AS stored (manifest_id, canonical_url, method)
          VALUES ($1, $2, $3)
          ON CONFLICT (manifest_id) DO UPDATE SET manifest_id = EXCLUDED.manifest_id
          WHERE stored.canonical_url IS NOT DISTINCT FROM EXCLUDED.canonical_url AND stored.method = EXCLUDED.method
          RETURNING id`, [source.id, canonicalUrl, source.reference.kind])
        const versionId = await insertId(client, `
          INSERT INTO relief.source_versions AS stored
            (source_id, content_hash, extraction_version, cleaned_text, title, publisher, language,
             publication_date, retrieved_at, review_state, reviewed_by, reviewed_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'approved', $10, $11)
          ON CONFLICT (source_id, content_hash, extraction_version)
          DO UPDATE SET content_hash = EXCLUDED.content_hash
          WHERE (stored.cleaned_text, stored.title, stored.publisher, stored.language, stored.publication_date,
                 stored.review_state, stored.reviewed_by, stored.reviewed_at)
            IS NOT DISTINCT FROM
                (EXCLUDED.cleaned_text, EXCLUDED.title, EXCLUDED.publisher, EXCLUDED.language, EXCLUDED.publication_date,
                 EXCLUDED.review_state, EXCLUDED.reviewed_by, EXCLUDED.reviewed_at)
          RETURNING id`, [
          sourceId, preparation.sourceContentHash, preparation.preprocessingVersion,
          preparation.blocks.map(block => block.text).join('\n\n'), source.title, source.publisher,
          source.language, source.publicationDate, document.retrievedAt, source.reviewedBy, source.reviewedAt,
        ])
        const { rows: [disaster] } = await client.query<{ id: string }>(
          'SELECT id FROM relief.disasters WHERE slug = $1', [source.disaster],
        )
        if (!disaster) throw new Error('Unknown disaster')
        await client.query('INSERT INTO relief.source_disasters VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [versionId, disaster.id])
        await client.query('INSERT INTO relief.release_sources VALUES ($1, $2)', [releaseId, versionId])

        for (const chunk of preparation.chunks) {
          const locator = [chunk.page === null ? null : `Page ${chunk.page}`, chunk.heading].filter(Boolean).join(' / ')
            || `Passage ${chunk.ordinal + 1}`
          const inputHash = hash(embeddingInput(source.title, source.language, chunk.heading, chunk.text))
          const chunkId = await insertId(client, `
            INSERT INTO relief.chunks AS stored
              (source_version_id, chunker_version, ordinal, text, text_hash, locator, embedding_input_hash)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (source_version_id, chunker_version, ordinal)
            DO UPDATE SET ordinal = EXCLUDED.ordinal
            WHERE (stored.text_hash, stored.locator, stored.embedding_input_hash)
              IS NOT DISTINCT FROM (EXCLUDED.text_hash, EXCLUDED.locator, EXCLUDED.embedding_input_hash)
            RETURNING id`, [
            versionId, preparation.preprocessingVersion, chunk.ordinal, chunk.text, chunk.textHash, locator, inputHash,
          ])
          await client.query(`
            INSERT INTO relief.chunk_embeddings (chunk_id, profile_id, embedding)
            VALUES ($1, $2, $3::extensions.vector) ON CONFLICT (chunk_id, profile_id) DO NOTHING`,
          [chunkId, profileId, vectors.get(inputHash)])
          await client.query('INSERT INTO relief.release_chunks VALUES ($1, $2, $3, $4)',
            [releaseId, chunkId, versionId, disaster.id])
        }
      }
      await client.query("UPDATE relief.releases SET status = 'ready' WHERE id = $1", [releaseId])
      await client.query('SELECT relief.publish_corpus($1, $2, $3)', [releaseId, bundle.expectedEpoch, bundle.actor])
      await client.query('COMMIT')
      console.log(`Published release ${releaseId}.`)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

function embeddingInput(title: string, language: string | null, heading: string | null, text: string) {
  return [title, heading ?? '', language ?? '', text].join('\n')
}

async function insertId(client: pg.PoolClient, sql: string, values: unknown[]) {
  const { rows: [row] } = await client.query<{ id: string }>(sql, values)
  if (!row) throw new Error('Published record conflicts with an existing version')
  return row.id
}

const [path, ...extra] = process.argv.slice(2)
if (!path || extra.length) {
  console.error('Usage: npm run dataset:publish -- <approved-release.json>')
  process.exitCode = 1
} else {
  publish(path).catch((error: unknown) => {
    const code = typeof error === 'object' && error && 'code' in error ? error.code : null
    // Do not log raw database/provider errors, which can contain source text or secrets.
    console.error('Publication failed. Check approved metadata, Gemini quota, migration and release epoch.',
      typeof code === 'string' && /^[A-Z0-9_]{3,30}$/.test(code) ? code : '')
    process.exitCode = 1
  })
}
