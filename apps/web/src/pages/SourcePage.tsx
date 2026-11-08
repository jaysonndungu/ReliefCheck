import { useEffect, useRef, useState } from 'react'
import { useLocation, useParams } from 'react-router'
import type { SourceEvidenceResponse } from '@reliefcheck/contracts'
import { loadSourceEvidence } from '../features/sources/sourceApi'
import { ApiError } from '../lib/api'

type PageState = 'loading' | 'ready' | 'unavailable'

function sourceError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'KB_CHANGED') return 'The published evidence changed. Return to your answer and ask again.'
    if (error.code === 'SOURCE_UNAVAILABLE') return 'This source is not in the current reviewed release.'
    if (error.code === 'CORPUS_UNAVAILABLE') return 'No reviewed evidence is currently published.'
    if (error.code === 'SOURCE_EVIDENCE_UNAVAILABLE' || error.code === 'NOT_FOUND') {
      return 'The public evidence page is not available on this service yet.'
    }
    return error.message
  }
  return 'The source could not be loaded. Please try again.'
}

export function SourcePage() {
  const { sourceVersionId } = useParams()
  const { search } = useLocation()
  const [state, setState] = useState<PageState>('loading')
  const [evidence, setEvidence] = useState<SourceEvidenceResponse | null>(null)
  const [message, setMessage] = useState('')
  const heading = useRef<HTMLHeadingElement | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams(search)
    const releaseId = params.get('releaseId')
    const epochText = params.get('epoch')
    const epoch = epochText === null ? null : Number(epochText)
    if (!sourceVersionId || (releaseId === null) !== (epochText === null) ||
        (epoch !== null && (!Number.isSafeInteger(epoch) || epoch < 0))) {
      setState('unavailable')
      setMessage('The source reference is invalid.')
      return () => controller.abort()
    }
    const expected = releaseId !== null && epoch !== null ? { releaseId, epoch } : null
    setState('loading')
    setEvidence(null)
    void loadSourceEvidence(sourceVersionId, expected, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return
        setEvidence(result)
        setState('ready')
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setMessage(sourceError(error))
        setState('unavailable')
      },
    )
    return () => controller.abort()
  }, [sourceVersionId, search])

  useEffect(() => {
    document.title = evidence && state === 'ready' ? `${evidence.title} · ReliefCheck` : 'Source evidence · ReliefCheck'
    if (state !== 'loading') heading.current?.focus()
  }, [evidence, state])

  return (
    <section className="source-page" aria-labelledby="source-page-heading">
      <a href="/">Back to Ask ReliefCheck</a>
      {state === 'loading' ? <><h1 id="source-page-heading">Source evidence</h1><p role="status" aria-live="polite">Loading source evidence…</p></> : null}
      {state === 'unavailable' ? (
        <div className="chat-message" role="alert">
          <h1 id="source-page-heading" ref={heading} tabIndex={-1}>Source unavailable</h1>
          <p>{message}</p>
        </div>
      ) : null}
      {state === 'ready' && evidence ? (
        <article className="source-page-content">
          <h1 id="source-page-heading" ref={heading} tabIndex={-1}>{evidence.title}</h1>
          <p><strong>Published:</strong> {evidence.publicationDate
            ? <time dateTime={evidence.publicationDate}>{evidence.publicationDate}</time>
            : 'Date unavailable'}</p>
          <p><strong>Reviewed:</strong> <time dateTime={evidence.reviewedAt}>
            {new Date(evidence.reviewedAt).toISOString().slice(0, 10)} UTC
          </time></p>
          <h2>Reviewed excerpts</h2>
          <ol className="source-list">
            {evidence.excerpts.map((item, index) => (
              <li key={`${item.locator}-${index}`} className="source-card">
                <p><strong>Location:</strong> {item.locator}</p>
                <blockquote>{item.excerpt}</blockquote>
              </li>
            ))}
          </ol>
          {evidence.sourceUrl ? (
            <p><a href={evidence.sourceUrl} target="_blank" rel="noopener noreferrer">Open original source</a></p>
          ) : <p>The original upload is private. Only these reviewed excerpts are public.</p>}
        </article>
      ) : null}
    </section>
  )
}
