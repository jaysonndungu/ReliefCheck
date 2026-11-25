import {
  ADMIN_METRICS_PATH, API_PREFIX, adminMetricsResponseSchema, type AdminMetricsResponse,
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
