import type pg from 'pg'
import type { RequestMetricsRepository } from '../services/observability/requestMetrics.js'

type Queryable = Pick<pg.Pool, 'query'>

const latency = (column: string) => `
  count(*)::int AS "sampleCount",
  round((percentile_cont(0.5) WITHIN GROUP (ORDER BY ${column}))::numeric, 1)::float8 AS "p50Ms",
  round((percentile_cont(0.95) WITHIN GROUP (ORDER BY ${column}))::numeric, 1)::float8 AS "p95Ms"`

/**
 * US10: aggregates relief.request_events for one bounded window in a single statement so every
 * section of the dashboard describes the same rows. Window is half-open: [from, to).
 */
const METRICS_SQL = `
WITH w AS (
  SELECT * FROM relief.request_events WHERE occurred_at >= $1 AND occurred_at < $2
)
SELECT
  (SELECT json_build_object(
     'requests', count(*)::int,
     'succeeded', (count(*) FILTER (WHERE status_code BETWEEN 200 AND 299))::int,
     'clientErrors', (count(*) FILTER (WHERE status_code BETWEEN 400 AND 499 AND status_code <> 429))::int,
     'quotaBlocked', (count(*) FILTER (WHERE status_code = 429))::int,
     'infrastructureFailures', (count(*) FILTER (WHERE status_code >= 500))::int,
     'degraded', (count(*) FILTER (WHERE status_code BETWEEN 200 AND 299
                    AND (outcome = 'extractive_fallback' OR retrieval_mode = 'lexical_only')))::int)
   FROM w) AS totals,
  (SELECT row_to_json(l) FROM (SELECT ${latency('latency_ms')} FROM w) l) AS latency,
  (SELECT coalesce(json_agg(e ORDER BY e.requests DESC, e.endpoint, e.method), '[]'::json) FROM (
     SELECT endpoint, method, count(*)::int AS requests,
            (count(*) FILTER (WHERE status_code >= 400))::int AS failures, ${latency('latency_ms')}
     FROM w GROUP BY endpoint, method ORDER BY count(*) DESC, endpoint, method LIMIT 100) e) AS endpoints,
  (SELECT coalesce(json_agg(s ORDER BY s.stage), '[]'::json) FROM (
     SELECT t.key AS stage, ${latency('t.value::float8')}
     FROM w CROSS JOIN LATERAL jsonb_each_text(w.stage_timings) AS t(key, value)
     WHERE w.stage_timings IS NOT NULL AND t.value ~ '^[0-9]+(\\.[0-9]+)?$'
     GROUP BY t.key ORDER BY t.key LIMIT 20) s) AS stages,
  (SELECT coalesce(json_agg(o ORDER BY o.count DESC, o.outcome), '[]'::json) FROM (
     SELECT outcome, count(*)::int AS count FROM w WHERE outcome IS NOT NULL GROUP BY outcome) o) AS outcomes,
  (SELECT coalesce(json_agg(m ORDER BY m.count DESC, m.mode), '[]'::json) FROM (
     SELECT mode, count(*)::int AS count FROM w WHERE mode IS NOT NULL GROUP BY mode) m) AS "byMode",
  (SELECT coalesce(json_agg(r ORDER BY r.count DESC, r."retrievalMode"), '[]'::json) FROM (
     SELECT retrieval_mode AS "retrievalMode", count(*)::int AS count
     FROM w WHERE retrieval_mode IS NOT NULL GROUP BY retrieval_mode) r) AS "byRetrievalMode",
  (SELECT coalesce(json_agg(d ORDER BY d.count DESC, d."disasterId"), '[]'::json) FROM (
     SELECT disaster_id AS "disasterId", count(*)::int AS count
     FROM w WHERE disaster_id IS NOT NULL GROUP BY disaster_id ORDER BY count(*) DESC LIMIT 100) d) AS "byDisaster"
`

export function createPgRequestMetrics(pool: Queryable): RequestMetricsRepository {
  return {
    async summarize({ from, to }) {
      const { rows: [row] } = await pool.query(METRICS_SQL, [from, to])
      return row
    },
  }
}

/** Exported for the SQL verification script; not part of the runtime API. */
export const REQUEST_METRICS_SQL = METRICS_SQL
