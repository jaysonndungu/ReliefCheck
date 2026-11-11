import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { errorEnvelopeSchema, sourceEvidenceResponseSchema } from '@reliefcheck/contracts'
import type { SourceEvidenceRepository } from '../src/services/sources/sourceEvidence.js'
import { startServer } from './helpers.js'

const SOURCE_ID = '11111111-1111-4111-8111-111111111111'
const RELEASE_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_RELEASE = '33333333-3333-4333-8333-333333333333'
const snapshot = { releaseId: RELEASE_ID, epoch: 7, asOf: '2026-11-08T17:00:00Z' }
const record = {
  sourceVersionId: SOURCE_ID,
  title: 'Synthetic reviewed document',
  sourceUrl: null,
  publicationDate: null,
  reviewedAt: '2026-11-08T16:00:00Z',
  excerpts: [{ locator: 'Page 2', excerpt: '<script>plain source text</script>' }],
  reviewState: 'approved' as const,
  releaseState: 'published' as const,
  memberReleaseId: RELEASE_ID,
  privateObjectKey: 'must-never-leak',
}

function repository(
  current = snapshot,
  candidate: Awaited<ReturnType<SourceEvidenceRepository['lookup']>>['record'] = record,
  after = current,
): SourceEvidenceRepository {
  return {
    lookup: async () => ({ snapshot: current, record: candidate }),
    currentSnapshot: async () => after,
  }
}

async function request(repo: SourceEvidenceRepository | null, path = `/api/v1/sources/${SOURCE_ID}`) {
  const server = await startServer({ sourceEvidence: repo })
  try {
    const response = await fetch(`${server.url}${path}`)
    return { status: response.status, body: await response.json() as unknown, headers: response.headers }
  } finally {
    await server.close()
  }
}

describe('US04 public evidence route', () => {
  it('fails visibly when the production source repository is not configured', async () => {
    const result = await request(null)
    assert.equal(result.status, 503)
    assert.equal(errorEnvelopeSchema.parse(result.body).error.code, 'SOURCE_EVIDENCE_UNAVAILABLE')
    assert.equal(result.headers.get('cache-control'), 'no-store')
  })

  it('returns only reviewed excerpts in the active published release', async () => {
    const result = await request(repository(), `/api/v1/sources/${SOURCE_ID}?releaseId=${RELEASE_ID}&epoch=7`)
    assert.equal(result.status, 200)
    const body = sourceEvidenceResponseSchema.parse(result.body)
    assert.equal(body.excerpts[0]?.excerpt, '<script>plain source text</script>')
    assert.equal(body.publicationDate, null)
    assert.doesNotMatch(JSON.stringify(result.body), /privateObjectKey|must-never-leak/)
  })

  for (const [name, candidate] of [
    ['unpublished', { ...record, releaseState: 'ready' as const }],
    ['unreviewed', { ...record, reviewState: 'pending' as const }],
    ['withdrawn', { ...record, memberReleaseId: OTHER_RELEASE }],
    ['unsafe source URL', { ...record, sourceUrl: 'javascript:alert(1)' }],
    ['missing', null],
  ] as const) {
    it(`denies ${name} source evidence`, async () => {
      const result = await request(repository(snapshot, candidate))
      assert.equal(result.status, 404)
      assert.equal(errorEnvelopeSchema.parse(result.body).error.code, 'SOURCE_UNAVAILABLE')
    })
  }

  it('rejects empty, exponent and hex epochs before querying evidence', async () => {
    const repo = repository()
    repo.lookup = async () => assert.fail('invalid epoch must not reach the repository')
    for (const epoch of ['', '1e2', '0x7', '7.0']) {
      const result = await request(repo, `/api/v1/sources/${SOURCE_ID}?releaseId=${RELEASE_ID}&epoch=${epoch}`)
      assert.equal(result.status, 400)
    }
  })

  it('rejects an old answer snapshot and an in-flight release change', async () => {
    const old = await request(repository(), `/api/v1/sources/${SOURCE_ID}?releaseId=${OTHER_RELEASE}&epoch=1`)
    assert.equal(old.status, 409)
    assert.equal(errorEnvelopeSchema.parse(old.body).error.code, 'KB_CHANGED')
    const changed = await request(repository(snapshot, record, { ...snapshot, epoch: 8 }))
    assert.equal(changed.status, 409)
  })

  it('reports a cleared corpus, invalid reference, and repository failure without leaking internals', async () => {
    const cleared = await request({ lookup: async () => ({ snapshot: null, record: null }), currentSnapshot: async () => null })
    assert.equal(cleared.status, 503)
    assert.equal(errorEnvelopeSchema.parse(cleared.body).error.code, 'CORPUS_UNAVAILABLE')
    const invalid = await request(repository(), '/api/v1/sources/not-a-uuid')
    assert.equal(invalid.status, 400)
    const broken = await request({
      lookup: async () => { throw new Error('private database detail') },
      currentSnapshot: async () => snapshot,
    })
    assert.equal(broken.status, 503)
    assert.doesNotMatch(JSON.stringify(broken.body), /private database detail/)
  })
})
