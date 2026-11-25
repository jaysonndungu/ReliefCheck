import { Router } from 'express'
import {
  ADMIN_ME_PATH, ADMIN_METRICS_PATH, adminMeSchema, adminMetricsQuerySchema, type StaffRole,
} from '@reliefcheck/contracts'
import { requireStaff, type StaffAuthDeps, type StaffIdentity } from '../middleware/staffAuth.js'
import { sendError } from '../http/errors.js'
import {
  buildMetricsResponse, resolveWindow,
  type RequestMetricsRepository, type TelemetryStatus,
} from '../services/observability/requestMetrics.js'

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

export function adminRouter(staffAuth: StaffAuthDeps | null, metrics: AdminMetricsDeps | null = null): Router {
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

  return router
}
