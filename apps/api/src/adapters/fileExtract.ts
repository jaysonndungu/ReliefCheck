import { createHash } from 'node:crypto'
import { IngestionInputError, MAX_EXTRACTED_CHARS, MAX_SOURCE_BYTES, type ExtractedDocument } from './ingestionTypes.js'

export type FileInput = {
  sourceId: string
  bytes: Uint8Array
  filename: string
  mimeType: string
  retrievedAt?: string
}

const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/x-markdown',
])

function normalizeText(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\t ]+/g, ' ').trim()
}

function splitBlocks(text: string): Array<{ text: string; page: null; heading: string | null }> {
  return text
    .split(/\n\s*\n/u)
    .map(normalizeText)
    .filter(Boolean)
    .map(block => ({ text: block, page: null, heading: null }))
}

function validateInput(input: FileInput): void {
  if (input.bytes.byteLength === 0) {
    throw new IngestionInputError('EMPTY_FILE', 'The uploaded file is empty.')
  }
  if (input.bytes.byteLength > MAX_SOURCE_BYTES) {
    throw new IngestionInputError('FILE_TOO_LARGE', `Files must be at most ${MAX_SOURCE_BYTES} bytes.`)
  }
  if (!TEXT_MIME_TYPES.has(input.mimeType.toLowerCase())) {
    throw new IngestionInputError(
      'UNSUPPORTED_FILE_TYPE',
      'Only UTF-8 TXT and Markdown files are supported by this adapter slice.',
    )
  }
  if (!/\.(?:txt|md|markdown)$/iu.test(input.filename)) {
    throw new IngestionInputError('UNSUPPORTED_FILE_TYPE', 'The filename must end in .txt, .md, or .markdown.')
  }
}

export function extractTextFile(input: FileInput): ExtractedDocument {
  validateInput(input)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes).replace(/^\uFEFF/u, '')
  const normalizedText = normalizeText(text)
  if (!normalizedText) {
    throw new IngestionInputError('EMPTY_EXTRACTION', 'No text could be extracted from the file.')
  }
  if (normalizedText.length > MAX_EXTRACTED_CHARS) {
    throw new IngestionInputError('EXTRACTED_TEXT_TOO_LARGE', `Extracted text must be at most ${MAX_EXTRACTED_CHARS} characters.`)
  }

  return {
    sourceId: input.sourceId,
    contentHash: createHash('sha256').update(input.bytes).digest('hex'),
    title: input.filename.replace(/\.(?:txt|md|markdown)$/iu, ''),
    language: null,
    publicationDate: null,
    retrievedAt: input.retrievedAt ?? new Date().toISOString(),
    blocks: splitBlocks(text),
    warnings: [],
  }
}
