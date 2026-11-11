import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import type { Citation } from '@reliefcheck/contracts'
import { CitationList, CitationReferences } from '../src/features/sources/CitationList'
import { SourcePage } from '../src/pages/SourcePage'
import { ChatPage } from '../src/pages/ChatPage'

const SOURCE_A = '11111111-1111-4111-8111-111111111111'
const SOURCE_B = '22222222-2222-4222-8222-222222222222'
const RELEASE = '33333333-3333-4333-8333-333333333333'
const DISASTER_A = '44444444-4444-4444-8444-444444444444'
const DISASTER_B = '55555555-5555-4555-8555-555555555555'
const snapshot = { releaseId: RELEASE, epoch: 3, asOf: '2026-11-08T17:00:00Z' }

const citations: Citation[] = [
  {
    id: 'a', sourceVersionId: SOURCE_A, title: 'Synthetic public notice',
    sourceUrl: 'https://example.test/source', publicationDate: '2025-10-31',
    reviewedAt: '2026-11-08T16:00:00Z', locator: 'Section 2', excerpt: 'Exact public excerpt.',
  },
  {
    id: 'b', sourceVersionId: SOURCE_B, title: 'Synthetic private upload',
    sourceUrl: null, publicationDate: null,
    reviewedAt: '2026-11-08T16:00:00Z', locator: 'Page 4', excerpt: '<img src=x onerror=alert(1)>',
  },
]

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function renderSource(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/sources/:sourceVersionId" element={<SourcePage />} />
  </Routes></MemoryRouter>)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('US04 citation display', () => {
  it('links each claim reference to its exact card and exposes separate source dates', async () => {
    const user = userEvent.setup()
    render(<><p>Claim <CitationReferences citationIds={['b', 'a']} citations={citations} /></p>
      <CitationList citations={citations} snapshot={snapshot} /></>)
    const second = screen.getByRole('link', { name: 'Source 2: Synthetic private upload' })
    const first = screen.getByRole('link', { name: 'Source 1: Synthetic public notice' })
    expect(second.getAttribute('href')).toBe('#answer-source-2')
    expect(first.getAttribute('href')).toBe('#answer-source-1')
    await user.tab()
    expect(document.activeElement).toBe(second)
    expect(screen.getByText('2025-10-31')).toBeTruthy()
    expect(screen.getByText('Date unavailable')).toBeTruthy()
    expect(screen.getAllByText('2026-11-08 UTC')).toHaveLength(2)
    expect(screen.getByText('Page 4')).toBeTruthy()
    const publicLink = screen.getByRole('link', { name: 'Open original source' })
    expect(publicLink.getAttribute('rel')).toBe('noopener noreferrer')
    expect(publicLink.getAttribute('target')).toBe('_blank')
    expect(screen.getByRole('link', { name: 'Open public evidence excerpt' }).getAttribute('href'))
      .toBe(`/sources/${SOURCE_B}?releaseId=${RELEASE}&epoch=3`)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy()
  })

  it('marks missing or ambiguous citation IDs without attaching another source', () => {
    render(<><CitationReferences citationIds={['missing', 'a']} citations={citations} />
      <CitationReferences citationIds={['a']} citations={[citations[0]!, citations[0]!]} />
      <CitationList citations={[]} snapshot={snapshot} /></>)
    expect(screen.getAllByText('Source reference unavailable')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Source 1: Synthetic public notice' }).getAttribute('href'))
      .toBe('#answer-source-1')
    expect(screen.getByText('No supporting sources were returned for this answer.')).toBeTruthy()
  })

  it('does not make an unsafe original URL clickable', () => {
    render(<CitationList citations={[{ ...citations[0]!, sourceUrl: 'javascript:alert(1)' }]} snapshot={snapshot} />)
    expect(screen.queryByRole('link', { name: 'Open original source' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Open public evidence excerpt' })).toBeNull()
    expect(screen.getByText('Original source link unavailable')).toBeTruthy()
  })

  it('clears a displayed answer and its sources when the disaster changes', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, options?: RequestInit) => {
      if (!options?.method) return Promise.resolve(json({ disasters: [
        { id: DISASTER_A, slug: 'valencia-dana', name: 'Valencia' },
        { id: DISASTER_B, slug: 'hurricane-melissa', name: 'Melissa' },
      ] }))
      const { requestId } = JSON.parse(String(options.body))
      return Promise.resolve(json({
        requestId, snapshot, mode: 'factual', status: 'supported', retrievalMode: 'hybrid',
        claims: [{ text: 'Synthetic answer.', citationIds: ['a'] }], citations: [citations[0]], limitations: [],
      }))
    }))
    const user = userEvent.setup()
    render(<ChatPage />)
    await screen.findByRole('combobox', { name: 'Disaster' })
    await user.type(screen.getByRole('textbox', { name: 'Your question' }), 'What happened?')
    await user.click(screen.getByRole('button', { name: 'Ask question' }))
    expect(await screen.findByRole('link', { name: 'Source 1: Synthetic public notice' })).toBeTruthy()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Disaster' }), DISASTER_B)
    expect(screen.queryByText('Synthetic answer.')).toBeNull()
    expect(screen.queryByText('Exact public excerpt.')).toBeNull()
  })
})

