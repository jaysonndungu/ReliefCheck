import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { appealReviewResponseSchema } from '@reliefcheck/contracts'
import { App } from '../src/App'
import { AppealPage } from '../src/pages/AppealPage'
import { AppealResultView } from '../src/features/appeals/AppealResultView'

const DISASTER_A = '11111111-1111-4111-8111-111111111111'
const DISASTER_B = '22222222-2222-4222-8222-222222222222'
const RELEASE = '33333333-3333-4333-8333-333333333333'
const RECORD = '44444444-4444-4444-8444-444444444444'
const SOURCE = '55555555-5555-4555-8555-555555555555'
const WARNING = '66666666-6666-4666-8666-666666666666'
const disasters = { disasters: [
  { id: DISASTER_A, slug: 'valencia-dana', name: 'Valencia DANA floods' },
  { id: DISASTER_B, slug: 'hurricane-melissa', name: 'Hurricane Melissa' },
] }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function review(requestId: string, status: 'documented_official_channel' | 'published_warning_found' | 'insufficient_evidence' = 'documented_official_channel') {
  const isUnknown = status === 'insufficient_evidence'
  const reasonCodes = status === 'documented_official_channel' ? ['MATCHED_OFFICIAL']
    : status === 'published_warning_found' ? ['MATCHED_WARNING'] : ['UNKNOWN_HOST']
  const match = {
    recordVersionId: RECORD, kind: status === 'published_warning_found' ? 'warning' : 'campaign',
    title: status === 'published_warning_found' ? 'Synthetic warning' : 'Synthetic campaign',
    organizationName: status === 'published_warning_found' ? null : 'Synthetic Organization',
    scope: 'host', officialChannelUrl: status === 'published_warning_found' ? null : 'https://official.test/donate',
    publicationDate: status === 'published_warning_found' ? '2025-10-31' : null,
    reviewedAt: '2026-11-08T16:00:00Z', historical: false, retracted: false,
    citationIds: ['c1'],
  }
  const result = { status, reasonCodes, targetHost: 'official.test', scope: isUnknown ? null : 'host',
    matchedRecordIds: isUnknown ? [] : [RECORD], citationIds: isUnknown ? [] : ['c1'],
    historical: false, conflict: false }
  return {
    requestId, snapshot: { releaseId: RELEASE, epoch: 2, asOf: '2026-11-08T17:00:00Z' }, result,
    targets: [{ targetHost: 'official.test', result, matches: isUnknown ? [] : [match] }],
    citations: isUnknown ? [] : [{ id: 'c1', sourceVersionId: SOURCE, title: 'Synthetic source', sourceUrl: null,
      publicationDate: status === 'published_warning_found' ? '2025-11-01' : null,
      reviewedAt: '2026-11-08T15:00:00Z', locator: 'Page 2', excerpt: '<script>source text</script>' }],
  }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('US13 appeal flow', () => {
  it('keeps conflicting records visible without endorsing a channel destination', () => {
    const response = review(RELEASE)
    const target = response.targets[0]!
    const warning = review(RELEASE, 'published_warning_found').targets[0]!.matches[0]!
    target.matches.push({ ...warning, recordVersionId: WARNING })
    response.result.status = 'insufficient_evidence'
    response.result.reasonCodes = ['CONFLICTING_RECORDS']
    response.result.matchedRecordIds.push(WARNING)
    response.result.conflict = true
    render(<AppealResultView review={appealReviewResponseSchema.parse(response)} />)
    expect(screen.getByText('Insufficient evidence')).toBeTruthy()
    expect(screen.getByText(/records conflict/i)).toBeTruthy()
    expect(screen.getByText('Synthetic Organization')).toBeTruthy()
    expect(screen.getByText('Synthetic warning')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Open reviewed channel destination' })).toBeNull()
  })

  it('shows unavailable disaster selection without supplying production fixtures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      error: { code: 'NOT_FOUND', message: 'Missing', retryable: false }, requestId: RELEASE,
    }, 404)))
    render(<AppealPage />)
    expect(await screen.findByText('Disaster selection is not available yet.')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Donation URL or appeal text' })).toBeNull()
  })

  it('opens the appeal form from primary navigation', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(
      json(url === '/api/v1/health/live' ? { status: 'ok' } : disasters),
    )))
    render(<MemoryRouter initialEntries={['/about']}><App /></MemoryRouter>)

    const user = userEvent.setup()
    const link = screen.getByRole('link', { name: 'Check an Appeal' })
    expect(link.getAttribute('href')).toBe('/appeal')
    await user.click(link)

    expect(screen.getByRole('heading', { name: 'Check an Appeal' })).toBeTruthy()
    expect(await screen.findByRole('combobox', { name: 'Disaster' })).toBeTruthy()
    expect(link.getAttribute('aria-current')).toBe('page')
  })

  it('loads /appeal directly and submits for a documented channel with citations and dates', async () => {
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (url === '/api/v1/health/live') return Promise.resolve(json({ status: 'ok' }))
      if (!options?.method) return Promise.resolve(json(disasters))
      const request = JSON.parse(String(options.body))
      return Promise.resolve(json(review(request.requestId)))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<MemoryRouter initialEntries={['/appeal']}><App /></MemoryRouter>)
    await screen.findByRole('combobox', { name: 'Disaster' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Disaster' }), DISASTER_B)
    await user.type(screen.getByRole('textbox', { name: 'Donation URL or appeal text' }), 'https://official.test')
    await user.click(screen.getByRole('button', { name: 'Review appeal' }))
    const heading = await screen.findByRole('heading', { name: 'Evidence review' })
    expect(heading).toBe(document.activeElement)
    expect(screen.getByText('Documented official channel')).toBeTruthy()
    expect(screen.getByText('Synthetic Organization')).toBeTruthy()
    expect(screen.getAllByText('Date unavailable').length).toBeGreaterThan(0)
    expect(screen.getByText(/does not guarantee/i)).toBeTruthy()
    const source = screen.getByRole('link', { name: 'Source 1: Synthetic source' })
    expect(source.getAttribute('href')).toBe('#answer-source-1')
    expect(screen.getByRole('link', { name: 'Open public evidence excerpt' }).getAttribute('href'))
      .toBe(`/sources/${SOURCE}?releaseId=${RELEASE}&epoch=2`)
    expect(screen.getByText('<script>source text</script>')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'https://official.test' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/appeals/review', expect.objectContaining({
      method: 'POST',
      body: expect.any(String),
    }))
    const submission = fetchMock.mock.calls.find(([url]) => url === '/api/v1/appeals/review')
    expect(JSON.parse(String(submission?.[1]?.body))).toMatchObject({
      disasterId: DISASTER_B,
      input: 'https://official.test',
    })
  })

  it('shows warning context and distinguishes insufficient evidence from a service failure', async () => {
    let status: 'published_warning_found' | 'insufficient_evidence' = 'published_warning_found'
    const fetchMock = vi.fn((_url: string, options?: RequestInit) => {
      if (!options?.method) return Promise.resolve(json(disasters))
      const request = JSON.parse(String(options.body))
      return Promise.resolve(json(review(request.requestId, status)))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<AppealPage />)
    await screen.findByRole('combobox', { name: 'Disaster' })
    const field = screen.getByRole('textbox', { name: 'Donation URL or appeal text' })
    await user.type(field, 'official.test')
    await user.click(screen.getByRole('button', { name: 'Review appeal' }))
    expect(await screen.findByText('Published warning found')).toBeTruthy()
    expect(screen.getByText(/does not establish a present-day fraud finding/i)).toBeTruthy()
    const record = within(screen.getByRole('heading', { name: 'Synthetic warning' }).closest('article')!)
    expect(record.getByText('2025-10-31').parentElement?.textContent).toBe('Published: 2025-10-31')
    expect(record.getByText('2026-11-08 UTC').parentElement?.textContent).toBe('Reviewed: 2026-11-08 UTC')
    const source = within(screen.getByRole('heading', { name: '[1] Synthetic source' }).closest('article')!)
    expect(source.getByText('2025-11-01').parentElement?.textContent).toBe('Published: 2025-11-01')
    expect(source.getByText('2026-11-08 UTC').parentElement?.textContent).toBe('Reviewed: 2026-11-08 UTC')
    status = 'insufficient_evidence'
    await user.clear(field)
    await user.type(field, 'unknown.test')
    await user.click(screen.getByRole('button', { name: 'Review appeal' }))
    expect(await screen.findByText('Insufficient evidence')).toBeTruthy()
    expect(screen.getByText(/not a finding that it is fraudulent/i)).toBeTruthy()
    expect(screen.queryByText('Synthetic warning')).toBeNull()
  })

  it('reports an unconfigured review service as an error, not insufficient evidence', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, options?: RequestInit) => options?.method
      ? Promise.resolve(json({ error: { code: 'APPEAL_REVIEW_UNAVAILABLE', message: 'Unavailable', retryable: true }, requestId: RELEASE }, 503))
      : Promise.resolve(json(disasters))))
    const user = userEvent.setup()
    render(<AppealPage />)
    await screen.findByRole('combobox', { name: 'Disaster' })
    await user.type(screen.getByRole('textbox', { name: 'Donation URL or appeal text' }), 'official.test')
    await user.click(screen.getByRole('button', { name: 'Review appeal' }))
    expect(await screen.findByText('Appeal review is not available on this service yet.')).toBeTruthy()
    expect(screen.queryByText('Insufficient evidence')).toBeNull()
  })

  it('clears stale results when input or disaster changes and ignores an older response', async () => {
    let finish: ((value: Response) => void) | undefined
    const fetchMock = vi.fn((_url: string, options?: RequestInit) => {
      if (!options?.method) return Promise.resolve(json(disasters))
      return new Promise<Response>((resolve) => { finish = resolve })
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<AppealPage />)
    await screen.findByRole('combobox', { name: 'Disaster' })
    const field = screen.getByRole('textbox', { name: 'Donation URL or appeal text' })
    await user.type(field, 'official.test')
    await user.click(screen.getByRole('button', { name: 'Review appeal' }))
    expect(screen.getByRole('button', { name: 'Reviewing evidence…' }).hasAttribute('disabled')).toBe(true)
    const [, options] = fetchMock.mock.calls[1]!
    const requestId = JSON.parse(String(options?.body)).requestId
    await user.type(field, 'x')
    expect((options?.signal as AbortSignal).aborted).toBe(true)
    finish?.(json(review(requestId)))
    await waitFor(() => expect(screen.queryByText('Documented official channel')).toBeNull())
    await user.selectOptions(screen.getByRole('combobox', { name: 'Disaster' }), DISASTER_B)
    expect(screen.queryByText('Synthetic Organization')).toBeNull()
  })

  it('does not let an older request replace a newer review result', async () => {
    const pending: Array<{ requestId: string; resolve: (value: Response) => void }> = []
    vi.stubGlobal('fetch', vi.fn((_url: string, options?: RequestInit) => {
      if (!options?.method) return Promise.resolve(json(disasters))
      const requestId = JSON.parse(String(options.body)).requestId
      return new Promise<Response>((resolve) => pending.push({ requestId, resolve }))
    }))
    const user = userEvent.setup()
    render(<AppealPage />)
    await screen.findByRole('combobox', { name: 'Disaster' })
    const field = screen.getByRole('textbox', { name: 'Donation URL or appeal text' })
    await user.type(field, 'official.test')
    await user.click(screen.getByRole('button', { name: 'Review appeal' }))
    await user.clear(field)
    await user.type(field, 'unknown.test')
    await user.click(screen.getByRole('button', { name: 'Review appeal' }))
    pending[1]!.resolve(json(review(pending[1]!.requestId, 'insufficient_evidence')))
    expect(await screen.findByText('Insufficient evidence')).toBeTruthy()
    pending[0]!.resolve(json(review(pending[0]!.requestId)))
    await waitFor(() => expect(screen.getByText('Insufficient evidence')).toBeTruthy())
    expect(screen.queryByText('Documented official channel')).toBeNull()
  })

  it('requires input and bounds its length', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(disasters)))
    render(<AppealPage />)
    await screen.findByRole('combobox', { name: 'Disaster' })
    const field = screen.getByRole('textbox', { name: 'Donation URL or appeal text' })
    expect(field.getAttribute('maxlength')).toBe('4000')
    expect(screen.getByRole('button', { name: 'Review appeal' }).hasAttribute('disabled')).toBe(true)
  })
})
