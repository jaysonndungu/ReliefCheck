import { extractTextFile, type FileInput } from './fileExtract.js'
import { fetchApprovedHtml, type WebFetcher } from './webFetch.js'
import type { ExtractedDocument } from './ingestionTypes.js'
import type { SourceRecord } from '../services/ingestion/manifest.js'
import { preprocessDocument, type ChunkOptions, type PreparedChunk } from '../services/ingestion/preprocess.js'

export type SourceSnapshot = {
  source: SourceRecord
  bytes?: Uint8Array
  filename?: string
  mimeType?: string
  fetcher?: WebFetcher
}

export type PreparedSource = {
  document: ExtractedDocument
  preparation: ReturnType<typeof preprocessDocument>
  chunks: PreparedChunk[]
}

/**
 * Dispatches a validated US05 source record to the correct US06 adapter and
 * immediately passes the typed extraction through the US07 preparation gate.
 * Database/storage writes intentionally remain outside this pure boundary.
 */
export async function ingestSource(snapshot: SourceSnapshot, options: ChunkOptions = {}): Promise<PreparedSource> {
  const { source } = snapshot
  let document: ExtractedDocument

  if (source.reference.kind === 'file') {
    if (!snapshot.bytes || !snapshot.filename || !snapshot.mimeType) {
      throw new Error('File sources require bytes, filename, and MIME type.')
    }
    const input: FileInput = {
      sourceId: source.id,
      bytes: snapshot.bytes,
      filename: snapshot.filename,
      mimeType: snapshot.mimeType,
    }
    document = extractTextFile(input)
  } else {
    document = await fetchApprovedHtml({
      approved: { id: source.id, url: source.reference.url, allowedHost: new URL(source.reference.url).hostname },
      fetcher: snapshot.fetcher,
    })
  }

  const preparation = preprocessDocument(document, source, options)
  return { document, preparation, chunks: preparation.chunks }
}
