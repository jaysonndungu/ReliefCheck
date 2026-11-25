import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createRequestTelemetry, sanitizeEvent, timeStage,
  type RequestEvent, type RequestEventSink,
} from '../src/services/observability/requestTelemetry.js'
import type { AnswerDeps } from '../src/services/generation/answerQuestion.js'
import type { RetrievalRepository, RetrievedChunk, Snapshot } from '../src/services/retrieval/retriever.js'
import { startServer } from './helpers.js'

// Clearly synthetic fixtures: no real organizations, sources or claims.
const VALENCIA = '11111111-1111-4111-8111-111111111111'
const RELEASE = '33333333-3333-4333-8333-333333333333'
const SOURCE = '55555555-5555-4555-8555-555555555555'
const PROFILE = { id: '99999999-9999-4999-8999-999999999999', model: 'synthetic-embedding', dimensions: 768 }
const snapshot: Snapshot = { releaseId: RELEASE, epoch: 4, asOf: '2026-11-25T12:00:00Z' }
/** Must never appear in any recorded event. */
const MARKER = 'PRIVATE-MARKER-donor@example.test'

const passage: RetrievedChunk = {
  chunkId: 'c-001',
  sourceVersionId: SOURCE,
  text: 'Synthetic notice: the synthetic flood relief office distributes water and shelter kits.',
  locator: 'Section 1',
  title: 'Synthetic relief notice',
  sourceUrl: 'https://notice.test/relief',
  publicationDate: '2024-11-14',
  reviewedAt: '2026-11-08T16:00:00Z',
  memberReleaseId: RELEASE,
  disasterId: VALENCIA,
  reviewState: 'approved',
}

function memorySink(options: { fail?: boolean } = {}) {
  const events: RequestEvent[] = []
  const sink: RequestEventSink = {
    insert: async (event) => {
      if (options.fail) throw Object.assign(new Error(`insert failed: ${MARKER}`), { code: '23514', detail: MARKER })
      events.push(event)
    },
  }
  return { sink, events }
}

function chatDeps(overrides: Partial<RetrievalRepository> = {}): AnswerDeps {
  return {
    retrieval: {
      activeCorpus: async () => ({ snapshot, embeddingProfile: PROFILE }),
      semanticSearch: async () => [],
      lexicalSearch: async () => [passage],
      overviewPassages: async () => [],
      currentSnapshot: async () => snapshot,
      ...overrides,
    },
    embedder: null,
    generator: null,
  }
}

const chatBody = (question = `Where can I find synthetic water kits? ${MARKER}`) => JSON.stringify({
  requestId: '77777777-7777-4777-8777-777777777777', disasterId: VALENCIA, question,
})

async function withTelemetry(
  deps: Parameters<typeof startServer>[0],
  sinkOptions: { fail?: boolean } = {},
  run: (ctx: { url: string; events: RequestEvent[]; flush: () => Promise<void>; dropped: () => number; failures: string[] }) => Promise<void>,
) {
  const { sink, events } = memorySink(sinkOptions)
  const failures: string[] = []
  const telemetry = createRequestTelemetry(sink, { onWriteFailure: (id, code) => failures.push(`${id} ${code}`) })
  const server = await startServer({ ...deps, telemetry })
  try {
    await run({ url: server.url, events, flush: telemetry.flush, dropped: telemetry.droppedEvents, failures })
  } finally {
    await server.close()
  }
}

const post = (url: string, body: string) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })

