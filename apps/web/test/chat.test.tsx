import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { chatRequestSchema, chatResponseSchema, citationSchema } from '@reliefcheck/contracts'
import { ChatPage } from '../src/pages/ChatPage'

const VALENCIA = '11111111-1111-4111-8111-111111111111'
const JAMAICA = '22222222-2222-4222-8222-222222222222'
const RELEASE = '33333333-3333-4333-8333-333333333333'

const disasters = {
  disasters: [
    { id: VALENCIA, slug: 'valencia-dana', name: 'Valencia DANA floods' },
    { id: JAMAICA, slug: 'hurricane-melissa', name: 'Hurricane Melissa' },
  ],
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function answer(requestId: string, status: 'supported' | 'insufficient_evidence' = 'supported') {
  return {
    requestId,
    snapshot: { releaseId: RELEASE, epoch: 1, asOf: '2026-11-08T16:00:00Z' },
    mode: 'factual',
    status,
    retrievalMode: 'hybrid',
    claims: status === 'supported' ? [{ text: 'Synthetic test answer.', citationIds: ['c1'] }] : [],
    citations: status === 'supported' ? [{
      id: 'c1', sourceVersionId: RELEASE, title: 'Synthetic source', sourceUrl: 'https://example.test/source',
      publicationDate: null, reviewedAt: '2026-11-08T15:00:00Z', locator: 'Section 1',
      excerpt: 'Synthetic evidence excerpt.',
    }] : [],
    limitations: status === 'supported' ? [] : ['No supporting passage was found.'],
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('US02 shared contract proposal', () => {
  it('trims and bounds questions and rejects unsafe source links', () => {
    const request = chatRequestSchema.parse({ requestId: RELEASE, disasterId: VALENCIA, question: '  What happened?  ' })
    expect(request.question).toBe('What happened?')
    expect(chatRequestSchema.safeParse({ ...request, question: ' '.repeat(4) }).success).toBe(false)
    expect(chatRequestSchema.safeParse({ ...request, question: 'x'.repeat(2_001) }).success).toBe(false)
    expect(chatResponseSchema.safeParse(answer(RELEASE)).success).toBe(true)
    expect(chatResponseSchema.safeParse({ ...answer(RELEASE), claims: [{ text: 'Uncited claim', citationIds: [] }] }).success).toBe(false)
    expect(chatResponseSchema.safeParse({ ...answer(RELEASE), status: 'insufficient_evidence' }).success).toBe(false)
    expect(citationSchema.safeParse({ ...answer(RELEASE).citations[0], sourceUrl: 'javascript:alert(1)' }).success).toBe(false)
  })
})

describe('US02 chat page', () => {
  it('reports unavailable disaster data instead of displaying synthetic production choices', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      error: { code: 'NOT_FOUND', message: 'API route not found.', retryable: false }, requestId: RELEASE,
    }, 404)))
    render(<ChatPage />)
    expect(await screen.findByText('Disaster selection is not available on this service yet.')).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Disaster' })).toBeNull()
  })

  it('reports an absent chat endpoint after a disaster list is available', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, options?: RequestInit) => options?.method
      ? Promise.resolve(json({
          error: { code: 'NOT_FOUND', message: 'API route not found.', retryable: false }, requestId: RELEASE,
        }, 404))
      : Promise.resolve(json(disasters))))
    const user = userEvent.setup()
    render(<ChatPage />)
    await screen.findByRole('combobox', { name: 'Disaster' })
    await user.type(screen.getByRole('textbox', { name: 'Your question' }), 'What happened?')
    await user.click(screen.getByRole('button', { name: 'Ask question' }))
    expect(await screen.findByText('Questions are not available on this service yet.')).toBeTruthy()
  })

  it('submits a typed question once and renders an accessible answer', async () => {
    let finishChat: ((response: Response) => void) | undefined
    const fetchMock = vi.fn((_url: string, options?: RequestInit) => {
      if (!options?.method) return Promise.resolve(json(disasters))
      return new Promise<Response>((resolve) => { finishChat = resolve })
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<ChatPage />)
    await screen.findByRole('combobox', { name: 'Disaster' })
    await user.type(screen.getByRole('textbox', { name: 'Your question' }), 'What happened?')
    await user.click(screen.getByRole('button', { name: 'Ask question' }))
    expect(screen.getByRole('button', { name: 'Finding evidence…' }).hasAttribute('disabled')).toBe(true)
    fireEvent.submit(screen.getByRole('button', { name: 'Finding evidence…' }).closest('form')!)
    expect(screen.getByRole('status').textContent).toContain('Finding reviewed evidence')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, options] = fetchMock.mock.calls[1]!
    const sent = JSON.parse(String(options?.body))
    expect(sent.disasterId).toBe(VALENCIA)
    expect(sent.mode).toBe('factual')
    expect(sent.question).toBe('What happened?')
    finishChat?.(json(answer(sent.requestId)))
    const heading = await screen.findByRole('heading', { name: 'Answer from reviewed evidence' })
    expect(heading).toBe(document.activeElement)
    expect(screen.getByText('Synthetic test answer.')).toBeTruthy()
  })

  it('discards an old answer when the selected disaster changes', async () => {
    let finishChat: ((response: Response) => void) | undefined
    const fetchMock = vi.fn((_url: string, options?: RequestInit) => {
      if (!options?.method) return Promise.resolve(json(disasters))
      return new Promise<Response>((resolve) => { finishChat = resolve })
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<ChatPage />)
    await screen.findByRole('combobox', { name: 'Disaster' })
    await user.type(screen.getByRole('textbox', { name: 'Your question' }), 'What happened?')
    await user.click(screen.getByRole('button', { name: 'Ask question' }))
    const [, options] = fetchMock.mock.calls[1]!
    const sent = JSON.parse(String(options?.body))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Disaster' }), JAMAICA)
    expect((options?.signal as AbortSignal).aborted).toBe(true)
    finishChat?.(json(answer(sent.requestId)))
    await waitFor(() => expect(screen.queryByText('Synthetic test answer.')).toBeNull())
    expect(screen.queryByRole('heading', { name: 'Answer from reviewed evidence' })).toBeNull()
  })

  it('shows a typed corpus error and rejects a mismatched response', async () => {
    const fetchMock = vi.fn((_url: string, options?: RequestInit) => {
      if (!options?.method) return Promise.resolve(json(disasters))
      return Promise.resolve(json({
        error: { code: 'CORPUS_UNAVAILABLE', message: 'No corpus.', retryable: false }, requestId: RELEASE,
      }, 503))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<ChatPage />)
    await screen.findByRole('combobox', { name: 'Disaster' })
    await user.type(screen.getByRole('textbox', { name: 'Your question' }), 'What happened?')
    await user.click(screen.getByRole('button', { name: 'Ask question' }))
    expect(await screen.findByText('No reviewed knowledge base is available yet. Please try again after one is published.')).toBeTruthy()
    fetchMock.mockImplementation((_url: string, options?: RequestInit) => options?.method
      ? Promise.resolve(json(answer(RELEASE)))
      : Promise.resolve(json(disasters)))
    await user.click(screen.getByRole('button', { name: 'Ask question' }))
    expect(await screen.findByText('The answer response is invalid.')).toBeTruthy()
  })

  it('rejects answer claims that reference an unknown citation', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, options?: RequestInit) => {
      if (!options?.method) return Promise.resolve(json(disasters))
      const request = JSON.parse(String(options.body))
      const result = answer(request.requestId)
      result.claims[0]!.citationIds = ['unknown']
      return Promise.resolve(json(result))
    }))
    const user = userEvent.setup()
    render(<ChatPage />)
    await screen.findByRole('combobox', { name: 'Disaster' })
    await user.type(screen.getByRole('textbox', { name: 'Your question' }), 'What happened?')
    await user.click(screen.getByRole('button', { name: 'Ask question' }))
    expect(await screen.findByText('The answer response is invalid.')).toBeTruthy()
    expect(screen.queryByText('Synthetic test answer.')).toBeNull()
  })
})
