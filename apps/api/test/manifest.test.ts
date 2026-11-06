import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { datasetManifestSchema, sourceRecordSchema } from '../src/services/ingestion/manifest.js'

const synthetic = {
  id: 'SYNTH-01',
  title: 'Synthetic source',
  reference: { kind: 'web', url: 'https://example.invalid/source' },
  publisher: null,
  disaster: 'valencia-dana',
  sourceType: 'background',
  language: null,
  publicationDate: null,
  reviewStatus: 'pending',
  reviewedBy: null,
  reviewedAt: null,
  notes: 'Fictional source for schema validation.',
}

test('validates the draft manifest and covers both supported disasters', () => {
  const draft = datasetManifestSchema.parse(JSON.parse(readFileSync(
    new URL('../../../data/drafts/source-manifest.json', import.meta.url), 'utf8',
  )))
  for (const disaster of ['valencia-dana', 'hurricane-melissa']) {
    assert(draft.sources.some(source => source.disaster === disaster))
  }
})

test('reports duplicate IDs at the duplicate row, even with different case', () => {
  const result = datasetManifestSchema.safeParse({
    schemaVersion: 1,
    sources: [synthetic, { ...synthetic, id: 'synth-01' }],
  })
  assert(!result.success)
  assert.deepEqual(result.error.issues[0].path, ['sources', 1, 'id'])
})

test('rejects invalid URLs, missing fields, invalid dates and unknown disasters', () => {
  for (const url of [
    'not a URL', 'http://example.invalid', 'https://127.0.0.1/a',
    'https://user:pass@example.invalid/a', 'https://example.invalid/%qq',
    'https://localhost/a', 'https://example.invalid:1234/a',
  ]) {
    assert(!sourceRecordSchema.safeParse({ ...synthetic, reference: { kind: 'web', url } }).success, url)
  }
  for (const change of [
    { title: ' ' }, { publisher: undefined }, { disaster: 'other-disaster' },
    { publicationDate: '2025-02-29' }, { sourceType: 'unknown' },
  ]) {
    assert(!sourceRecordSchema.safeParse({ ...synthetic, ...change }).success)
  }
})

test('accepts a private file reference and rejects absolute or traversal references', () => {
  for (const path of ['/example.pdf', '../example.pdf', 'private/../../example.pdf', 'C:/example.pdf']) {
    assert(!sourceRecordSchema.safeParse({ ...synthetic, reference: { kind: 'file', path } }).success, path)
  }
  const parsed = sourceRecordSchema.parse({ ...synthetic, reference: { kind: 'file', path: 'private/example.pdf' } })
  assert.equal(parsed.publisher, null)
  assert.equal(parsed.publicationDate, null)
})

test('requires real review fields to be entered explicitly for a reviewed decision', () => {
  assert(!sourceRecordSchema.safeParse({ ...synthetic, reviewStatus: 'approved' }).success)
  const review = { reviewedBy: 'Synthetic reviewer', reviewedAt: '2026-01-01T00:00:00Z' }
  assert(!sourceRecordSchema.safeParse({ ...synthetic, ...review }).success)
  assert(sourceRecordSchema.safeParse({ ...synthetic, ...review, reviewStatus: 'approved' }).success)
})
