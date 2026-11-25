import {
  METRICS_MAX_WINDOW_HOURS, adminMetricsResponseSchema,
  type AdminMetricsQuery, type AdminMetricsResponse,
} from '@reliefcheck/contracts'

/** Aggregated sections for one window, before the service adds window and telemetry metadata. */
export type MetricsAggregate = Omit<AdminMetricsResponse, 'window' | 'generatedAt' | 'telemetry'>

export type RequestMetricsRepository = {
  summarize(window: { from: Date; to: Date }): Promise<unknown>
}

export type TelemetryStatus = { processStartedAt: Date; droppedEvents: number }

const HOUR_MS = 3_600_000
export const DEFAULT_WINDOW_HOURS = 24

export type ResolvedWindow = { ok: true; from: Date; to: Date } | { ok: false; message: string }

/**
 * Defaults to the last 24 hours. A lone `from` runs to now; a lone `to` looks back 24 hours.
 * Every resolved window is checked against the 14-day cap, not only fully specified ones.
 */
export function resolveWindow(query: AdminMetricsQuery, now: Date): ResolvedWindow {
  const to = query.to ? new Date(query.to) : now
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - DEFAULT_WINDOW_HOURS * HOUR_MS)
  if (from.getTime() >= to.getTime()) return { ok: false, message: 'The window start must be before its end.' }
  if (to.getTime() - from.getTime() > METRICS_MAX_WINDOW_HOURS * HOUR_MS) {
    return { ok: false, message: `The window can be at most ${METRICS_MAX_WINDOW_HOURS / 24} days.` }
  }
  return { ok: true, from, to }
}

/** Runs the aggregation and validates the full response against the shared contract. */
export async function buildMetricsResponse(
  repository: RequestMetricsRepository,
  window: { from: Date; to: Date },
  telemetry: TelemetryStatus,
  now: Date,
): Promise<AdminMetricsResponse> {
  const aggregate = await repository.summarize(window)
  return adminMetricsResponseSchema.parse({
    ...(aggregate as object),
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    generatedAt: now.toISOString(),
    telemetry: {
      processStartedAt: telemetry.processStartedAt.toISOString(),
      droppedEvents: telemetry.droppedEvents,
    },
  })
}
