import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createGeminiClient } from '../src/adapters/gemini/geminiClient.js'
import { ProviderError } from '../src/services/generation/provider.js'

test('cancelled Gemini requests keep their slots until the underlying SDK calls settle', async t => {
  const pending: Array<(response: Response) => void> = []
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { pending.push(resolve) }))
  const { embedder } = createGeminiClient({
    apiKey: 'synthetic-test-key', generationModel: 'synthetic-generation', embeddingModel: 'synthetic-embedding',
  })
  const controllers = [new AbortController(), new AbortController()]
  const calls = controllers.map(({ signal }) => embedder.embedQuery('test question', signal))
  try {
    await setImmediate()
    assert.equal(pending.length, 2)
    const cancelled = calls.map(call => assert.rejects(call, (error: unknown) =>
      error instanceof ProviderError && error.failure === 'timeout'))
    controllers.forEach(controller => controller.abort())
    await Promise.all(cancelled)
    await assert.rejects(embedder.embedQuery('next question', new AbortController().signal), (error: unknown) =>
      error instanceof ProviderError && error.failure === 'busy')

    const response = () => Response.json({ embeddings: [{ values: Array(768).fill(1) }] })
    pending[0]!(response())
    await setImmediate()
    const resumed = embedder.embedQuery('next question', new AbortController().signal)
    await setImmediate()
    assert.equal(pending.length, 3)
    pending[2]!(response())
    assert.equal((await resumed).length, 768)
  } finally {
    for (const resolve of pending) resolve(Response.json({}))
    await Promise.allSettled(calls)
  }
})
