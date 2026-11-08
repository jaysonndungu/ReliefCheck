import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { appealReviewResponseSchema, errorEnvelopeSchema, type Citation } from '@reliefcheck/contracts'
import { normalizeTarget, reviewAppeal, type AppealRegistryRepository, type ReviewedRegistryRecord } from '../src/services/registry/reviewAppeal.js'
import { startServer } from './helpers.js'

const DISASTER = '11111111-1111-4111-8111-111111111111'
const OTHER_DISASTER = '22222222-2222-4222-8222-222222222222'
const RELEASE = '33333333-3333-4333-8333-333333333333'
const RECORD = '44444444-4444-4444-8444-444444444444'
const WARNING = '55555555-5555-4555-8555-555555555555'
const SOURCE = '66666666-6666-4666-8666-666666666666'
const REQUEST = '77777777-7777-4777-8777-777777777777'
const snapshot = { releaseId: RELEASE, epoch: 1, asOf: '2026-11-08T17:00:00Z' }
const citation: Citation = {
  id: 'source-1', sourceVersionId: SOURCE, title: 'Synthetic public notice', sourceUrl: 'https://example.test/evidence',
  publicationDate: null, reviewedAt: '2026-11-08T16:00:00Z', locator: 'Section 2', excerpt: 'Synthetic evidence only.',
}

function campaign(overrides: Partial<ReviewedRegistryRecord> = {}): ReviewedRegistryRecord {
  return {
    recordVersionId: RECORD, disasterId: DISASTER, memberReleaseId: RELEASE, reviewState: 'approved',
    kind: 'campaign', title: 'Synthetic relief campaign', organizationName: 'Synthetic Organization',
    matchScope: 'host', matchValue: 'official.test', normalizedHostname: 'official.test',
    officialChannelUrl: 'https://official.test/donate', publicationDate: null,
    reviewedAt: '2026-11-08T16:00:00Z', reviewExpiresAt: '2099-01-01T00:00:00Z',
    effectiveFrom: null, effectiveUntil: null, warningRetracted: false,
    evidence: [{ citation, sourceReviewState: 'approved', memberReleaseId: RELEASE, sourceDisasterIds: [DISASTER] }],
    ...overrides,
  }
}

function warning(overrides: Partial<ReviewedRegistryRecord> = {}): ReviewedRegistryRecord {
  return campaign({ recordVersionId: WARNING, kind: 'warning', title: 'Synthetic published warning',
    organizationName: null, officialChannelUrl: null, warningRetracted: false, ...overrides })
}

function repository(records: ReviewedRegistryRecord[], current = snapshot): AppealRegistryRepository {
  return { lookup: async () => ({ snapshot, records }), currentSnapshot: async () => current }
}

async function decide(input: string, records: ReviewedRegistryRecord[], disasterId = DISASTER) {
  const outcome = await reviewAppeal(repository(records), { requestId: REQUEST, disasterId, input }, new Date('2026-11-08T17:00:00Z'))
  assert.equal(outcome.kind, 'reviewed')
  if (outcome.kind !== 'reviewed') throw new Error('Expected reviewed result')
  return outcome.response
}

describe('US13 exact target normalization', () => {
  it('normalizes case, one trailing dot and IDNA without accepting lookalikes', () => {
    assert.equal(normalizeTarget('HTTPS://OFFICIAL.TEST./donate#fragment')?.host, 'official.test')
    assert.equal(normalizeTarget('https://bücher.test')?.host, 'xn--bcher-kva.test')
    assert.notEqual(normalizeTarget('https://officіal.test')?.host, 'official.test')
    assert.equal(normalizeTarget('https://official.test@evil.test'), null)
    assert.equal(normalizeTarget('ftp://official.test'), null)
    assert.equal(normalizeTarget('https://official.test:8443'), null)
    assert.equal(normalizeTarget('https://127.0.0.1'), null)
    assert.equal(normalizeTarget('https://official.test/%GG'), null)
    assert.equal(normalizeTarget('https://official%2Etest'), null)
  })

  it('never transfers authority from a similar, nested or mentioned hostname', async () => {
    for (const input of [
      'https://official.test.attacker.test', 'https://not-official.test', 'https://www.official.test',
      'https://evil.test/path/official.test', 'https://evil.test/?next=official.test',
      'Please donate to Synthetic Organization',
    ]) {
      const response = await decide(input, [campaign()])
      assert.equal(response.result.status, 'insufficient_evidence', input)
    }
  })
})

