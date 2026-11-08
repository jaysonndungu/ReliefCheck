import type { ChatResponse, Citation } from '@reliefcheck/contracts'

type Snapshot = ChatResponse['snapshot']

function safeExternalUrl(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

function uniqueCitations(citations: Citation[]) {
  const counts = new Map<string, number>()
  citations.forEach((citation) => counts.set(citation.id, (counts.get(citation.id) ?? 0) + 1))
  return citations.filter((citation) => counts.get(citation.id) === 1)
}

export function CitationReferences({ citationIds, citations }: {
  citationIds: string[]
  citations: Citation[]
}) {
  const available = uniqueCitations(citations)
  if (!citationIds.length) return <span className="source-unavailable">No source references were returned for this claim.</span>
  return (
    <span className="claim-references" aria-label="Supporting sources">
      {citationIds.map((id, index) => {
        const sourceIndex = available.findIndex((citation) => citation.id === id)
        return sourceIndex < 0
          ? <span key={`${id}-${index}`} className="source-unavailable">Source reference unavailable</span>
          : <a key={`${id}-${index}`} href={`#answer-source-${sourceIndex + 1}`} aria-label={`Source ${sourceIndex + 1}: ${available[sourceIndex]!.title}`}>
              [{sourceIndex + 1}]
            </a>
      })}
    </span>
  )
}

export function CitationList({ citations, snapshot }: { citations: Citation[]; snapshot: Snapshot }) {
  const available = uniqueCitations(citations)
  return (
    <section className="sources-section" aria-labelledby="sources-heading">
      <h3 id="sources-heading">Supporting sources</h3>
      {!available.length ? <p>No supporting sources were returned for this answer.</p> : (
        <ol className="source-list">
          {available.map((citation, index) => {
            const externalUrl = safeExternalUrl(citation.sourceUrl)
            const privatePage = `/sources/${encodeURIComponent(citation.sourceVersionId)}?releaseId=${encodeURIComponent(snapshot.releaseId)}&epoch=${snapshot.epoch}`
            const reviewedDate = new Date(citation.reviewedAt).toISOString().slice(0, 10)
            return (
              <li key={citation.id}>
                <article className="source-card" aria-labelledby={`answer-source-${index + 1}`}>
                  <h4 id={`answer-source-${index + 1}`} tabIndex={-1}>[{index + 1}] {citation.title}</h4>
                  <p><strong>Location:</strong> {citation.locator}</p>
                  <p><strong>Published:</strong> {citation.publicationDate
                    ? <time dateTime={citation.publicationDate}>{citation.publicationDate}</time>
                    : 'Date unavailable'}</p>
                  <p><strong>Reviewed:</strong> <time dateTime={citation.reviewedAt}>{reviewedDate} UTC</time></p>
                  <blockquote>{citation.excerpt}</blockquote>
                  {externalUrl
                    ? <a href={externalUrl} target="_blank" rel="noopener noreferrer">Open original source</a>
                    : citation.sourceUrl === null
                      ? <a href={privatePage}>Open public evidence excerpt</a>
                      : <span className="source-unavailable">Original source link unavailable</span>}
                </article>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
