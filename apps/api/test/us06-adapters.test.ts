import assert from 'node:assert/strict'
import test from 'node:test'
import { extractTextFile } from '../src/adapters/fileExtract.js'
import { IngestionInputError } from '../src/adapters/ingestionTypes.js'
import { fetchApprovedHtml, type WebResponse } from '../src/adapters/webFetch.js'
import { ingestSource } from '../src/adapters/ingestSource.js'

test('extracts bounded UTF-8 text files with a raw snapshot hash', () => {
  const bytes = new TextEncoder().encode('# Heading\n\nFirst paragraph.\n\nSecond paragraph.')
  const result = extractTextFile({ sourceId: 'VAL-01', bytes, filename: 'source.md', mimeType: 'text/markdown' })
  assert.equal(result.sourceId, 'VAL-01')
  assert.equal(result.blocks.length, 3)
  assert.equal(result.blocks[0]?.text, '# Heading')
  assert.match(result.contentHash, /^[a-f0-9]{64}$/u)
})

test('rejects unsupported or oversized file input', () => {
  assert.throws(
    () => extractTextFile({ sourceId: 'x', bytes: new Uint8Array([1]), filename: 'source.pdf', mimeType: 'application/pdf' }),
    (error: unknown) => error instanceof IngestionInputError && error.code === 'UNSUPPORTED_FILE_TYPE',
  )
})

function response(html: string, status = 200, headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' }): WebResponse {
  return { status, headers: new Headers(headers), arrayBuffer: async () => new TextEncoder().encode(html).buffer }
}

test('fetches only an approved HTML host and follows same-host redirects', async () => {
  const seen: string[] = []
  const result = await fetchApprovedHtml({
    approved: { id: 'JAM-01', url: 'https://example.test/start', allowedHost: 'example.test' },
    fetcher: async (url) => {
      seen.push(url)
      return seen.length === 1 ? response('', 302, { location: '/article' }) : response('<title>Relief</title><main>Help &amp; water</main>')
    },
  })
  assert.deepEqual(seen, ['https://example.test/start', 'https://example.test/article'])
  assert.equal(result.title, 'Relief')
  assert.equal(result.blocks[0]?.text, 'Relief Help & water')
})

test('rejects a redirect to a different hostname', async () => {
  await assert.rejects(
    () => fetchApprovedHtml({
      approved: { id: 'x', url: 'https://example.test/start', allowedHost: 'example.test' },
      fetcher: async () => response('', 302, { location: 'https://other.test/article' }),
    }),
    (error: unknown) => error instanceof IngestionInputError && error.code === 'SOURCE_HOST_NOT_APPROVED',
  )
})

test('dispatches a US05 file source through extraction and US07 preparation', async () => {
  const source = {
    id: 'FILE-01',
    title: 'Synthetic file',
    reference: { kind: 'file' as const, path: 'synthetic.txt' },
    publisher: null,
    disaster: 'valencia-dana' as const,
    sourceType: 'background' as const,
    language: 'en',
    publicationDate: null,
    reviewStatus: 'pending' as const,
    reviewedBy: null,
    reviewedAt: null,
    notes: 'Synthetic test source.',
  }
  const result = await ingestSource({
    source,
    bytes: new TextEncoder().encode('A reviewed source passage with enough readable content.'),
    filename: 'synthetic.txt',
    mimeType: 'text/plain',
  })
  assert.equal(result.document.sourceId, source.id)
  assert.equal(result.preparation.sourceContentHash, result.document.contentHash)
  assert.equal(result.chunks[0]?.sourceId, source.id)
})
