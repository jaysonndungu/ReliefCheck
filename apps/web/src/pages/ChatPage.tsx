import { useEffect, useRef, useState, type FormEvent } from 'react'
import { chatRequestSchema, type ChatResponse, type Disaster } from '@reliefcheck/contracts'
import { askQuestion, getCorpusSnapshot, getDisasters } from '../features/chat/chatApi'
import { CitationList, CitationReferences } from '../features/sources/CitationList'
import { ApiError } from '../lib/api'

type LoadState = 'loading' | 'ready' | 'unavailable'
type AnswerState = 'idle' | 'loading' | 'result' | 'error'
type Freshness = 'unchanged' | 'older' | 'unpublished' | 'unknown'

const FRESHNESS_NOTICES: Record<Freshness, string> = {
  unchanged: '',
  older: 'This answer is from an older evidence release. Ask again to check for current reviewed evidence.',
  unpublished: 'This answer is from an older evidence release. Ask again after reviewed evidence is published.',
  unknown: 'Could not check whether the reviewed evidence has changed. Ask again to retry.',
}

function friendlyError(error: unknown, action: 'disasters' | 'chat'): string {
  if (error instanceof ApiError) {
    if (error.code === 'NOT_FOUND') {
      return action === 'disasters'
        ? 'Disaster selection is not available on this service yet.'
        : 'Questions are not available on this service yet.'
    }
    if (error.code === 'CORPUS_UNAVAILABLE' || error.code === 'DATABASE_UNCONFIGURED') {
      return 'No reviewed knowledge base is available yet. Please try again after one is published.'
    }
    return error.message
  }
  return 'The service could not be reached. Please try again.'
}

const STATUS_LABELS: Record<ChatResponse['status'], string> = {
  supported: 'Answer from reviewed evidence',
  partial: 'Partially answered',
  insufficient_evidence: 'Insufficient evidence',
  extractive_fallback: 'Relevant source excerpts',
}

