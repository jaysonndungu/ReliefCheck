import { createHash } from 'node:crypto'
import type { SourceRecord } from './manifest.js'

export interface ExtractedBlock {
  text: string
  page: number | null
  heading: string | null
}

// Shared shape for the US06 file and web adapters, as specified in ai.md.
export interface ExtractedDocument {
  sourceId: string
  contentHash: string
  title: string
  language: string | null
  publicationDate: string | null
  retrievedAt: string
  blocks: readonly ExtractedBlock[]
  warnings: readonly string[]
}

export type PreprocessingSource = Pick<SourceRecord, 'id' | 'disaster' | 'reference'>
export interface ChunkOptions {
  targetChars?: number
  maxChars?: number
  overlapChars?: number
}

export interface CleanedBlock extends ExtractedBlock {
  blockIndex: number
}

export interface PreparedChunk {
  id: string
  textHash: string
  ordinal: number
  text: string
  sourceId: string
  disaster: PreprocessingSource['disaster']
  reference: PreprocessingSource['reference']
  title: string
  language: string | null
  publicationDate: string | null
  sourceContentHash: string
  blockIndex: number
  page: number | null
  heading: string | null
  start: number
  end: number
}

export type ReviewFlag =
  | 'empty_text'
  | 'unreadable_text'
  | 'template_or_markup'
  | 'access_interstitial'
  | 'possible_table'
  | 'oversized_token'
  | 'adapter_warning'

export const PREPROCESSING_VERSION = '1'

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const boilerplate = /^(?:skip to (?:main )?content|saltar al contenido(?: principal)?|javascript (?:is required|must be enabled)|enable javascript to (?:continue|view this page))$/iu
const pageCounter = /^(?:page|página)\s+\d+\s*(?:of|de|\/)\s*\d+$/iu

function cleanLine(line: string): string {
  return line.split(/(https?:\/\/\S+)/giu)
    .map((part, index) => index % 2 === 0 ? part.normalize('NFC') : part)
    .join('').replace(/[\p{Zs}\t]+/gu, ' ').trim()
}

function cleanBlocks(document: ExtractedDocument): CleanedBlock[] {
  const title = cleanLine(document.title)
  const blocks = document.blocks.map((block, blockIndex) => {
    const lines = block.text
      .replace(/\r\n?|[\u000b\u000c\u2028\u2029]/gu, '\n')
      .replace(/[\u0000-\u0008\u000e-\u001f\u007f\ufeff]/gu, '')
      .trim()
      .split('\n').map(cleanLine)
    return { ...block, lines, blockIndex }
  })
  // A document title repeated at the top of multiple numbered pages is a running header.
  const headerPages = new Set(blocks.filter(
    block => block.page !== null && block.heading === null && block.lines[0] === title,
  ).map(block => block.page))

  return blocks.flatMap(({ page, heading, lines, blockIndex }) => {
    if (page !== null && heading === null && headerPages.size > 1 && lines[0] === title) lines.shift()
    const text = lines.filter((line, index) =>
      !boilerplate.test(line) &&
      !(page !== null && (index === 0 || index === lines.length - 1) && pageCounter.test(line)),
    ).join('\n').replace(/\n{3,}/g, '\n\n').trim()
    return text ? [{ text, page, heading: heading ? cleanLine(heading) || null : null, blockIndex }] : []
  })
}

function optionsFor(options: ChunkOptions) {
  const target = options.targetChars ?? 1500
  const max = options.maxChars ?? 2400
  const overlap = options.overlapChars ?? Math.min(200, Math.floor(target / 5))
  if (![target, max, overlap].every(Number.isInteger) ||
    target < 32 || max < target || max > 2400 || overlap < 0 || overlap > 200 || overlap >= target / 2) {
    throw new RangeError('Expected 32 <= target <= max <= 2400, with overlap 0–200 and less than half the target')
  }
  return { target, max, overlap }
}

function safeEnd(text: string, end: number): number {
  // Keep UTF-16 surrogate pairs together even in the hard-cut fallback.
  const code = text.charCodeAt(end)
  return code >= 0xdc00 && code <= 0xdfff ? end - 1 : end
}

