import { waitForAbortable } from '../abortable.js'
import { createHash } from 'node:crypto'
import { IngestionInputError, MAX_EXTRACTED_CHARS, MAX_REDIRECTS, MAX_SOURCE_BYTES, type ApprovedSource, type ExtractedDocument } from './ingestionTypes.js'

export type WebResponse = {
  status: number
  headers: Headers
  body?: ReadableStream<Uint8Array> | null
  arrayBuffer(): Promise<ArrayBuffer>
}

export type WebFetcher = (url: string, init: { redirect: 'manual'; signal: AbortSignal }) => Promise<WebResponse>

export type WebFetchOptions = {
  approved: ApprovedSource
  fetcher?: WebFetcher
  timeoutMs?: number
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/u, '')
}

function validateHttpsUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new IngestionInputError('INVALID_SOURCE_URL', 'The approved source URL is invalid.')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new IngestionInputError('INVALID_SOURCE_URL', 'Approved sources must use HTTPS without credentials or custom ports.')
  }
  return url
}

function assertApproved(url: URL, approved: ApprovedSource): void {
  if (normalizeHost(url.hostname) !== normalizeHost(approved.allowedHost)) {
    throw new IngestionInputError('SOURCE_HOST_NOT_APPROVED', 'Redirects must remain on the approved source hostname.')
  }
}

function parseContentType(headers: Headers): string {
  return (headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
}

async function readBody(response: WebResponse, signal: AbortSignal): Promise<Uint8Array> {
  const limitError = () => new IngestionInputError(
    'SOURCE_TOO_LARGE', `Fetched sources must be at most ${MAX_SOURCE_BYTES} bytes.`,
  )
  if (Number(response.headers.get('content-length')) > MAX_SOURCE_BYTES) throw limitError()
  if (!response.body) {
    const bytes = new Uint8Array(await waitForAbortable(response.arrayBuffer(), signal))
    if (bytes.byteLength > MAX_SOURCE_BYTES) throw limitError()
    return bytes
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let complete = false
  try {
    while (true) {
      const chunk = await waitForAbortable(reader.read(), signal)
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_SOURCE_BYTES) throw limitError()
      chunks.push(chunk.value)
    }
    complete = true
  } finally {
    if (!complete) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function fetchApprovedHtml(options: WebFetchOptions): Promise<ExtractedDocument> {
  const fetcher = options.fetcher ?? fetch
  let url = validateHttpsUrl(options.approved.url)
  assertApproved(url, options.approved)

  const controller = new AbortController()
  const { signal } = controller
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000)
  try {
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      signal.throwIfAborted()
      const response = await waitForAbortable(fetcher(url.toString(), { redirect: 'manual', signal }), signal)

      if (response.status >= 300 && response.status < 400) {
        if (response.body) void response.body.cancel().catch(() => {})
        const location = response.headers.get('location')
        if (!location || redirectCount === MAX_REDIRECTS) {
          throw new IngestionInputError('TOO_MANY_REDIRECTS', 'The approved source exceeded the redirect limit.')
        }
        if (!URL.canParse(location, url)) {
          throw new IngestionInputError('INVALID_SOURCE_URL', 'The approved source returned an invalid redirect URL.')
        }
        url = validateHttpsUrl(new URL(location, url).toString())
        assertApproved(url, options.approved)
        continue
      }
      if (response.status < 200 || response.status >= 300) {
        throw new IngestionInputError('SOURCE_FETCH_FAILED', `The approved source returned HTTP ${response.status}.`)
      }
      if (parseContentType(response.headers) !== 'text/html') {
        throw new IngestionInputError('UNSUPPORTED_SOURCE_TYPE', 'The approved web source must return text/html.')
      }

      const bytes = await readBody(response, signal)
      const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
      const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)?.[1]?.replace(/<[^>]+>/gu, '').trim() || url.hostname
      const text = html
        .replace(/<script[\s\S]*?<\/script>/giu, ' ')
        .replace(/<style[\s\S]*?<\/style>/giu, ' ')
        .replace(/<[^>]+>/gu, ' ')
        .replace(/&nbsp;/giu, ' ')
        .replace(/&amp;/giu, '&')
        .replace(/\s+/gu, ' ')
        .trim()
      if (!text) throw new IngestionInputError('EMPTY_EXTRACTION', 'No readable text could be extracted from the source.')
      if (text.length > MAX_EXTRACTED_CHARS) {
        throw new IngestionInputError('EXTRACTED_TEXT_TOO_LARGE', `Extracted text must be at most ${MAX_EXTRACTED_CHARS} characters.`)
      }
      return {
        sourceId: options.approved.id,
        contentHash: createHash('sha256').update(bytes).digest('hex'),
        title,
        language: null,
        publicationDate: null,
        retrievedAt: new Date().toISOString(),
        blocks: [{ text, page: null, heading: null }],
        warnings: ['HTML extraction is intentionally conservative; review the extracted preview before approval.'],
      }
    }
  } catch (error) {
    if (error instanceof IngestionInputError) throw error
    throw new IngestionInputError(
      signal.aborted ? 'SOURCE_FETCH_TIMEOUT' : 'SOURCE_FETCH_FAILED',
      signal.aborted ? 'The approved source took too long to respond.' : 'The approved source could not be fetched.',
    )
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  throw new IngestionInputError('SOURCE_FETCH_FAILED', 'The approved source could not be fetched.')
}
