import type pg from 'pg'
import type { RequestEventSink } from '../services/observability/requestTelemetry.js'

type Queryable = Pick<pg.Pool, 'query'>

/** US10: parameterized insert into relief.request_events (db/migrations/0003_request_events.sql). */
export function createPgRequestEventSink(pool: Queryable): RequestEventSink {
  return {
    async insert(event) {
      await pool.query(`
        INSERT INTO relief.request_events (
          request_id, occurred_at, endpoint, method, status_code, error_code, latency_ms,
          stage_timings, mode, outcome, retrieval_mode, disaster_id, release_id, epoch, provider_usage
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15::jsonb)
        ON CONFLICT (request_id) DO NOTHING`, [
        event.requestId, event.occurredAt, event.endpoint, event.method, event.statusCode, event.errorCode,
        event.latencyMs, event.stageTimings ? JSON.stringify(event.stageTimings) : null,
        event.mode, event.outcome, event.retrievalMode, event.disasterId, event.releaseId, event.epoch,
        event.providerUsage ? JSON.stringify(event.providerUsage) : null,
      ])
    },
  }
}