describe('US04 public source page', () => {
  it('renders only typed public evidence and focuses its heading', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      snapshot, sourceVersionId: SOURCE_B, title: 'Synthetic private upload', sourceUrl: null,
      publicationDate: null, reviewedAt: '2026-11-08T16:00:00Z',
      excerpts: [{ locator: 'Page 4', excerpt: '<script>plain text</script>' }],
      privateObjectKey: 'must not display',
    }))
    vi.stubGlobal('fetch', fetchMock)
    renderSource(`/sources/${SOURCE_B}?releaseId=${RELEASE}&epoch=3`)
    const heading = await screen.findByRole('heading', { name: 'Synthetic private upload' })
    expect(document.activeElement).toBe(heading)
    expect(screen.getByText('<script>plain text</script>')).toBeTruthy()
    expect(screen.queryByText('must not display')).toBeNull()
    expect(screen.getByText('Date unavailable')).toBeTruthy()
    expect(screen.getByText(/original upload is private/i)).toBeTruthy()
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`releaseId=${RELEASE}&epoch=3`)
  })

  it('reports unavailable evidence and a changed snapshot without showing stale excerpts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      error: { code: 'SOURCE_EVIDENCE_UNAVAILABLE', message: 'Not configured.', retryable: true },
      requestId: SOURCE_A,
    }, 503)))
    const view = renderSource(`/sources/${SOURCE_A}`)
    expect(await screen.findByText('The public evidence page is not available on this service yet.')).toBeTruthy()
    view.unmount()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      error: { code: 'KB_CHANGED', message: 'Changed.', retryable: true }, requestId: SOURCE_A,
    }, 409)))
    renderSource(`/sources/${SOURCE_A}?releaseId=${RELEASE}&epoch=3`)
    expect(await screen.findByText('The published evidence changed. Return to your answer and ask again.')).toBeTruthy()
    expect(screen.queryByText('Exact public excerpt.')).toBeNull()
  })

  it('clears an open source page while rechecking evidence after returning to the tab', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        snapshot, sourceVersionId: SOURCE_A, title: 'Reviewed source', sourceUrl: null,
        publicationDate: null, reviewedAt: '2026-11-08T16:00:00Z',
        excerpts: [{ locator: 'Page 1', excerpt: 'Previously published evidence.' }],
      }))
    let finish!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    try {
      renderSource(`/sources/${SOURCE_A}?releaseId=${RELEASE}&epoch=3`)
      await screen.findByText('Previously published evidence.')
      act(() => { document.dispatchEvent(new Event('visibilitychange')) })
      expect(screen.queryByText('Previously published evidence.')).toBeNull()
      expect(screen.getByText('Loading source evidence…')).toBeTruthy()
      finish(json({
        error: { code: 'KB_CHANGED', message: 'Changed.', retryable: true }, requestId: SOURCE_A,
      }, 409))
      await screen.findByRole('heading', { name: 'Source unavailable' })
      expect(screen.queryByText('Previously published evidence.')).toBeNull()
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('rejects a response for a different source version', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      snapshot, sourceVersionId: SOURCE_B, title: 'Wrong source', sourceUrl: null,
      publicationDate: null, reviewedAt: '2026-11-08T16:00:00Z',
      excerpts: [{ locator: 'Page 1', excerpt: 'Wrong excerpt' }],
    })))
    renderSource(`/sources/${SOURCE_A}`)
    await waitFor(() => expect(screen.getByText('The source response is invalid.')).toBeTruthy())
    expect(screen.queryByText('Wrong excerpt')).toBeNull()
  })
})
