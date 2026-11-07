import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { preprocessDocument } from '../src/services/ingestion/preprocess.js'
import type { ExtractedBlock, ExtractedDocument, PreprocessingSource } from '../src/services/ingestion/preprocess.js'

const source: PreprocessingSource = {
  id: 'SYNTH-01',
  disaster: 'valencia-dana',
  reference: { kind: 'web', url: 'https://example.invalid/fictional-source' },
}

function block(text: string, page: number | null = null, heading: string | null = null): ExtractedBlock {
  return { text, page, heading }
}

function document(...blocks: ExtractedBlock[]): ExtractedDocument {
  return {
    sourceId: source.id,
    contentHash: createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),
    title: 'Synthetic report',
    language: 'en',
    publicationDate: null,
    retrievedAt: '2026-01-01T00:00:00Z',
    blocks,
    warnings: [],
  }
}

test('normalizes whitespace and provides provenance and citation offsets', () => {
  const result = preprocessDocument(document(
    block('Skip to main content\r\n\r\nSynthetic   report body.\r\n\r\nSecond\tparagraph.', 3, 'Evidence'),
    block('Another page.', 4),
  ), source)
  assert.deepEqual(result.flags, [])
  const [first, second] = result.chunks
  assert.equal(first.text, 'Synthetic report body.\n\nSecond paragraph.')
  assert.equal(first.sourceId, source.id)
  assert.equal(first.disaster, source.disaster)
  assert.deepEqual(first.reference, source.reference)
  assert.equal(first.title, 'Synthetic report')
  assert.equal(first.page, 3)
  assert.equal(first.heading, 'Evidence')
  assert.equal(first.text, result.blocks[first.blockIndex].text.slice(first.start, first.end))
  assert.equal(second.page, 4)
})

test('preserves Spanish, dates, negation, amounts and exact URLs', () => {
  const unicodeUrl = 'https://example.invalid/cafe\u0301'
  const raw = '\ufeffSaltar al contenido\r\n\r\nEl 5 de enero de 2026. No envi\u0301e 25 € a https://example.invalid/a?x=1&y=2. ' + unicodeUrl
  const result = preprocessDocument({ ...document(block(raw)), language: 'es', publicationDate: '2026-01-05' }, source)
  assert.deepEqual(result.flags, [])
  assert.equal(result.chunks[0].text, 'El 5 de enero de 2026. No envíe 25 € a https://example.invalid/a?x=1&y=2. ' + unicodeUrl)
  assert.equal(result.chunks[0].publicationDate, '2026-01-05')
})

test('removes repeated page titles and counters while retaining repeated warnings and table headers', () => {
  const result = preprocessDocument(document(
    block('Synthetic report\nDo not donate.\n| Item | Count |\nPage 1 of 2', 1),
    block('Synthetic report\nDo not donate.\n| Item | Count |\nPage 2 of 2', 2),
  ), source)
  assert.deepEqual(result.flags, ['possible_table'])
  assert.equal(result.blocks.length, 2)
  for (const entry of result.blocks) assert.equal(entry.text, 'Do not donate.\n| Item | Count |')
})

test('splits long Spanish paragraphs within the max and keeps word overlap and locators', () => {
  const text = 'No haga una transferencia. Verifique la fecha antes de actuar. '.repeat(12).trimEnd()
  const settings = { targetChars: 90, maxChars: 110, overlapChars: 26 }
  const result = preprocessDocument({ ...document(block(text, 2, 'Aviso')), language: 'es' }, source, settings)
  assert(result.chunks.length > 4)
  assert.equal(result.chunks[0].start, 0)
  assert.equal(result.chunks.at(-1)?.end, text.length)
  let overlaps = 0
  for (const [index, chunk] of result.chunks.entries()) {
    assert(chunk.text.length <= settings.maxChars)
    assert.equal(chunk.text, text.slice(chunk.start, chunk.end))
    assert.equal(chunk.heading, 'Aviso')
    assert.equal(chunk.page, 2)
    assert.equal(chunk.ordinal, index)
    if (index) {
      const previous = result.chunks[index - 1]
      assert(chunk.end > previous.end)
      if (chunk.start < previous.end) overlaps++
      assert(previous.end - chunk.start <= settings.overlapChars)
      assert(!/\S/u.test(text.slice(previous.end, chunk.start)))
    }
  }
  assert(overlaps > 0)
})