function* passages(text: string, language: string | null, settings: ReturnType<typeof optionsFor>) {
  const { target, max, overlap } = settings
  const segmenter = new Intl.Segmenter(language?.split('-')[0] === 'es' ? 'es' : 'en', { granularity: 'sentence' })
  const sentenceEnds = new Set(Array.from(segmenter.segment(text), sentence =>
    sentence.index + sentence.segment.trimEnd().length,
  ))

  let start = 0
  let previousEnd = 0
  while (start < text.length) {
    const limit = safeEnd(text, Math.min(start + max, text.length))
    let end = limit
    if (text.length - start > target) {
      let paragraphEnd = 0
      let sentenceEnd = 0
      let wordEnd = 0
      let nextWordEnd = 0
      for (let cursor = start + 1; cursor <= limit; cursor++) {
        if (cursor < text.length && !/\s/u.test(text[cursor])) continue
        if (/\s/u.test(text[cursor - 1])) continue
        if (cursor <= start + target) {
          wordEnd = cursor
          if (cursor >= start + Math.floor(target / 2)) {
            if (text.startsWith('\n\n', cursor)) paragraphEnd = cursor
            if (sentenceEnds.has(cursor)) sentenceEnd = cursor
          }
        } else {
          nextWordEnd = cursor
          break
        }
      }
      end = paragraphEnd || sentenceEnd || wordEnd || nextWordEnd || limit
    }
    if (end <= previousEnd) {
      start = previousEnd
      while (start < text.length && /\s/u.test(text[start])) start++
      continue
    }
    previousEnd = end
    yield { start, end, text: text.slice(start, end) }
    if (end === text.length) break

    let next = end
    if (overlap && /\s/u.test(text[end])) {
      next = Math.max(start + 1, end - overlap)
      while (next < end && !/\s/u.test(text[next - 1])) next++
    }
    while (next < text.length && /\s/u.test(text[next])) next++
    start = next
  }
}

/** Pure preparation of already extracted text. Flags and drafts require staff review. */
export function preprocessDocument(
  document: ExtractedDocument,
  source: PreprocessingSource,
  options: ChunkOptions = {},
) {
  if (document.sourceId !== source.id) throw new Error('Extracted document source ID does not match the manifest record')
  if (!/^[a-f0-9]{64}$/i.test(document.contentHash)) throw new Error('Expected the SHA-256 of the raw source snapshot')
  if (document.blocks.reduce((sum, block) => sum + block.text.length, 0) > 100_000) {
    throw new RangeError('Extracted text exceeds 100,000 UTF-16 code units')
  }

  const settings = optionsFor(options)
  const blocks = cleanBlocks(document)
  const flags: ReviewFlag[] = []
  const combined = blocks.map(block => block.text).join('\n\n')
  const cleanedHash = hash(JSON.stringify(blocks))
  const contentHash = document.contentHash.toLowerCase()
  const title = document.title.normalize('NFC').trim()
  const reference = source.reference.kind === 'web'
    ? { kind: 'web' as const, url: source.reference.url }
    : { kind: 'file' as const, path: source.reference.path }

  if (!combined) flags.push('empty_text')
  if (combined && (
    !/\p{L}/u.test(combined) ||
    (combined.match(/\ufffd/gu)?.length ?? 0) >= 3 ||
    /(?:Ã[\u0080-\u00bf]|â€|ï»¿)/u.test(combined)
  )) flags.push('unreadable_text')
  if (/<(?:script|style|html|body|nav)\b|\{\{[^{}\n]+\}\}|\[object Object\]/iu.test(combined)) {
    flags.push('template_or_markup')
  }
  if (combined.length < 1000 && /^(?:access denied|403 forbidden|verify (?:that )?you are human|acceso denegado)[.!]?(?:\n|$)/iu.test(combined)) {
    flags.push('access_interstitial')
  }
  if (document.blocks.some(block => /(?:^|\n)(?:[^\n|]*(?:\|[^\n|]+){2}\||[^\n\t]+\t[^\n\t]+\t[^\n\t]+)/u.test(block.text))) {
    flags.push('possible_table')
  }
  if (combined.split(/\s+/u).some(token => token.length > settings.max)) flags.push('oversized_token')
  if (document.warnings.length) flags.push('adapter_warning')

  const chunks: PreparedChunk[] = []
  const blocked = flags.some(flag => ['empty_text', 'unreadable_text', 'template_or_markup', 'access_interstitial', 'oversized_token'].includes(flag))
  if (!blocked) {
    const versionKey = JSON.stringify([
      PREPROCESSING_VERSION, source.id, source.disaster, reference, contentHash,
      cleanedHash, title, document.language, document.publicationDate, settings,
    ])
    for (const block of blocks) {
      for (const passage of passages(block.text, document.language, settings)) {
        const textHash = hash(passage.text)
        const ordinal = chunks.length
        chunks.push({
          ...passage,
          id: hash(JSON.stringify([versionKey, ordinal, block.blockIndex, passage.start, passage.end, textHash])),
          textHash,
          ordinal,
          sourceId: source.id,
          disaster: source.disaster,
          reference,
          title,
          language: document.language,
          publicationDate: document.publicationDate,
          sourceContentHash: contentHash,
          blockIndex: block.blockIndex,
          page: block.page,
          heading: block.heading,
        })
      }
    }
  }

  return {
    preprocessingVersion: PREPROCESSING_VERSION,
    sourceContentHash: contentHash,
    cleanedHash,
    blocks,
    chunks,
    flags,
    adapterWarnings: [...document.warnings],
    needsReview: flags.length > 0,
  }
}
