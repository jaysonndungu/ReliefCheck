import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { adminMetricsResponseSchema, errorEnvelopeSchema, type StaffRole } from '@reliefcheck/contracts'
import { resolveWindow, type MetricsAggregate } from '../src/services/observability/requestMetrics.js'
import type { StaffAuthDeps } from '../src/middleware/staffAuth.js'
import { startServer, type TestServer } from './helpers.js'

// Clearly synthetic identities and figures.
const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEVELOPER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const VALENCIA = '11111111-1111-4111-8111-111111111111'
const TOKENS: Record<string, string> = { 'admin.token.sig': ADMIN, 'developer.token.sig': DEVELOPER }
const ROLES: Record<string, StaffRole> = { [ADMIN]: 'admin', [DEVELOPER]: 'developer' }

const staffAuth: StaffAuthDeps = {
  verifyToken: async (token) => {
    const userId = TOKENS[token]
    if (!userId) throw new Error('invalid')
    return userId
  },
  roles: { findEnabledRole: async (userId) => ROLES[userId] ?? null },
}

const aggregate: MetricsAggregate = {
  totals: { requests: 5, succeeded: 3, clientErrors: 1, quotaBlocked: 0, infrastructureFailures: 1, degraded: 2 },
  outcomes: [{ outcome: 'extractive_fallback', count: 2 }, { outcome: 'supported', count: 1 }],
  latency: { sampleCount: 5, p50Ms: 120.5, p95Ms: 900 },
  endpoints: [{ endpoint: '/chat', method: 'POST', requests: 5, failures: 2, sampleCount: 5, p50Ms: 120.5, p95Ms: 900 }],
  stages: [{ stage: 'retrieve', sampleCount: 3, p50Ms: 40, p95Ms: 80 }],
  byMode: [{ mode: 'factual', count: 3 }],
  byRetrievalMode: [{ retrievalMode: 'lexical_only', count: 2 }, { retrievalMode: 'hybrid', count: 1 }],
  byDisaster: [{ disasterId: VALENCIA, count: 4 }],
}

const NOW = new Date('2026-11-25T12:00:00.000Z')
const windows: Array<{ from: Date; to: Date }> = []
let failRepository = false

let server: TestServer
before(async () => {
  server = await startServer({
    staffAuth,
    requestMetrics: {
      summarize: async (window) => {
        windows.push(window)
        if (failRepository) throw new Error('relation "relief.request_events" does not exist')
        return aggregate
      },
    },
  })
})
after(() => server.close())

async function getMetrics(query = '', token?: string) {
  const response = await fetch(`${server.url}/api/v1/admin/metrics${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  return { response, body: (await response.json()) as unknown }
}

async function expectError(query: string, token: string | undefined, status: number, code: string) {
  const { response, body } = await getMetrics(query, token)
  assert.equal(response.status, status)
  assert.equal(errorEnvelopeSchema.parse(body).error.code, code)
  return body
}

describe('US10 GET /admin/metrics', () => {
  it('rejects anonymous requests with 401', async () => {
    await expectError('', undefined, 401, 'UNAUTHENTICATED')
  })

  it('rejects developers with 403: metrics are admin only', async () => {
    await expectError('', 'developer.token.sig', 403, 'FORBIDDEN')
  })

  it('returns a contract-valid response for the default 24-hour window', async () => {
    windows.length = 0
    const { response, body } = await getMetrics('', 'admin.token.sig')
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const metrics = adminMetricsResponseSchema.parse(body)
    assert.equal(metrics.totals.requests, 5)
    assert.equal(metrics.latency.sampleCount, 5)
    assert.equal(metrics.telemetry.droppedEvents, 0)
    assert.equal(windows.length, 1)
    assert.equal(windows[0].to.getTime() - windows[0].from.getTime(), 24 * 3_600_000)
  })

  it('passes an explicit window through to the repository', async () => {
    windows.length = 0
    const from = '2026-11-20T00:00:00.000Z'
    const to = '2026-11-21T00:00:00.000Z'
    const { response } = await getMetrics(`?from=${from}&to=${to}`, 'admin.token.sig')
    assert.equal(response.status, 200)
    assert.deepEqual(windows.map((w) => [w.from.toISOString(), w.to.toISOString()]), [[from, to]])
  })

  for (const [name, query] of [
    ['malformed timestamps', '?from=yesterday'],
    ['reversed windows', '?from=2026-11-21T00:00:00Z&to=2026-11-20T00:00:00Z'],
    ['windows longer than 14 days', '?from=2026-10-01T00:00:00Z&to=2026-11-20T00:00:00Z'],
  ] as const) {
    it(`rejects ${name} with 400`, async () => {
      await expectError(query, 'admin.token.sig', 400, 'INVALID_METRICS_WINDOW')
    })
  }

  it('returns a retryable 503 without database details when aggregation fails', async () => {
    failRepository = true
    try {
      const body = await expectError('', 'admin.token.sig', 503, 'METRICS_UNAVAILABLE')
      assert.doesNotMatch(JSON.stringify(body), /relation|request_events/)
    } finally {
      failRepository = false
    }
  })

  it('returns 503 when no database is configured', async () => {
    const bare = await startServer({ staffAuth })
    try {
      const response = await fetch(`${bare.url}/api/v1/admin/metrics`, { headers: { authorization: 'Bearer admin.token.sig' } })
      assert.equal(response.status, 503)
      assert.equal(errorEnvelopeSchema.parse(await response.json()).error.code, 'METRICS_UNAVAILABLE')
    } finally {
      await bare.close()
    }
  })

  it('rejects a repository result that breaks the contract instead of passing it on', async () => {
    const broken = await startServer({ staffAuth, requestMetrics: { summarize: async () => ({ totals: { requests: -1 } }) } })
    try {
      const response = await fetch(`${broken.url}/api/v1/admin/metrics`, { headers: { authorization: 'Bearer admin.token.sig' } })
      assert.equal(response.status, 503)
    } finally {
      await broken.close()
    }
  })
})

describe('US10 metrics window resolution', () => {
  it('applies the 14-day cap to one-sided windows too', () => {
    const result = resolveWindow({ from: '2026-10-01T00:00:00Z' }, NOW)
    assert.equal(result.ok, false)
  })

  it('looks back 24 hours from a lone `to`', () => {
    const result = resolveWindow({ to: '2026-11-25T00:00:00Z' }, NOW)
    assert.ok(result.ok)
    assert.equal(result.from.toISOString(), '2026-11-24T00:00:00.000Z')
  })
})
