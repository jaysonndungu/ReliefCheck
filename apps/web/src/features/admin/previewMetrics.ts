import type { AdminMetricsResponse } from '@reliefcheck/contracts'

/**
 * DEV-ONLY synthetic metrics for previewing the US10 dashboard layout before real telemetry exists.
 * Imported only behind `import.meta.env.DEV`, so it is not part of the production bundle.
 * Every figure here is invented. It is not real traffic and must never be shown as such.
 */
export const PREVIEW_DISASTERS: Record<string, string> = {
  'aaaaaaaa-0000-4000-8000-000000000001': 'Synthetic event A',
  'aaaaaaaa-0000-4000-8000-000000000002': 'Synthetic event B',
}

export function previewMetrics(window: { from: Date; to: Date }, now: Date): AdminMetricsResponse {
  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    generatedAt: now.toISOString(),
    totals: { requests: 148, succeeded: 121, clientErrors: 17, quotaBlocked: 3, infrastructureFailures: 7, degraded: 22 },
    outcomes: [
      { outcome: 'supported', count: 58 },
      { outcome: 'extractive_fallback', count: 19 },
      { outcome: 'insufficient_evidence', count: 14 },
      { outcome: 'partial', count: 9 },
      { outcome: 'documented_official_channel', count: 6 },
      { outcome: 'published_warning_found', count: 4 },
    ],
    latency: { sampleCount: 148, p50Ms: 640, p95Ms: 6_850 },
    endpoints: [
      { endpoint: '/chat', method: 'POST', requests: 104, failures: 21, sampleCount: 104, p50Ms: 1_420, p95Ms: 8_200 },
      { endpoint: '/disasters', method: 'GET', requests: 22, failures: 0, sampleCount: 22, p50Ms: 38, p95Ms: 96 },
      { endpoint: '/appeals/review', method: 'POST', requests: 14, failures: 4, sampleCount: 14, p50Ms: 85, p95Ms: 240 },
      { endpoint: '/sources/:sourceVersionId', method: 'GET', requests: 8, failures: 2, sampleCount: 8, p50Ms: 52, p95Ms: 130 },
    ],
    stages: [
      { stage: 'embed', sampleCount: 81, p50Ms: 310, p95Ms: 1_150 },
      { stage: 'generate', sampleCount: 67, p50Ms: 2_300, p95Ms: 6_400 },
      { stage: 'recheck', sampleCount: 100, p50Ms: 12, p95Ms: 35 },
      { stage: 'retrieve', sampleCount: 100, p50Ms: 95, p95Ms: 260 },
      { stage: 'snapshot', sampleCount: 100, p50Ms: 14, p95Ms: 40 },
    ],
    byMode: [{ mode: 'factual', count: 100 }],
    byRetrievalMode: [
      { retrievalMode: 'hybrid', count: 78 },
      { retrievalMode: 'lexical_only', count: 22 },
      { retrievalMode: 'registry', count: 14 },
    ],
    byDisaster: [
      { disasterId: 'aaaaaaaa-0000-4000-8000-000000000001', count: 71 },
      { disasterId: 'aaaaaaaa-0000-4000-8000-000000000002', count: 47 },
    ],
    telemetry: { processStartedAt: new Date(now.getTime() - 5 * 3_600_000).toISOString(), droppedEvents: 2 },
  }
}
