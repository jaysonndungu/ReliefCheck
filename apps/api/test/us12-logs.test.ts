import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { adminLogsResponseSchema, errorEnvelopeSchema, type AdminLogEntry, type StaffRole } from '@reliefcheck/contracts'
import type { StaffAuthDeps } from '../src/middleware/staffAuth.js'
import { encodeLogCursor } from '../src/services/observability/requestLogs.js'
import { startServer, type TestServer } from './helpers.js'

const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEVELOPER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
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

const first: AdminLogEntry = {
  requestId: '11111111-1111-4111-8111-111111111111', occurredAt: '2026-11-25T12:00:00.000Z',
  endpoint: '/chat', method: 'POST', statusCode: 200, errorCode: null, latencyMs: 120,
  stageTimings: { retrieve: 42, generate: 78 }, mode: 'factual', outcome: 'supported',
  retrievalMode: 'hybrid', disasterId: null, releaseId: null, epoch: null, providerUsage: { input: 10, output: 20 },
}
const second: AdminLogEntry = { ...first, requestId: '22222222-2222-4222-8222-222222222222', occurredAt: '2026-11-25T11:59:00.000Z', statusCode: 503, errorCode: 'DATABASE_UNAVAILABLE', outcome: null }
let fail = false
let server: TestServer

before(async () => {
  server = await startServer({
    staffAuth,
    requestLogs: {
      list: async ({ limit }) => {
        if (fail) throw new Error('relation details must stay private')
        return { entries: limit === 1 ? [first] : [first, second], hasMore: limit === 1 }
      },
      deleteBefore: async () => 0,
    },
  })
})
after(() => server.close())

async function getLogs(query = '', token?: string) {
  const response = await fetch(`${server.url}/api/v1/admin/logs${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
  return { response, body: (await response.json()) as unknown }
}

describe('US12 GET /admin/logs', () => {
  it('rejects anonymous requests with 401', async () => {
    const { response, body } = await getLogs()
    assert.equal(response.status, 401)
    assert.equal(errorEnvelopeSchema.parse(body).error.code, 'UNAUTHENTICATED')
  })

  it('rejects developers with 403', async () => {
    const { response, body } = await getLogs('', 'developer.token.sig')
    assert.equal(response.status, 403)
    assert.equal(errorEnvelopeSchema.parse(body).error.code, 'FORBIDDEN')
  })

  it('returns paginated safe metadata for admins', async () => {
    const { response, body } = await getLogs('?limit=1', 'admin.token.sig')
    assert.equal(response.status, 200)
    const logs = adminLogsResponseSchema.parse(body)
    assert.equal(logs.entries.length, 1)
    assert.equal(logs.nextCursor, encodeLogCursor({ occurredAt: new Date(first.occurredAt), requestId: first.requestId }))
    assert.doesNotMatch(JSON.stringify(body), /relation details|question|appeal text|authorization/i)
  })

  it('rejects malformed cursors and windows', async () => {
    for (const [query, code] of [
      ['?cursor=not-a-cursor', 'INVALID_LOG_CURSOR'],
      ['?from=2026-11-25T12:00:00Z&to=2026-11-24T12:00:00Z', 'INVALID_LOG_QUERY'],
    ] as const) {
      const { response, body } = await getLogs(query, 'admin.token.sig')
      assert.equal(response.status, 400)
      assert.equal(errorEnvelopeSchema.parse(body).error.code, code)
    }
  })

  it('does not expose repository errors', async () => {
    fail = true
    try {
      const { response, body } = await getLogs('', 'admin.token.sig')
      assert.equal(response.status, 503)
      assert.equal(errorEnvelopeSchema.parse(body).error.code, 'LOGS_UNAVAILABLE')
      assert.doesNotMatch(JSON.stringify(body), /relation details/)
    } finally { fail = false }
  })
})
