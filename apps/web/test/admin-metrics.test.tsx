import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { adminMetricsResponseSchema, type AdminMetricsResponse } from '@reliefcheck/contracts'
import { MetricsDashboard, formatMs } from '../src/features/admin/MetricsDashboard'
import { previewMetrics } from '../src/features/admin/previewMetrics'
import { AdminPerformancePage } from '../src/pages/AdminPerformancePage'

// Clearly synthetic fixture.
const DISASTER = '11111111-1111-4111-8111-111111111111'
function metrics(overrides: Partial<AdminMetricsResponse> = {}): AdminMetricsResponse {
  return adminMetricsResponseSchema.parse({
    window: { from: '2026-11-24T12:00:00.000Z', to: '2026-11-25T12:00:00.000Z' },
    generatedAt: '2026-11-25T12:00:00.000Z',
    totals: { requests: 10, succeeded: 6, clientErrors: 2, quotaBlocked: 0, infrastructureFailures: 2, degraded: 1 },
    outcomes: [{ outcome: 'supported', count: 4 }],
    latency: { sampleCount: 10, p50Ms: 250, p95Ms: 4_200 },
    endpoints: [{ endpoint: '/chat', method: 'POST', requests: 10, failures: 4, sampleCount: 10, p50Ms: 250, p95Ms: 4_200 }],
    stages: [{ stage: 'retrieve', sampleCount: 6, p50Ms: 40, p95Ms: 90 }],
    byMode: [{ mode: 'factual', count: 6 }],
    byRetrievalMode: [{ retrievalMode: 'hybrid', count: 6 }],
    byDisaster: [{ disasterId: DISASTER, count: 6 }],
    telemetry: { processStartedAt: '2026-11-25T00:00:00.000Z', droppedEvents: 0 },
    ...overrides,
  })
}

afterEach(cleanup)

describe('US10 metrics dashboard', () => {
  it('shows real failure counts with their denominator', () => {
    render(<MetricsDashboard metrics={metrics()} disasterNames={{ [DISASTER]: 'Synthetic event' }} />)
    const failures = screen.getByText('Infrastructure failures').closest('.stat-tile') as HTMLElement
    expect(within(failures).getByText('2')).toBeTruthy()
    expect(within(failures).getByText(/20% of 10 requests/)).toBeTruthy()
    // Attention state is announced in text, not color alone.
    expect(within(failures).getByText(/Needs attention/)).toBeTruthy()
    expect(screen.getByText('Synthetic event')).toBeTruthy()
  })

  it('warns that p95 is unreliable when the sample is small', () => {
    render(<MetricsDashboard metrics={metrics()} disasterNames={{}} />)
    expect(screen.getByText(/n = 10: too few samples for a reliable p95/)).toBeTruthy()
    expect(screen.getAllByText(/few samples/).length).toBeGreaterThan(1)
  })

  it('reports telemetry gaps', () => {
    render(<MetricsDashboard metrics={metrics({ telemetry: { processStartedAt: '2026-11-25T00:00:00.000Z', droppedEvents: 3 } })} disasterNames={{}} />)
    expect(screen.getByText(/3 requests were not recorded/)).toBeTruthy()
  })

  it('renders an explicit empty state instead of zero-filled percentiles', () => {
    render(<MetricsDashboard disasterNames={{}} metrics={metrics({
      totals: { requests: 0, succeeded: 0, clientErrors: 0, quotaBlocked: 0, infrastructureFailures: 0, degraded: 0 },
      outcomes: [], latency: { sampleCount: 0, p50Ms: null, p95Ms: null }, endpoints: [], stages: [],
      byMode: [], byRetrievalMode: [], byDisaster: [],
    })} />)
    expect(screen.getByText('No requests were recorded in this window.')).toBeTruthy()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('formats durations', () => {
    expect(formatMs(null)).toBe('—')
    expect(formatMs(42.4)).toBe('42 ms')
    expect(formatMs(1_250)).toBe('1.3 s')
    expect(formatMs(12_400)).toBe('12 s')
  })
})

describe('US10 performance page', () => {
  it('does not show any numbers without an admin session or preview', () => {
    render(<MemoryRouter initialEntries={['/admin/performance']}><AdminPerformancePage /></MemoryRouter>)
    expect(screen.getByText(/Staff sign-in required/)).toBeTruthy()
    expect(screen.queryByText('Total requests')).toBeNull()
  })

  it('labels the dev-only preview as synthetic', async () => {
    render(<MemoryRouter initialEntries={['/admin/performance?preview=1']}><AdminPerformancePage /></MemoryRouter>)
    expect(screen.getByText(/Synthetic preview data, not real traffic/)).toBeTruthy()
    expect(await screen.findByText('Total requests')).toBeTruthy()
  })

  it('keeps the preview fixture contract-valid', () => {
    const now = new Date('2026-11-25T12:00:00Z')
    expect(() => adminMetricsResponseSchema.parse(previewMetrics({ from: new Date('2026-11-24T12:00:00Z'), to: now }, now))).not.toThrow()
  })
})
