import { Router } from 'express'
import {
  ADMIN_ME_PATH, ADMIN_METRICS_PATH, ADMIN_LOGS_PATH, adminMeSchema, adminMetricsQuerySchema,
  adminLogsQuerySchema, type StaffRole,
} from '@reliefcheck/contracts'
import { requireStaff, type StaffAuthDeps, type StaffIdentity } from '../middleware/staffAuth.js'
import { sendError } from '../http/errors.js'
import {
  buildMetricsResponse, resolveWindow,
  type RequestMetricsRepository, type TelemetryStatus,
} from '../services/observability/requestMetrics.js'
import { buildLogsResponse, decodeLogCursor, type RequestLogsRepository } from '../services/observability/requestLogs.js'

/** Capability names mirror the role column of the ai.md §9 route table. */
const CAPABILITIES: Record<StaffRole, string[]> = {
  developer: ['ingest', 'review', 'build_release'],
  admin: ['ingest', 'review', 'build_release', 'publish', 'kb_recovery', 'metrics', 'logs'],
}

export type AdminMetricsDeps = {
  /** null when no database is configured. */
  repository: RequestMetricsRepository | null
  telemetryStatus: () => TelemetryStatus
  now?: () => Date
}

export type AdminLogsDeps = {
  repository: RequestLogsRepository | null
  now?: () => Date
}

export function adminRouter(
  staffAuth: StaffAuthDeps | null,
  metrics: AdminMetricsDeps | null = null,
  logs: AdminLogsDeps | null = null,
): Router {
  const router = Router()

  // US01 protected test endpoint: proves JWT verification + role lookup end to end.
  router.get(ADMIN_ME_PATH, requireStaff(staffAuth), (_request, response) => {
    const staff = response.locals.staff as StaffIdentity
    response.json(
      adminMeSchema.parse({ userId: staff.userId, role: staff.role, capabilities: CAPABILITIES[staff.role] }),
    )
  })

  // US10 monitoring. Admin only (ai.md §9); developers receive 403.
  router.get(ADMIN_METRICS_PATH, requireStaff(staffAuth, ['admin']), async (request, response) => {
    const query = adminMetricsQuerySchema.safeParse({
      from: typeof request.query.from === 'string' ? request.query.from : undefined,
      to: typeof request.query.to === 'string' ? request.query.to : undefined,
    })
    if (!query.success) {
      sendError(response, 400, 'INVALID_METRICS_WINDOW',
        'Use ISO 8601 timestamps with `from` before `to`, at most 14 days apart.', false)
      return
    }
    const now = metrics?.now?.() ?? new Date()
    const window = resolveWindow(query.data, now)
    if (!window.ok) {
      sendError(response, 400, 'INVALID_METRICS_WINDOW', window.message, false)
      return
    }
    if (!metrics?.repository) {
      sendError(response, 503, 'METRICS_UNAVAILABLE', 'Request metrics need a configured database.', false)
      return
    }
    try {
      response.json(await buildMetricsResponse(metrics.repository, window, metrics.telemetryStatus(), now))
    } catch {
      sendError(response, 503, 'METRICS_UNAVAILABLE', 'Request metrics are temporarily unavailable.', true)
    }
  })

  router.get(ADMIN_LOGS_PATH, requireStaff(staffAuth, ['admin']), async (request, response) => {
    const query = adminLogsQuerySchema.safeParse({
      from: typeof request.query.from === 'string' ? request.query.from : undefined,
      to: typeof request.query.to === 'string' ? request.query.to : undefined,
      endpoint: typeof request.query.endpoint === 'string' ? request.query.endpoint : undefined,
      method: typeof request.query.method === 'string' ? request.query.method : undefined,
      statusCode: typeof request.query.statusCode === 'string' ? request.query.statusCode : undefined,
      mode: typeof request.query.mode === 'string' ? request.query.mode : undefined,
      outcome: typeof request.query.outcome === 'string' ? request.query.outcome : undefined,
      retrievalMode: typeof request.query.retrievalMode === 'string' ? request.query.retrievalMode : undefined,
      limit: typeof request.query.limit === 'string' ? request.query.limit : undefined,
      cursor: typeof request.query.cursor === 'string' ? request.query.cursor : undefined,
    })
    if (!query.success) {
      sendError(response, 400, 'INVALID_LOG_QUERY', 'The usage-log filters or time window are invalid.', false)
      return
    }
    const now = logs?.now?.() ?? new Date()
    const window = resolveWindow(query.data, now)
    if (!window.ok) {
      sendError(response, 400, 'INVALID_LOG_QUERY', window.message, false)
      return
    }
    const { from, to } = window
    const cursor = query.data.cursor ? decodeLogCursor(query.data.cursor) : null
    if (query.data.cursor && !cursor) {
      sendError(response, 400, 'INVALID_LOG_CURSOR', 'The usage-log cursor is invalid or expired.', false)
      return
    }
    if (!logs?.repository) {
      sendError(response, 503, 'LOGS_UNAVAILABLE', 'Usage logs need a configured database.', false)
      return
    }
    try {
      response.setHeader('Cache-Control', 'no-store')
      const result = await logs.repository.list({
        filter: {
          from, to, endpoint: query.data.endpoint, method: query.data.method,
          statusCode: query.data.statusCode, mode: query.data.mode, outcome: query.data.outcome,
          retrievalMode: query.data.retrievalMode,
        },
        limit: query.data.limit,
        cursor,
      })
      response.json(buildLogsResponse(result, { from, to }, query.data, now))
    } catch {
      sendError(response, 503, 'LOGS_UNAVAILABLE', 'Usage logs are temporarily unavailable.', true)
    }
  })

  return router
}
