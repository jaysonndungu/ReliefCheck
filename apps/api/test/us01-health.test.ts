import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { errorEnvelopeSchema, livenessSchema, readinessSchema } from '@reliefcheck/contracts'
import type { ReadinessProbe, ReadinessResult } from '../src/routes/health.js'
import { loadConfig } from '../src/config/env.js'
import { startServer, type TestServer } from './helpers.js'

const probe = (result: ReadinessResult | Error): ReadinessProbe => ({
  check: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
})

async function getJson(url: string) {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  return { response, body: (await response.json()) as unknown }
}

describe('US01 liveness', () => {
  let server: TestServer
  before(async () => (server = await startServer()))
  after(() => server.close())

  it('returns 200 ok with a request id header', async () => {
    const { response, body } = await getJson(`${server.url}/api/v1/health/live`)
    assert.equal(response.status, 200)
    assert.deepEqual(livenessSchema.parse(body), { status: 'ok' })
    assert.match(response.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/)
    assert.equal(response.headers.get('x-powered-by'), null)
  })

  it('returns a 404 error envelope for unknown API routes', async () => {
    const { response, body } = await getJson(`${server.url}/api/v1/does-not-exist`)
    assert.equal(response.status, 404)
    assert.equal(errorEnvelopeSchema.parse(body).error.code, 'NOT_FOUND')
  })
})

describe('US01 readiness', () => {
  const cases: Array<[string, ReadinessProbe | null, string, boolean]> = [
    ['no database configured', null, 'DATABASE_UNCONFIGURED', false],
    ['database unreachable', probe('database_unavailable'), 'DATABASE_UNAVAILABLE', true],
    ['probe throws', probe(new Error('connection refused at 10.0.0.1')), 'DATABASE_UNAVAILABLE', true],
    ['no active release', probe('corpus_unavailable'), 'CORPUS_UNAVAILABLE', false],
  ]

  for (const [name, readiness, code, retryable] of cases) {
    it(`returns 503 ${code} when ${name}`, async () => {
      const server = await startServer({ readiness })
      try {
        const { response, body } = await getJson(`${server.url}/api/v1/health/ready`)
        assert.equal(response.status, 503)
        const envelope = errorEnvelopeSchema.parse(body)
        assert.equal(envelope.error.code, code)
        assert.equal(envelope.error.retryable, retryable)
        assert.doesNotMatch(JSON.stringify(body), /10\.0\.0\.1|refused|stack/i)
        assert.equal(response.headers.get('cache-control'), 'no-store')
      } finally {
        await server.close()
      }
    })
  }

  it('returns 200 ready when database and corpus are ready', async () => {
    const server = await startServer({ readiness: probe('ok') })
    try {
      const { response, body } = await getJson(`${server.url}/api/v1/health/ready`)
      assert.equal(response.status, 200)
      assert.deepEqual(readinessSchema.parse(body).checks, { database: 'ok', corpus: 'ok' })
    } finally {
      await server.close()
    }
  })
})

describe('US01 hosted UI serving', () => {
  let server: TestServer
  let dist: string
  before(async () => {
    dist = mkdtempSync(join(tmpdir(), 'reliefcheck-dist-'))
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>ReliefCheck</title><div id="root"></div>')
    server = await startServer({ webDist: dist })
  })
  after(async () => {
    await server.close()
    rmSync(dist, { recursive: true, force: true })
  })

  for (const path of ['/', '/appeal', '/compare', '/about']) {
    it(`serves index.html for the ${path} deep link`, async () => {
      const response = await fetch(`${server.url}${path}`, { headers: { accept: 'text/html' } })
      assert.equal(response.status, 200)
      assert.match(await response.text(), /<title>ReliefCheck<\/title>/)
    })
  }

  it('keeps unknown API routes as JSON 404s, not the SPA', async () => {
    const response = await fetch(`${server.url}/api/v1/nope`, { headers: { accept: 'text/html' } })
    assert.equal(response.status, 404)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
  })
})

describe('US01 server configuration', () => {
  it('runs with no optional integrations configured', () => {
    const config = loadConfig({})
    assert.equal(config.port, 3000)
    assert.equal(config.database, null)
    assert.equal(config.staffAuth, null)
  })

  it('treats blank values from .env.example as unset', () => {
    const config = loadConfig({ PORT: '3000', DATABASE_URL: '', SUPABASE_AUTH_ISSUER: '', SUPABASE_AUTH_JWKS_URL: '' })
    assert.equal(config.database, null)
    assert.equal(config.staffAuth, null)
  })

  it('rejects an invalid port without echoing values', () => {
    assert.throws(() => loadConfig({ PORT: '99999' }), /Invalid server configuration: PORT/)
  })

  it('requires the auth issuer and JWKS URL together, over https', () => {
    assert.throws(() => loadConfig({ SUPABASE_AUTH_ISSUER: 'https://x.supabase.co/auth/v1' }), /both/)
    assert.throws(
      () =>
        loadConfig({
          SUPABASE_AUTH_ISSUER: 'https://x.supabase.co/auth/v1',
          SUPABASE_AUTH_JWKS_URL: 'http://x.supabase.co/auth/v1/.well-known/jwks.json',
        }),
      /https/,
    )
  })
})
