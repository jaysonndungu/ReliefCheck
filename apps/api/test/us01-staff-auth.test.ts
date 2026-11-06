import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey } from 'jose'
import { adminMeSchema, errorEnvelopeSchema, type StaffRole } from '@reliefcheck/contracts'
import { createJwtVerifier, type StaffRoleRepository } from '../src/middleware/staffAuth.js'
import { startServer, type TestServer } from './helpers.js'

const ISSUER = 'https://project.supabase.test/auth/v1'
const AUDIENCE = 'authenticated'

const developerId = randomUUID()
const adminId = randomUUID()
const disabledId = randomUUID()
const unknownId = randomUUID()

const roles = new Map<string, { role: StaffRole; enabled: boolean }>([
  [developerId, { role: 'developer', enabled: true }],
  [adminId, { role: 'admin', enabled: true }],
  [disabledId, { role: 'admin', enabled: false }],
])

const roleRepository: StaffRoleRepository = {
  async findEnabledRole(userId) {
    const entry = roles.get(userId)
    return entry?.enabled ? entry.role : null
  },
}

let signingKey: CryptoKey
let otherKey: CryptoKey
let server: TestServer

type TokenOptions = { sub?: string; issuer?: string; audience?: string; expiresIn?: string | number; key?: CryptoKey }

async function token({ sub = developerId, issuer = ISSUER, audience = AUDIENCE, expiresIn = '5m', key }: TokenOptions = {}) {
  return new SignJWT({ role: 'authenticated', user_metadata: { staff_role: 'admin' } })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setSubject(sub)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key ?? signingKey)
}

async function getMe(authorization?: string) {
  const response = await fetch(`${server.url}/api/v1/admin/me`, {
    headers: authorization ? { authorization } : {},
  })
  return { response, body: (await response.json()) as unknown }
}

async function expectError(authorization: string | undefined, status: number, code: string) {
  const { response, body } = await getMe(authorization)
  assert.equal(response.status, status)
  assert.equal(errorEnvelopeSchema.parse(body).error.code, code)
  assert.equal(response.headers.get('cache-control'), 'no-store')
}

before(async () => {
  const pair = await generateKeyPair('ES256')
  signingKey = pair.privateKey
  otherKey = (await generateKeyPair('ES256')).privateKey
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'ES256' }
  const verifyToken = createJwtVerifier(
    { issuer: ISSUER, jwksUrl: new URL('https://project.supabase.test/auth/v1/.well-known/jwks.json'), audience: AUDIENCE },
    createLocalJWKSet({ keys: [jwk] }),
  )
  server = await startServer({ staffAuth: { verifyToken, roles: roleRepository } })
})

after(() => server.close())

describe('US01 GET /admin/me (protected test endpoint)', () => {
  it('rejects a request with no token (401)', async () => {
    const { response } = await getMe()
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('www-authenticate'), 'Bearer')
  })

  it('rejects a non-bearer or malformed authorization header (401)', async () => {
    await expectError('Basic dXNlcjpwYXNz', 401, 'UNAUTHENTICATED')
    await expectError('Bearer not-a-jwt', 401, 'UNAUTHENTICATED')
  })

  it('rejects an expired token (401)', async () => {
    const expired = await token({ expiresIn: Math.floor(Date.now() / 1000) - 60 })
    await expectError(`Bearer ${expired}`, 401, 'UNAUTHENTICATED')
  })

  it('rejects a token with the wrong issuer or audience (401)', async () => {
    await expectError(`Bearer ${await token({ issuer: 'https://evil.test/auth/v1' })}`, 401, 'UNAUTHENTICATED')
    await expectError(`Bearer ${await token({ audience: 'anon' })}`, 401, 'UNAUTHENTICATED')
  })

  it('rejects a token signed by an untrusted key (401)', async () => {
    await expectError(`Bearer ${await token({ key: otherKey })}`, 401, 'UNAUTHENTICATED')
  })

  it('rejects an unsigned alg=none token (401)', async () => {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const unsigned = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: adminId, iss: ISSUER, aud: AUDIENCE, exp: 9999999999 })}.x`
    await expectError(`Bearer ${unsigned}`, 401, 'UNAUTHENTICATED')
  })

  it('rejects a valid token whose subject is not a UUID (401)', async () => {
    await expectError(`Bearer ${await token({ sub: 'not-a-uuid' })}`, 401, 'UNAUTHENTICATED')
  })

  it('forbids a verified user with no staff role, ignoring user metadata (403)', async () => {
    await expectError(`Bearer ${await token({ sub: unknownId })}`, 403, 'FORBIDDEN')
  })

  it('forbids a disabled staff user (403)', async () => {
    await expectError(`Bearer ${await token({ sub: disabledId })}`, 403, 'FORBIDDEN')
  })

  it('returns the verified developer identity (200)', async () => {
    const { response, body } = await getMe(`Bearer ${await token()}`)
    assert.equal(response.status, 200)
    const me = adminMeSchema.parse(body)
    assert.equal(me.userId, developerId)
    assert.equal(me.role, 'developer')
    assert.ok(!me.capabilities.includes('publish'))
  })

  it('returns admin capabilities for an admin (200)', async () => {
    const { response, body } = await getMe(`Bearer ${await token({ sub: adminId })}`)
    assert.equal(response.status, 200)
    const me = adminMeSchema.parse(body)
    assert.equal(me.role, 'admin')
    assert.ok(me.capabilities.includes('publish'))
  })
})

describe('US01 staff auth fails closed', () => {
  it('returns 503 AUTH_UNCONFIGURED when auth is not configured', async () => {
    const unconfigured = await startServer({ staffAuth: null })
    try {
      const response = await fetch(`${unconfigured.url}/api/v1/admin/me`, {
        headers: { authorization: `Bearer ${await token()}` },
      })
      assert.equal(response.status, 503)
      assert.equal(errorEnvelopeSchema.parse(await response.json()).error.code, 'AUTH_UNCONFIGURED')
    } finally {
      await unconfigured.close()
    }
  })

  it('returns 503 when the role lookup fails, never granting access', async () => {
    const failing = await startServer({
      staffAuth: {
        verifyToken: async () => developerId,
        roles: { findEnabledRole: () => Promise.reject(new Error('db down')) },
      },
    })
    try {
      const response = await fetch(`${failing.url}/api/v1/admin/me`, {
        headers: { authorization: `Bearer ${await token()}` },
      })
      assert.equal(response.status, 503)
      const body = errorEnvelopeSchema.parse(await response.json())
      assert.equal(body.error.code, 'DATABASE_UNAVAILABLE')
      assert.equal(body.error.retryable, true)
    } finally {
      await failing.close()
    }
  })
})
