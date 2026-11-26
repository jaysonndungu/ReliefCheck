import type pg from 'pg'
import type { AdminLogEntry } from '@reliefcheck/contracts'
import type { RequestLogsRepository } from '../services/observability/requestLogs.js'

type Queryable = Pick<pg.Pool, 'query'>

const SAFE_COLUMNS = `request_id AS "requestId", occurred_at AS "occurredAt", endpoint, method,
  status_code AS "statusCode", error_code AS "errorCode", latency_ms AS "latencyMs",
  stage_timings AS "stageTimings", mode, outcome, retrieval_mode AS "retrievalMode",
  disaster_id AS "disasterId", release_id AS "releaseId", epoch, provider_usage AS "providerUsage"`

export function createPgRequestLogs(pool: Queryable): RequestLogsRepository {
  return {
    async list({ filter, limit, cursor }) {
      const values: unknown[] = [filter.from, filter.to]
      const predicates = ['occurred_at >= $1', 'occurred_at < $2']
      const add = (value: unknown, sql: string) => { values.push(value); predicates.push(sql.replace('?', `$${values.length}`)) }
      if (filter.endpoint) add(filter.endpoint, 'endpoint = ?')
      if (filter.method) add(filter.method, 'method = ?')
      if (filter.statusCode !== undefined) add(filter.statusCode, 'status_code = ?')
      if (filter.mode) add(filter.mode, 'mode = ?')
      if (filter.outcome) add(filter.outcome, 'outcome = ?')
      if (filter.retrievalMode) add(filter.retrievalMode, 'retrieval_mode = ?')
      if (cursor) {
        values.push(cursor.occurredAt, cursor.requestId)
        predicates.push(`(occurred_at, request_id) < ($${values.length - 1}, $${values.length})`)
      }
      values.push(limit + 1)
      const { rows } = await pool.query<AdminLogEntry>(
        `SELECT ${SAFE_COLUMNS} FROM relief.request_events
         WHERE ${predicates.join(' AND ')}
         ORDER BY occurred_at DESC, request_id DESC
         LIMIT $${values.length}`,
        values,
      )
      return { entries: rows.slice(0, limit), hasMore: rows.length > limit }
    },
    async deleteBefore(cutoff, limit) {
      const { rowCount } = await pool.query(
        `WITH doomed AS (
           SELECT request_id FROM relief.request_events
           WHERE occurred_at < $1
           ORDER BY occurred_at ASC, request_id ASC
           LIMIT $2
         )
         DELETE FROM relief.request_events e USING doomed d WHERE e.request_id = d.request_id`,
        [cutoff, limit],
      )
      return rowCount ?? 0
    },
  }
}

export const REQUEST_LOGS_RETENTION_DAYS = 14
