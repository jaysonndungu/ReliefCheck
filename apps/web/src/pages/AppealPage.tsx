import { useEffect, useRef, useState, type FormEvent } from 'react'
import { appealReviewRequestSchema, type AppealReviewResponse, type Disaster } from '@reliefcheck/contracts'
import { getDisasters } from '../features/chat/chatApi'
import { reviewAppeal } from '../features/appeals/appealApi'
import { AppealResultView } from '../features/appeals/AppealResultView'
import { ApiError } from '../lib/api'

type LoadState = 'loading' | 'ready' | 'unavailable'
type ReviewState = 'idle' | 'loading' | 'result' | 'error'

function errorText(error: unknown, kind: 'disasters' | 'review'): string {
  if (!(error instanceof ApiError)) return 'The service could not be reached. Please try again.'
  if (error.code === 'NOT_FOUND' || error.code === 'APPEAL_REVIEW_UNAVAILABLE') {
    return kind === 'disasters' ? 'Disaster selection is not available yet.' : 'Appeal review is not available on this service yet.'
  }
  if (error.code === 'CORPUS_UNAVAILABLE') return 'No reviewed knowledge base is published yet.'
  if (error.code === 'KB_CHANGED') return 'The published evidence changed. Submit the appeal again.'
  return error.message
}

export function AppealPage() {
  const [loadKey, setLoadKey] = useState(0)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [loadError, setLoadError] = useState('')
  const [disasters, setDisasters] = useState<Disaster[]>([])
  const [disasterId, setDisasterId] = useState('')
  const [input, setInput] = useState('')
  const [state, setState] = useState<ReviewState>('idle')
  const [review, setReview] = useState<AppealReviewResponse | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const sequence = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const submitting = useRef(false)
  const heading = useRef<HTMLHeadingElement | null>(null)

  useEffect(() => { document.title = 'Check an Appeal · ReliefCheck' }, [])
  useEffect(() => {
    const request = new AbortController()
    setLoadState('loading')
    void getDisasters(request.signal).then(
      (items) => {
        if (request.signal.aborted) return
        setDisasters(items)
        setDisasterId((previous) => items.some((item) => item.id === previous) ? previous : (items[0]?.id ?? ''))
        setLoadState(items.length ? 'ready' : 'unavailable')
        if (!items.length) setLoadError('No disasters are available in the reviewed dataset.')
      },
      (failure: unknown) => {
        if (request.signal.aborted) return
        setLoadError(errorText(failure, 'disasters'))
        setLoadState('unavailable')
      },
    )
    return () => request.abort()
  }, [loadKey])
  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => {
    function clearOnReturn() {
      if (document.visibilityState !== 'visible' || !review) return
      clearResult()
      setNotice('The prior review was cleared because published evidence may have changed. Submit again for current evidence.')
    }
    document.addEventListener('visibilitychange', clearOnReturn)
    return () => document.removeEventListener('visibilitychange', clearOnReturn)
  }, [review])
  useEffect(() => { if (state === 'result' || state === 'error') heading.current?.focus() }, [state])

  function clearResult() {
    sequence.current += 1
    controller.current?.abort()
    controller.current = null
    submitting.current = false
    setReview(null)
    setError('')
    setState('idle')
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current || loadState !== 'ready') return
    const parsed = appealReviewRequestSchema.safeParse({ requestId: crypto.randomUUID(), disasterId, input })
    if (!parsed.success) {
      setError('Select a disaster and enter a URL or appeal text of at most 4,000 characters.')
      setState('error')
      return
    }
    submitting.current = true
    controller.current?.abort()
    const active = new AbortController()
    controller.current = active
    const current = ++sequence.current
    setNotice('')
    setReview(null)
    setError('')
    setState('loading')
    try {
      const response = await reviewAppeal(parsed.data, active.signal)
      if (active.signal.aborted || current !== sequence.current) return
      setReview(response)
      setState('result')
    } catch (failure) {
      if (active.signal.aborted || current !== sequence.current) return
      setError(errorText(failure, 'review'))
      setState('error')
    } finally {
      if (current === sequence.current) {
        submitting.current = false
        controller.current = null
      }
    }
  }

  return (
    <section className="appeal-page" aria-labelledby="page-title">
      <h1 id="page-title">Check an Appeal</h1>
      <p className="lead">Compare a donation link or appeal message with reviewed channels and published warnings.</p>
      <p className="notice">This is an evidence review, not a safety certification. Do not enter personal or payment information. Submitted links are not opened.</p>
      {loadState === 'loading' ? <p role="status">Loading disasters…</p> : null}
      {loadState === 'unavailable' ? <div className="chat-message" role="alert"><p>{loadError}</p>
        <button type="button" className="button button-secondary" onClick={() => setLoadKey((key) => key + 1)}>Retry disaster list</button>
      </div> : null}
      {loadState === 'ready' ? (
        <form className="chat-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="appeal-disaster">Disaster</label>
          <select id="appeal-disaster" value={disasterId} onChange={(event) => {
            clearResult(); setNotice(''); setDisasterId(event.target.value)
          }}>{disasters.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          <label htmlFor="appeal-input">Donation URL or appeal text</label>
          <textarea id="appeal-input" rows={5} maxLength={4_000} required value={input}
            onChange={(event) => { clearResult(); setNotice(''); setInput(event.target.value) }}
            aria-describedby="appeal-help" placeholder="Paste one donation URL or an appeal message" />
          <p id="appeal-help" className="form-help">Up to 4,000 characters. Multiple links receive an insufficient overall result with per-link evidence.</p>
          <button type="submit" className="button" disabled={state === 'loading' || !input.trim()}>
            {state === 'loading' ? 'Reviewing evidence…' : 'Review appeal'}
          </button>
        </form>
      ) : null}
      {notice ? <p role="status" className="notice">{notice}</p> : null}
      {state === 'loading' ? <p role="status" className="chat-message">Checking reviewed records…</p> : null}
      {state === 'error' ? <section className="chat-message" role="alert" aria-labelledby="review-heading">
        <h2 id="review-heading" ref={heading} tabIndex={-1}>Appeal review unavailable</h2><p>{error}</p>
      </section> : null}
      {state === 'result' && review ? <section className="chat-result" aria-labelledby="review-heading" aria-live="polite">
        <h2 id="review-heading" ref={heading} tabIndex={-1}>Evidence review</h2>
        <AppealResultView review={review} />
      </section> : null}
    </section>
  )
}
