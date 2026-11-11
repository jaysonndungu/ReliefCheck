import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'
import { loadConfig } from './config/env.js'
import { createPool } from './db/pool.js'
import { createPublishedCorpus } from './db/publishedCorpus.js'
import { createPgReadinessProbe } from './routes/health.js'
import { createJwtVerifier, createPgStaffRoleRepository } from './middleware/staffAuth.js'
import { createGeminiClient } from './adapters/gemini/geminiClient.js'

const config = loadConfig()
const pool = config.database ? createPool(config.database) : null
const gemini = config.gemini ? createGeminiClient(config.gemini) : null
const corpus = pool ? createPublishedCorpus(pool) : null

const app = createApp({
  readiness: pool ? createPgReadinessProbe(pool) : null,
  staffAuth:
    pool && config.staffAuth
      ? { verifyToken: createJwtVerifier(config.staffAuth), roles: createPgStaffRoleRepository(pool) }
      : null,
  sourceEvidence: corpus?.sourceEvidence ?? null,
  listDisasters: corpus?.listDisasters ?? null,
  appealRegistry: null,
  chat: corpus ? {
    retrieval: corpus.retrieval,
    embedder: gemini?.embedder ?? null,
    generator: gemini?.generator ?? null,
  } : null,
  webDist: fileURLToPath(new URL('../../web/dist/', import.meta.url)),
})

if (!config.database) console.log('DATABASE_URL not set: readiness will report DATABASE_UNCONFIGURED.')
if (!config.gemini) console.log('GEMINI_API_KEY not set: chat will return excerpts only, with no generated answers.')
if (!config.staffAuth) console.log('Supabase Auth not configured: staff routes return 503 AUTH_UNCONFIGURED.')

const server = app.listen(config.port, () => {
  console.log(`ReliefCheck API listening on port ${config.port}`)
})

function shutdown() {
  server.close(() => {
    if (!pool) process.exit(0)
    void pool.end().finally(() => process.exit(0))
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
