import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatResponseSchema, errorEnvelopeSchema, type ChatRequest } from '@reliefcheck/contracts'
import { answerQuestion, type AnswerDeps } from '../src/services/generation/answerQuestion.js'
import { ProviderError, normalizeVector, type AnswerGenerator, type QueryEmbedder } from '../src/services/generation/provider.js'
import type { RetrievalRepository, RetrievedChunk, Snapshot } from '../src/services/retrieval/retriever.js'
import { startServer } from './helpers.js'

/**
 * ai.md §9: contract fixtures for every chat success, degraded and error response. They are
 * produced by the real pipeline with synthetic data, and this test fails if output drifts.
 * Regenerate deliberately with: UPDATE_FIXTURES=1 npm run api:test
 */
const FIXTURE_DIR = fileURLToPath(new URL('../../../fixtures/synthetic/us03-chat/', import.meta.url))
const UPDATE = process.env.UPDATE_FIXTURES === '1'

const DISASTER = '11111111-1111-4111-8111-111111111111'
const RELEASE = '33333333-3333-4333-8333-333333333333'
const REQUEST = '77777777-7777-4777-8777-777777777777'
const snapshot: Snapshot = { releaseId: RELEASE, epoch: 1, asOf: '2026-11-10T12:00:00.000Z' }

// Clearly synthetic records: .test domains, no real organizations or claims.
const warning: RetrievedChunk = {
  chunkId: 'chunk-a', sourceVersionId: '55555555-5555-4555-8555-555555555555',
  title: 'SYNTHETIC consumer warning about relief impersonation', locator: 'Paragraph 2',
  sourceUrl: 'https://consumer-office.test/warnings/relief', publicationDate: '2024-11-14',
  reviewedAt: '2026-11-08T16:00:00.000Z', memberReleaseId: RELEASE, disasterId: DISASTER, reviewState: 'approved',
  text: 'On 14 November 2024 the synthetic consumer office warned that fraudsters impersonated relief charities through messaging apps and asked for transfers to personal accounts. It advised donors to use only channels listed on an organisation\'s own website.',
}
const report: RetrievedChunk = {
  chunkId: 'chunk-b', sourceVersionId: '66666666-6666-4666-8666-666666666666',
  title: 'SYNTHETIC news report on fake donation pages', locator: 'Paragraph 5',
  sourceUrl: null, publicationDate: null,
  reviewedAt: '2026-11-08T16:30:00.000Z', memberReleaseId: RELEASE, disasterId: DISASTER, reviewState: 'approved',
  text: 'Volunteers reported fake donation pages that used names similar to real charities, including lookalike.test.',
}

function deps(options: {
  generate?: () => unknown
  embedFails?: boolean
  lexicalOnlyHits?: boolean
  noEvidence?: boolean
  corpus?: boolean
  changed?: boolean
}): AnswerDeps {
  const retrieval: RetrievalRepository = {
    activeCorpus: async () => options.corpus === false ? null : {
      snapshot, embeddingProfile: { id: '99999999-9999-4999-8999-999999999999', model: 'synthetic-embedding', dimensions: 768 },
    },
    semanticSearch: async () => options.noEvidence ? [] : [warning, report].map((c) => ({ ...c, cosineSimilarity: 0.82 })),
    lexicalSearch: async () => options.noEvidence ? [] : options.lexicalOnlyHits ? [warning] : [warning],
    currentSnapshot: async () => options.changed ? { ...snapshot, epoch: 2 } : snapshot,
  }
  const embedder: QueryEmbedder = {
    model: 'synthetic-embedding', dimensions: 768,
    embedQuery: async () => {
      if (options.embedFails) throw new ProviderError('quota', 60)
      return normalizeVector(Array.from({ length: 768 }, (_v, i) => (i === 0 ? 1 : 0)), 768)
    },
  }
  const generator: AnswerGenerator = {
    model: 'synthetic-generation',
    generate: async () => {
      if (!options.generate) throw new ProviderError('timeout')
      return options.generate()
    },
  }
  return { retrieval, embedder, generator, now: () => new Date(snapshot.asOf) }
}

const request = (question: string): ChatRequest => ({ requestId: REQUEST, disasterId: DISASTER, question })

const supportedAnswer = () => ({
  answerability: 'supported',
  claims: [
    { text: 'Fraudsters impersonated relief charities through messaging apps and asked for transfers to personal accounts.', citationIds: ['S1'] },
    { text: 'Volunteers reported fake donation pages that used names similar to real charities.', citationIds: ['S2'] },
    { text: 'Donors were advised to use only channels listed on an organisation\'s own website.', citationIds: ['S1'] },
  ],
  limitations: [],
})

