import type { AppealReviewResponse, AppealResult } from '@reliefcheck/contracts'
import { CitationList, CitationReferences } from '../sources/CitationList'

const labels: Record<AppealResult['status'], string> = {
  documented_official_channel: 'Documented official channel',
  published_warning_found: 'Published warning found',
  insufficient_evidence: 'Insufficient evidence',
}

function explanation(result: AppealResult): string {
  if (result.reasonCodes.includes('CONFLICTING_RECORDS')) {
    return 'Reviewed channel and warning records conflict for this target. No current channel endorsement is made.'
  }
  if (result.reasonCodes.includes('MULTIPLE_TARGETS')) {
    return 'This appeal contains multiple links. Review each target separately before deciding what to verify.'
  }
  if (result.reasonCodes.includes('MATCHED_WARNING')) {
    return 'A published source warned about this exact target. The warning describes what was reported at its publication date; it does not establish a present-day fraud finding.'
  }
  if (result.reasonCodes.includes('MATCHED_OFFICIAL')) {
    return 'A reviewed record documents this exact channel for the selected disaster. This does not guarantee that a message, payment, or donation is safe.'
  }
  if (result.reasonCodes.includes('EXPIRED_REVIEW') || result.reasonCodes.includes('HISTORICAL_MATCH')) {
    return 'A historical record matched, but the reviewed evidence does not establish a current donation channel.'
  }
  if (result.reasonCodes.includes('AMBIGUOUS_MATCH')) return 'More than one reviewed record matched. The appeal cannot be assigned one channel.'
  if (result.reasonCodes.includes('INVALID_TARGET')) return 'The submitted target could not be safely identified as a supported URL or hostname.'
  if (result.reasonCodes.includes('NO_TARGET')) return 'No donation destination could be identified in this appeal text.'
  return 'No reviewed record establishes a match for this target. This is not a finding that it is fraudulent.'
}

export function AppealResultView({ review }: { review: AppealReviewResponse }) {
  return (
    <div className="appeal-results">
      <p className={`evidence-status status-${review.result.status}`}>{labels[review.result.status]}</p>
      <p>{explanation(review.result)}</p>
      <p className="form-help">Evidence snapshot: {new Date(review.snapshot.asOf).toISOString().slice(0, 10)} UTC</p>
      {review.targets.length ? review.targets.map((target, index) => (
        <section className="appeal-target" key={`${target.targetHost}-${index}`} aria-labelledby={`target-${index}`}>
          <h3 id={`target-${index}`}>Target {index + 1}: {target.targetHost}</h3>
          {review.targets.length > 1 ? <p><strong>{labels[target.result.status]}.</strong> {explanation(target.result)}</p> : null}
          {target.matches.length ? target.matches.map((match) => (
            <article className="appeal-match" key={match.recordVersionId}>
              <h4>{match.organizationName ?? match.title}</h4>
              {match.organizationName ? <p>{match.title}</p> : null}
              <p><strong>Record:</strong> {match.kind === 'warning' ? 'Published warning' : 'Documented channel'}
                {match.historical ? ' · Historical or no longer current' : ''}
                {match.retracted ? ' · Warning retracted' : ''}</p>
              <p><strong>Match scope:</strong> {match.scope === 'host' ? 'Exact hostname' : 'Exact URL'}</p>
              <p><strong>Published:</strong> {match.publicationDate
                ? <time dateTime={match.publicationDate}>{match.publicationDate}</time> : 'Date unavailable'}</p>
              <p><strong>Reviewed:</strong> <time dateTime={match.reviewedAt}>
                {new Date(match.reviewedAt).toISOString().slice(0, 10)} UTC
              </time></p>
              {match.officialChannelUrl && !match.historical && !target.result.conflict ? (
                <p><a href={match.officialChannelUrl} target="_blank" rel="noopener noreferrer">Open reviewed channel destination</a></p>
              ) : null}
              <p><strong>Supporting records:</strong>{' '}
                <CitationReferences citationIds={match.citationIds} citations={review.citations} /></p>
            </article>
          )) : <p>No reviewed records matched this target.</p>}
        </section>
      )) : <p>No identifiable donation destination was found.</p>}
      <CitationList citations={review.citations} snapshot={review.snapshot} />
    </div>
  )
}