export function ChatPage() {
  const [loadKey, setLoadKey] = useState(0)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [loadError, setLoadError] = useState('')
  const [disasters, setDisasters] = useState<Disaster[]>([])
  const [disasterId, setDisasterId] = useState('')
  const [question, setQuestion] = useState('')
  const [answerState, setAnswerState] = useState<AnswerState>('idle')
  const [answer, setAnswer] = useState<ChatResponse | null>(null)
  const [answerError, setAnswerError] = useState('')
  const [submittedQuestion, setSubmittedQuestion] = useState('')
  const [freshness, setFreshness] = useState<Freshness>('unchanged')
  const requestRef = useRef<AbortController | null>(null)
  const requestSequence = useRef(0)
  const submitting = useRef(false)
  const resultHeading = useRef<HTMLHeadingElement | null>(null)

  useEffect(() => {
    document.title = 'Ask ReliefCheck · ReliefCheck'
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setLoadState('loading')
    void getDisasters(controller.signal).then(
      (items) => {
        if (controller.signal.aborted) return
        setDisasters(items)
        setDisasterId((previous) => items.some((item) => item.id === previous) ? previous : (items[0]?.id ?? ''))
        setLoadState(items.length ? 'ready' : 'unavailable')
        if (!items.length) setLoadError('No disasters are available in the reviewed dataset.')
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setLoadState('unavailable')
        setLoadError(friendlyError(error, 'disasters'))
      },
    )
    return () => controller.abort()
  }, [loadKey])

  useEffect(() => () => requestRef.current?.abort(), [])

  useEffect(() => {
    const snapshot = answer?.snapshot
    if (!snapshot) return
    let pending: AbortController | undefined
    const sequence = requestSequence.current
    const checkOnReturn = async () => {
      if (document.visibilityState !== 'visible') return
      pending?.abort()
      const controller = new AbortController()
      pending = controller
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)])
      const stillDisplayed = () => !controller.signal.aborted && sequence === requestSequence.current
      try {
        const current = await getCorpusSnapshot(signal)
        if (stillDisplayed()) {
          setFreshness(current.releaseId === snapshot.releaseId && current.epoch === snapshot.epoch ? 'unchanged' : 'older')
        }
      } catch (error) {
        if (!stillDisplayed()) return
        if (error instanceof ApiError && error.code === 'CORPUS_UNAVAILABLE') {
          setFreshness('unpublished')
        } else {
          setFreshness((previous) => previous === 'older' || previous === 'unpublished' ? 'older' : 'unknown')
        }
      }
    }
    const onVisibilityChange = () => void checkOnReturn()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      pending?.abort()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [answer])

  useEffect(() => {
    if (answerState === 'result' || answerState === 'error') resultHeading.current?.focus()
  }, [answerState])

  function chooseDisaster(nextId: string) {
    if (nextId === disasterId) return
    requestSequence.current += 1
    requestRef.current?.abort()
    requestRef.current = null
    submitting.current = false
    setDisasterId(nextId)
    setAnswer(null)
    setAnswerError('')
    setSubmittedQuestion('')
    setFreshness('unchanged')
    setAnswerState('idle')
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current || !disasterId || loadState !== 'ready') return
    const request = chatRequestSchema.safeParse({
      requestId: crypto.randomUUID(),
      disasterId,
      question,
      mode: 'factual',
    })
    if (!request.success) {
      setAnswer(null)
      setAnswerError('Enter a question of 1 to 2,000 characters.')
      setAnswerState('error')
      return
    }

    submitting.current = true
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    const sequence = ++requestSequence.current
    setSubmittedQuestion(request.data.question)
    setFreshness('unchanged')
    setAnswer(null)
    setAnswerError('')
    setAnswerState('loading')
    try {
      const result = await askQuestion(request.data, controller.signal)
      if (controller.signal.aborted || sequence !== requestSequence.current) return
      setAnswer(result)
      setAnswerState('result')
    } catch (error) {
      if (controller.signal.aborted || sequence !== requestSequence.current) return
      setAnswerError(friendlyError(error, 'chat'))
      setAnswerState('error')
    } finally {
      if (sequence === requestSequence.current) {
        submitting.current = false
        requestRef.current = null
      }
    }
  }

  return (
    <section aria-labelledby="page-title" className="chat-page">
      <h1 id="page-title">Ask ReliefCheck</h1>
      <p className="lead">Ask about documented relief efforts and published warnings for one disaster at a time.</p>
      <p className="notice">ReliefCheck provides evidence, not certification. Do not enter personal or payment information.</p>

      {loadState === 'loading' ? <p role="status">Loading disasters…</p> : null}
      {loadState === 'unavailable' ? (
        <div className="chat-message" role="alert">
          <p>{loadError}</p>
          <button type="button" className="button button-secondary" onClick={() => setLoadKey((key) => key + 1)}>
            Retry disaster list
          </button>
        </div>
      ) : null}

      {loadState === 'ready' ? (
        <form onSubmit={(event) => void submit(event)} className="chat-form">
          <label htmlFor="disaster">Disaster</label>
          <select id="disaster" value={disasterId} onChange={(event) => chooseDisaster(event.target.value)}>
            {disasters.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
          </select>
          <label htmlFor="question">Your question</label>
          <textarea
            id="question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            maxLength={2_000}
            rows={4}
            placeholder="What did published sources say about relief efforts?"
            aria-describedby="question-help"
            disabled={answerState === 'loading'}
            required
          />
          <p id="question-help" className="form-help">Chat searches reviewed sources for the selected disaster. Questions can be up to 2,000 characters.</p>
          <p className="form-help">To check a current donation link, use <a href="/appeal">Appeal Review</a>.</p>
          <button type="submit" className="button" disabled={answerState === 'loading' || !question.trim()}>
            {answerState === 'loading' ? 'Finding evidence…' : 'Ask question'}
          </button>
        </form>
      ) : null}

      {answerState === 'loading' ? <p className="chat-message" role="status" aria-live="polite">Finding reviewed evidence for your question…</p> : null}
      {answerState === 'error' ? (
        <section className="chat-message" role="alert" aria-labelledby="answer-heading">
          <h2 id="answer-heading" ref={resultHeading} tabIndex={-1}>Question unavailable</h2>
          <p>{answerError}</p>
        </section>
      ) : null}
      {answerState === 'result' && answer ? (
        <section className="chat-result" aria-labelledby="answer-heading" aria-live="polite">
          <h2 id="answer-heading" ref={resultHeading} tabIndex={-1}>{STATUS_LABELS[answer.status]}</h2>
          <p className="submitted-question">{submittedQuestion}</p>
          <p className="form-help">Evidence used as of <time dateTime={answer.snapshot.asOf}>
            {new Date(answer.snapshot.asOf).toLocaleString()}
          </time></p>
          {freshness !== 'unchanged' ? <p className="notice" role="status">{FRESHNESS_NOTICES[freshness]}</p> : null}
          {answer.claims.length ? (
            <div className="answer-claims">
              {answer.claims.map((claim, index) => (
                <p key={index}>{claim.text}{' '}
                  <CitationReferences citationIds={claim.citationIds} citations={answer.citations} />
                </p>
              ))}
            </div>
          ) : answer.status === 'insufficient_evidence' ? (
            <p>The reviewed sources do not establish an answer to this question.</p>
          ) : null}
          {answer.limitations.length ? (
            <div className="answer-limitations">
              <h3>Limits of this answer</h3>
              <ul>{answer.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul>
            </div>
          ) : null}
          {answer.status === 'extractive_fallback' ? <p>These are source excerpts, not a generated answer.</p> : null}
          <CitationList citations={answer.citations} snapshot={answer.snapshot} />
        </section>
      ) : null}
    </section>
  )
}