const successCases: Array<{ name: string; question: string; deps: AnswerDeps }> = [
  { name: 'supported', question: 'How are scammers impersonating relief charities?', deps: deps({ generate: supportedAnswer }) },
  {
    name: 'partial', question: 'Is lookalike.test a legitimate charity?',
    deps: deps({ generate: () => ({
      answerability: 'partial',
      claims: [{ text: 'Volunteers reported fake donation pages that used names similar to real charities, including lookalike.test.', citationIds: ['S2'] }],
      limitations: ['The reviewed sources do not state whether lookalike.test is operated by any organisation.'],
    }) }),
  },
  {
    name: 'historical-dated', question: 'What did the consumer office warn about?',
    deps: deps({ generate: () => ({
      answerability: 'supported',
      claims: [{ text: 'In a warning dated 14 November 2024, the consumer office said fraudsters impersonated relief charities through messaging apps.', citationIds: ['S1'] }],
      limitations: ['This warning was published in November 2024 and may not describe current activity.'],
    }) }),
  },
  { name: 'insufficient-evidence', question: 'What is the best pizza topping?', deps: deps({ noEvidence: true }) },
  {
    name: 'insufficient-model-abstained', question: 'How many homes were destroyed?',
    deps: deps({ generate: () => ({ answerability: 'insufficient', claims: [], limitations: [] }) }),
  },
  { name: 'degraded-extractive-fallback', question: 'How are scammers impersonating relief charities?', deps: deps({}) },
  {
    name: 'degraded-lexical-only', question: 'consumer office warning relief charities',
    deps: deps({ embedFails: true, lexicalOnlyHits: true, generate: () => ({
      answerability: 'supported',
      claims: [{ text: 'The consumer office warned that fraudsters impersonated relief charities through messaging apps.', citationIds: ['S1'] }],
      limitations: [],
    }) }),
  },
]

const errorCases: Array<{ name: string; status: number; body: unknown; deps: AnswerDeps | null }> = [
  { name: 'error-invalid-input', status: 400, body: { ...request('x'), disasterId: 'not-a-uuid' }, deps: deps({}) },
  { name: 'error-question-too-long', status: 413, body: request('x'.repeat(2_001)), deps: deps({}) },
  { name: 'error-appeal-review-required', status: 422, body: request('Is https://lookalike.test legitimate?'), deps: deps({}) },
  { name: 'error-mode-unavailable', status: 422, body: { ...request('Compare these'), mode: 'comparison' }, deps: deps({}) },
  { name: 'error-chat-unavailable', status: 503, body: request('Any question'), deps: null },
  { name: 'error-corpus-unavailable', status: 503, body: request('Any question'), deps: deps({ corpus: false }) },
  { name: 'error-kb-changed', status: 409, body: request('How are scammers impersonating relief charities?'), deps: deps({ generate: supportedAnswer, changed: true }) },
]

function compareOrWrite(name: string, actual: unknown) {
  const path = join(FIXTURE_DIR, `${name}.json`)
  const serialized = `${JSON.stringify(actual, null, 2)}\n`
  if (UPDATE) {
    mkdirSync(FIXTURE_DIR, { recursive: true })
    writeFileSync(path, serialized)
    return
  }
  assert.ok(existsSync(path), `Missing fixture ${name}.json; run UPDATE_FIXTURES=1 npm run api:test`)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), actual, `${name}.json drifted from pipeline output`)
}

describe('US03 chat contract fixtures (ai.md §9)', () => {
  for (const testCase of successCases) {
    it(`${testCase.name}.json matches pipeline output and the ChatResponse contract`, async () => {
      const outcome = await answerQuestion(testCase.deps, request(testCase.question))
      assert.equal(outcome.kind, 'answered')
      if (outcome.kind !== 'answered') return
      chatResponseSchema.parse(outcome.response)
      compareOrWrite(testCase.name, { request: request(testCase.question), httpStatus: 200, response: outcome.response })
    })
  }

  for (const testCase of errorCases) {
    it(`${testCase.name}.json matches the HTTP error envelope`, async () => {
      const server = await startServer({ chat: testCase.deps })
      try {
        const response = await fetch(`${server.url}/api/v1/chat`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(testCase.body),
        })
        assert.equal(response.status, testCase.status)
        const envelope = errorEnvelopeSchema.parse(await response.json())
        // The server assigns a random tracing ID; pin it so the fixture is stable.
        compareOrWrite(testCase.name, {
          request: testCase.body, httpStatus: testCase.status, response: { ...envelope, requestId: REQUEST },
        })
      } finally {
        await server.close()
      }
    })
  }
})