test('handles long paragraphs without sentence breaks and keeps long URLs whole', () => {
  const url = 'https://example.invalid/' + 'a'.repeat(65)
  const text = 'Check the following address carefully before continuing ' + url + ' ' + 'and preserve all subsequent words '.repeat(5).trimEnd()
  const { chunks } = preprocessDocument(document(block(text)), source, { targetChars: 50, maxChars: 90, overlapChars: 18 })
  assert(chunks.some(chunk => chunk.text.includes(url)))
  assert.equal(chunks.at(-1)?.end, text.length)
  assert(chunks.every(chunk => chunk.text.length <= 90))
})

test('flags empty, unreadable, template and overlong-token extractions without emitting chunks', () => {
  for (const [text, flag] of [
    [' \n Skip to main content \n', 'empty_text'],
    ['\ufffd\ufffd\ufffd', 'unreadable_text'],
    ['Welcome {{campaign.description}}', 'template_or_markup'],
    ['Access denied\nPlease verify your browser.', 'access_interstitial'],
    ['https://example.invalid/' + 'x'.repeat(100), 'oversized_token'],
  ] as const) {
    const result = preprocessDocument(document(block(text)), source, { targetChars: 50, maxChars: 100 })
    assert(result.flags.includes(flag))
    assert(result.needsReview)
    assert.deepEqual(result.chunks, [])
  }
})

test('keeps adapter warnings visible with the cleaned preview', () => {
  const result = preprocessDocument({ ...document(block('Check this synthetic text.')), warnings: ['Page order uncertain'] }, source)
  assert.deepEqual(result.flags, ['adapter_warning'])
  assert.deepEqual(result.adapterWarnings, ['Page order uncertain'])
  assert.equal(result.blocks.length, 1)
})

test('chunk IDs repeat across extraction times and distinguish changed text, locators, and raw snapshots', () => {
  const original = document(block('Synthetic test text.', 2, 'Warnings'))
  const first = preprocessDocument(original, source)
  const second = preprocessDocument({ ...original, retrievedAt: '2026-02-01T00:00:00Z' }, source)
  assert.deepEqual(first, second)
  const changed = preprocessDocument({ ...original, blocks: [block('New synthetic text.', 2, 'Warnings')] }, source)
  assert.notEqual(first.cleanedHash, changed.cleanedHash)
  assert.notEqual(first.chunks[0].id, changed.chunks[0].id)
  assert.notEqual(first.chunks[0].textHash, changed.chunks[0].textHash)

  const relocated = preprocessDocument({ ...original, blocks: [block(original.blocks[0].text, 3, 'Warnings')] }, source)
  assert.notEqual(first.chunks[0].id, relocated.chunks[0].id)
  assert.equal(first.chunks[0].textHash, relocated.chunks[0].textHash)

  const newSnapshot = preprocessDocument({ ...original, contentHash: 'b'.repeat(64) }, source)
  assert.notEqual(first.chunks[0].id, newSnapshot.chunks[0].id)
  assert.equal(first.cleanedHash, newSnapshot.cleanedHash)
})

test('rejects mismatched source IDs, invalid hashes and invalid size limits', () => {
  const input = document(block('Synthetic report body.'))
  assert.throws(() => preprocessDocument({ ...input, sourceId: 'SYNTH-02' }, source), /source ID/)
  assert.throws(() => preprocessDocument({ ...input, contentHash: 'invalid' }, source), /SHA-256/)
  assert.throws(() => preprocessDocument(input, source, { targetChars: 40, overlapChars: 40 }), RangeError)
})
