/**
 * Adapter output shared by file and approved-web ingestion.
 * Adapters only extract and validate input; persistence and review happen later.
 */
export type ExtractedBlock = {
  text: string
  page: number | null
  heading: string | null
}

export type ExtractedDocument = {
  sourceId: string
  contentHash: string
  title: string
  language: string | null
  publicationDate: string | null
  retrievedAt: string
  blocks: ExtractedBlock[]
  warnings: string[]
}

export type ApprovedSource = {
  id: string
  url: string
  allowedHost: string
}

export const MAX_SOURCE_BYTES = 2 * 1024 * 1024
export const MAX_EXTRACTED_CHARS = 100_000
export const MAX_REDIRECTS = 3

export class IngestionInputError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'IngestionInputError'
    this.code = code
  }
}