describe('US13 deterministic registry review', () => {
  it('reports an exact current channel and reviewed supporting citation', async () => {
    const response = await decide('https://OFFICIAL.TEST./any-path', [campaign()])
    assert.equal(response.result.status, 'documented_official_channel')
    assert.deepEqual(response.result.reasonCodes, ['MATCHED_OFFICIAL'])
    assert.equal(response.targets[0]?.matches[0]?.organizationName, 'Synthetic Organization')
    assert.equal(response.targets[0]?.matches[0]?.publicationDate, null)
    assert.equal(response.citations[0]?.id, 'source-1')
    assert.equal(appealReviewResponseSchema.safeParse(response).success, true)
  })

  it('reports a dated warning without calling an unknown host fraudulent', async () => {
    const response = await decide('official.test', [warning({ publicationDate: '2025-10-31' })])
    assert.equal(response.result.status, 'published_warning_found')
    assert.equal(response.targets[0]?.matches[0]?.publicationDate, '2025-10-31')
    assert.equal((await decide('unknown.test', [warning()])).result.status, 'insufficient_evidence')
  })

  it('returns insufficient evidence for expired, retracted, conflicting and ambiguous records', async () => {
    const expired = await decide('official.test', [campaign({ reviewExpiresAt: '2026-11-01T00:00:00Z' })])
    assert.equal(expired.result.status, 'insufficient_evidence')
    assert.equal(expired.result.historical, true)
    assert.equal((await decide('official.test', [campaign({ effectiveUntil: 'not-a-date' })])).result.status, 'insufficient_evidence')
    const retracted = await decide('official.test', [warning({ warningRetracted: true })])
    assert.equal(retracted.result.status, 'insufficient_evidence')
    const conflict = await decide('official.test', [campaign(), warning()])
    assert.equal(conflict.result.status, 'insufficient_evidence')
    assert.equal(conflict.result.conflict, true)
    assert.equal(conflict.targets[0]?.matches.length, 2)
    const ambiguous = await decide('official.test', [campaign(), campaign({ recordVersionId: WARNING })])
    assert.deepEqual(ambiguous.result.reasonCodes, ['AMBIGUOUS_MATCH'])
  })

  it('keeps multi-link aggregate insufficient while retaining per-target warning evidence', async () => {
    const response = await decide('Look at https://official.test and https://other.test', [warning()])
    assert.equal(response.result.status, 'insufficient_evidence')
    assert.deepEqual(response.result.reasonCodes, ['MULTIPLE_TARGETS'])
    assert.equal(response.targets.find((item) => item.targetHost === 'official.test')?.result.status, 'published_warning_found')
    assert.equal(response.citations.length, 1)
  })

  it('requires exact campaign path/query on a shared platform', async () => {
    const exact = campaign({ matchScope: 'exact_url', matchValue: 'https://give.test/campaign/123?ref=a',
      normalizedHostname: 'give.test', officialChannelUrl: 'https://give.test/campaign/123?ref=a' })
    assert.equal((await decide('https://give.test/campaign/123?ref=a#section', [exact])).result.status, 'documented_official_channel')
    for (const input of ['https://give.test/campaign/124?ref=a', 'https://give.test/campaign/123?ref=b',
      'Please visit https://give.test/campaign/123?ref=a,']) {
      assert.equal((await decide(input, [exact])).result.status, 'insufficient_evidence')
    }
  })

  it('filters other disasters, drafts, old releases and unreviewed source evidence', async () => {
    const variants = [campaign({ disasterId: OTHER_DISASTER }), campaign({ reviewState: 'pending' }),
      campaign({ memberReleaseId: OTHER_DISASTER }), campaign({ evidence: [{ citation, sourceReviewState: 'pending',
        memberReleaseId: RELEASE, sourceDisasterIds: [DISASTER] }] }),
      campaign({ evidence: [{ citation, sourceReviewState: 'approved', memberReleaseId: RELEASE,
        sourceDisasterIds: [OTHER_DISASTER] }] })]
    for (const variant of variants) {
      assert.equal((await decide('official.test', [variant])).result.status, 'insufficient_evidence')
    }
  })
})

describe('US13 API boundary', () => {
  it('returns 503 when the reviewed registry is not configured and 400 for invalid input', async () => {
    const server = await startServer()
    try {
      const response = await fetch(`${server.url}/api/v1/appeals/review`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: REQUEST, disasterId: DISASTER, input: 'official.test' }) })
      assert.equal(response.status, 503)
      assert.equal(errorEnvelopeSchema.parse(await response.json()).error.code, 'APPEAL_REVIEW_UNAVAILABLE')
      const invalid = await fetch(`${server.url}/api/v1/appeals/review`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: REQUEST, input: '' }) })
      assert.equal(invalid.status, 400)
    } finally { await server.close() }
  })

  it('returns a reviewed result and invalidates a changed release', async () => {
    const server = await startServer({ appealRegistry: repository([campaign()]) })
    try {
      const response = await fetch(`${server.url}/api/v1/appeals/review`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: REQUEST, disasterId: DISASTER, input: 'official.test' }) })
      assert.equal(response.status, 200)
      assert.equal(appealReviewResponseSchema.parse(await response.json()).result.status, 'documented_official_channel')
    } finally { await server.close() }
    const changed = await startServer({ appealRegistry: repository([campaign()], { ...snapshot, epoch: 2 }) })
    try {
      const response = await fetch(`${changed.url}/api/v1/appeals/review`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: REQUEST, disasterId: DISASTER, input: 'official.test' }) })
      assert.equal(response.status, 409)
      assert.equal(errorEnvelopeSchema.parse(await response.json()).error.code, 'KB_CHANGED')
    } finally { await changed.close() }
  })

  it('fails closed if reviewed records reuse one citation ID for different evidence', async () => {
    const conflicting = warning({ evidence: [{ citation: { ...citation, title: 'Different source' },
      sourceReviewState: 'approved', memberReleaseId: RELEASE, sourceDisasterIds: [DISASTER] }] })
    const server = await startServer({ appealRegistry: repository([campaign(), conflicting]) })
    try {
      const response = await fetch(`${server.url}/api/v1/appeals/review`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: REQUEST, disasterId: DISASTER, input: 'official.test' }) })
      assert.equal(response.status, 503)
      assert.equal(errorEnvelopeSchema.parse(await response.json()).error.code, 'APPEAL_REVIEW_UNAVAILABLE')
    } finally { await server.close() }
  })
})
