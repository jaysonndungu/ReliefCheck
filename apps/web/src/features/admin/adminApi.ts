import {
  ADMIN_LOGS_PATH, ADMIN_METRICS_PATH, API_PREFIX, adminLogsResponseSchema, adminMetricsResponseSchema,
  type AdminLogsResponse, type AdminMetricsResponse,
} from '@reliefcheck/contracts'
import { ApiError, handleResponse } from '../../lib/api'

/** US10: admin-only metrics. The staff token lives in memory only (ai.md §9). */
export async function fetchAdminMetrics(
  token: string,
  window: { from: Date; to: Date },
  signal?: AbortSignal,
): Promise<AdminMetricsResponse> {
  const params = new URLSearchParams({ from: window.from.toISOString(), to: window.to.toISOString() })
  const response = await fetch(`${API_PREFIX}${ADMIN_METRICS_PATH}?${params}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    signal,
  })
  const parsed = adminMetricsResponseSchema.safeParse(await handleResponse(response))
  if (!parsed.success) throw new ApiError('INVALID_RESPONSE', 'The service returned invalid metrics.', true)
  return parsed.data
}

export async function fetchAdminLogs(
  token: string,
  query: { from: Date; to: Date; limit?: number; cursor?: string; endpoint?: string; statusCode?: number },
  signal?: AbortSignal,
): Promise<AdminLogsResponse> {
  const params = new URLSearchParams({ from: query.from.toISOString(), to: query.to.toISOString() })
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.cursor) params.set('cursor', query.cursor)
  if (query.endpoint) params.set('endpoint', query.endpoint)
  if (query.statusCode !== undefined) params.set('statusCode', String(query.statusCode))
  const response = await fetch(`${API_PREFIX}${ADMIN_LOGS_PATH}?${params}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, signal,
  })
  const parsed = adminLogsResponseSchema.safeParse(await handleResponse(response))
  if (!parsed.success) throw new ApiError('INVALID_RESPONSE', 'The service returned invalid usage logs.', true)
  return parsed.data
}
