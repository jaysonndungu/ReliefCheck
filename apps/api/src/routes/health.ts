import { Router } from 'express'
import type pg from 'pg'
import {
  LIVENESS_PATH,
  READINESS_PATH,
  livenessSchema,
  readinessSchema,
  type ReadinessErrorCode,
} from '@reliefcheck/contracts'
import { sendError } from '../http/errors.js'

export type ReadinessResult = 'ok' | 'database_unavailable' | 'corpus_unavailable'

export interface ReadinessProbe {
  check(): Promise<ReadinessResult>
}

/**
 * Minimal DB + active-corpus readiness (ai.md §9): no secrets, no model calls.
 * Until the US05/US11 `kb_state` table exists the corpus is reported unavailable.
 */
export function createPgReadinessProbe(pool: pg.Pool): ReadinessProbe {
  return {
    async check() {
      let hasKbState: boolean
      try {
        const result = await pool.query<{ has_kb_state: boolean }>(
          "SELECT to_regclass('relief.kb_state') IS NOT NULL AS has_kb_state",
        )
        hasKbState = result.rows[0]?.has_kb_state === true
      } catch {
        return 'database_unavailable'
      }
      if (!hasKbState) return 'corpus_unavailable'
      try {
        const active = await pool.query(
          'SELECT 1 FROM relief.kb_state WHERE active_release_id IS NOT NULL LIMIT 1',
        )
        return active.rowCount === 1 ? 'ok' : 'corpus_unavailable'
      } catch {
        return 'database_unavailable'
      }
    },
  }
}

const READINESS_FAILURES: Record<
  Exclude<ReadinessResult, 'ok'> | 'unconfigured',
  { code: ReadinessErrorCode; message: string; retryable: boolean }
> = {
  unconfigured: {
    code: 'DATABASE_UNCONFIGURED',
    message: 'The database is not configured on this server.',
    retryable: false,
  },
  database_unavailable: {
    code: 'DATABASE_UNAVAILABLE',
    message: 'The database is temporarily unavailable. Try again shortly.',
    retryable: true,
  },
  corpus_unavailable: {
    code: 'CORPUS_UNAVAILABLE',
    message: 'No reviewed knowledge base is published yet.',
    retryable: false,
  },
}

export function healthRouter(readiness: ReadinessProbe | null): Router {
  const router = Router()

  router.get(LIVENESS_PATH, (_request, response) => {
    response.json(livenessSchema.parse({ status: 'ok' }))
  })

  router.get(READINESS_PATH, async (_request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const result: ReadinessResult | 'unconfigured' = readiness
      ? await readiness.check().catch((): ReadinessResult => 'database_unavailable')
      : 'unconfigured'
    if (result === 'ok') {
      response.json(readinessSchema.parse({ status: 'ready', checks: { database: 'ok', corpus: 'ok' } }))
      return
    }
    const failure = READINESS_FAILURES[result]
    sendError(response, 503, failure.code, failure.message, failure.retryable)
  })

  return router
}
