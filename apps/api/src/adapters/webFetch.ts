import { createHash } from 'node:crypto'
import { IngestionInputError, MAX_EXTRACTED_CHARS, MAX_REDIRECTS, MAX_SOURCE_BYTES, type ApprovedSource, type ExtractedDocument } from './ingestionTypes.js'

export type WebResponse = {
  status: number
  headers: Headers
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

export async function fetchApprovedHtml(options: WebFetchOptions): Promise<ExtractedDocument> {
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init) as Promise<WebResponse>)
  const timeoutMs = options.timeoutMs ?? 10_000
  let url = validateHttpsUrl(options.approved.url)
  assertApproved(url, options.approved)

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: WebResponse
    try {
      response = await fetcher(url.toString(), { redirect: 'manual', signal: controller.signal })
    } catch (error) {
      throw new IngestionInputError('SOURCE_FETCH_FAILED', error instanceof Error ? error.message : 'The approved source could not be fetched.')
    } finally {
      clearTimeout(timer)
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location || redirectCount === MAX_REDIRECTS) {
        throw new IngestionInputError('TOO_MANY_REDIRECTS', 'The approved source exceeded the redirect limit.')
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

    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_SOURCE_BYTES) {
      throw new IngestionInputError('SOURCE_TOO_LARGE', `Fetched sources must be at most ${MAX_SOURCE_BYTES} bytes.`)
    }
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
  throw new IngestionInputError('SOURCE_FETCH_FAILED', 'The approved source could not be fetched.')
}