describe('US10 request telemetry', () => {
  it('records a successful chat request with outcome, snapshot, stage timings and no request content', async () => {
    await withTelemetry({ chat: chatDeps() }, {}, async ({ url, events, flush }) => {
      const response = await post(`${url}/api/v1/chat`, chatBody())
      assert.equal(response.status, 200)
      await response.json()
      await flush()

      assert.equal(events.length, 1)
      const [event] = events
      assert.equal(event.requestId, response.headers.get('x-request-id'))
      assert.equal(event.endpoint, '/chat')
      assert.equal(event.method, 'POST')
      assert.equal(event.statusCode, 200)
      assert.equal(event.errorCode, null)
      assert.equal(event.mode, 'factual')
      assert.equal(event.outcome, 'extractive_fallback')
      assert.equal(event.retrievalMode, 'lexical_only')
      assert.equal(event.disasterId, VALENCIA)
      assert.equal(event.releaseId, RELEASE)
      assert.equal(event.epoch, 4)
      assert.ok(event.latencyMs >= 0)
      assert.deepEqual(Object.keys(event.stageTimings ?? {}).sort(), ['recheck', 'retrieve', 'snapshot'])
      assert.doesNotMatch(JSON.stringify(event), /PRIVATE-MARKER|example\.test|water kits/)
    })
  })

  it('records an infrastructure failure with its error code', async () => {
    const failing = chatDeps({ lexicalSearch: async () => { throw new Error(`db down ${MARKER}`) } })
    await withTelemetry({ chat: failing }, {}, async ({ url, events, flush }) => {
      const response = await post(`${url}/api/v1/chat`, chatBody())
      assert.equal(response.status, 503)
      await flush()
      assert.equal(events.length, 1)
      assert.equal(events[0].statusCode, 503)
      assert.equal(events[0].errorCode, 'CHAT_UNAVAILABLE')
      assert.equal(events[0].outcome, null)
      assert.doesNotMatch(JSON.stringify(events), /PRIVATE-MARKER|db down/)
    })
  })

  it('records validation failures without the rejected input', async () => {
    await withTelemetry({ chat: chatDeps() }, {}, async ({ url, events, flush }) => {
      const response = await post(`${url}/api/v1/chat`, chatBody(`${MARKER} `.repeat(200)))
      assert.equal(response.status, 413)
      await flush()
      assert.equal(events[0].errorCode, 'INVALID_CHAT_INPUT')
      assert.equal(events[0].statusCode, 413)
      assert.doesNotMatch(JSON.stringify(events), /PRIVATE-MARKER/)
    })
  })

  it('records appeal requests as registry retrieval', async () => {
    await withTelemetry({}, {}, async ({ url, events, flush }) => {
      const response = await post(`${url}/api/v1/appeals/review`, JSON.stringify({
        requestId: '77777777-7777-4777-8777-777777777777', disasterId: VALENCIA, input: `https://${MARKER}`,
      }))
      assert.equal(response.status, 503)
      await flush()
      assert.equal(events[0].endpoint, '/appeals/review')
      assert.equal(events[0].retrievalMode, 'registry')
      assert.equal(events[0].errorCode, 'APPEAL_REVIEW_UNAVAILABLE')
      assert.doesNotMatch(JSON.stringify(events), /PRIVATE-MARKER/)
    })
  })

  it('stores route templates, not raw paths or query strings', async () => {
    await withTelemetry({}, {}, async ({ url, events, flush }) => {
      await (await fetch(`${url}/api/v1/sources/${SOURCE}?token=${MARKER}`)).text()
      await (await fetch(`${url}/api/v1/not-a-route/${MARKER}`)).text()
      await flush()
      assert.deepEqual(events.map((event) => [event.endpoint, event.errorCode]), [
        ['/sources/:sourceVersionId', 'SOURCE_EVIDENCE_UNAVAILABLE'],
        ['(unmatched)', 'NOT_FOUND'],
      ])
      assert.doesNotMatch(JSON.stringify(events), /PRIVATE-MARKER|token|5555-4555/)
    })
  })

  it('does not record health probes', async () => {
    await withTelemetry({}, {}, async ({ url, events, flush }) => {
      await (await fetch(`${url}/api/v1/health/live`)).text()
      await (await fetch(`${url}/api/v1/health/ready`)).text()
      await flush()
      assert.equal(events.length, 0)
    })
  })

  it('never fails the user response when the telemetry write fails, and counts the gap', async () => {
    await withTelemetry({ chat: chatDeps() }, { fail: true }, async ({ url, flush, dropped, failures }) => {
      const response = await post(`${url}/api/v1/chat`, chatBody())
      assert.equal(response.status, 200)
      assert.equal((await response.json() as { status: string }).status, 'extractive_fallback')
      await flush()
      assert.equal(dropped(), 1)
      assert.equal(failures.length, 1)
      assert.match(failures[0], /^[0-9a-f-]{36} 23514$/)
      assert.doesNotMatch(failures.join(), /PRIVATE-MARKER/)
    })
  })

  it('drops writes beyond the in-flight cap instead of queueing unboundedly', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const telemetry = createRequestTelemetry({ insert: () => gate }, { maxInFlight: 1 })
    const server = await startServer({ telemetry })
    try {
      await (await fetch(`${server.url}/api/v1/disasters`)).text()
      await (await fetch(`${server.url}/api/v1/disasters`)).text()
      assert.equal(telemetry.droppedEvents(), 1)
      release()
      await telemetry.flush()
    } finally {
      await server.close()
    }
  })
})

describe('US10 telemetry sanitization', () => {
  const base: RequestEvent = {
    requestId: '77777777-7777-4777-8777-777777777777', occurredAt: new Date(), endpoint: '/chat', method: 'POST',
    statusCode: 200, errorCode: null, latencyMs: 12.6, stageTimings: null, mode: null, outcome: null,
    retrievalMode: null, disasterId: null, releaseId: null, epoch: null, providerUsage: null,
  }

  it('rejects events without a valid request ID, method or status', () => {
    assert.equal(sanitizeEvent({ ...base, requestId: 'not-a-uuid' }), null)
    assert.equal(sanitizeEvent({ ...base, method: 'BREW' }), null)
    assert.equal(sanitizeEvent({ ...base, statusCode: 700 }), null)
  })

  it('normalizes untrusted fields to bounded, enumerable values', () => {
    const safe = sanitizeEvent({
      ...base,
      endpoint: `/chat?q=${MARKER}`,
      errorCode: 'bad code with spaces',
      latencyMs: 10_000_000,
      stageTimings: { retrieve: 4.4, 'Bad Key': 3, negative: -1, generate: Number.NaN },
      disasterId: MARKER,
      epoch: -2,
    })
    assert.ok(safe)
    assert.equal(safe.endpoint, '(unmatched)')
    assert.equal(safe.errorCode, null)
    assert.equal(safe.latencyMs, 600_000)
    assert.deepEqual(safe.stageTimings, { retrieve: 4 })
    assert.equal(safe.disasterId, null)
    assert.equal(safe.epoch, null)
  })

  it('times a stage even when it throws', async () => {
    const seen: string[] = []
    await assert.rejects(timeStage((stage) => seen.push(stage), 'generate', async () => { throw new Error('x') }))
    assert.deepEqual(seen, ['generate'])
  })
})
