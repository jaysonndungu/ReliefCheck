import type { ApiStatus } from './useApiStatus'

const COPY: Record<ApiStatus, { label: string; detail: string }> = {
  checking: { label: 'Connecting', detail: 'Checking the ReliefCheck service…' },
  waking: {
    label: 'Waking up',
    detail:
      'ReliefCheck runs on free hosting that sleeps when idle. Starting it can take up to a minute. This page keeps retrying.',
  },
  connected: { label: 'Connected', detail: 'The ReliefCheck service is available.' },
  unavailable: {
    label: 'Unavailable',
    detail: 'The service did not respond. It may be paused or restarting. Try again in a moment.',
  },
}

export function ApiStatusBanner({ status, onRetry }: { status: ApiStatus; onRetry: () => void }) {
  const copy = COPY[status]
  return (
    <div className={`status-banner status-${status}`} role="status" aria-live="polite">
      <span className="status-label">
        <span aria-hidden="true" className="status-icon">
          {status === 'connected' ? '●' : status === 'unavailable' ? '!' : '…'}
        </span>{' '}
        {status === 'connected' ? 'API connected' : copy.label}
      </span>
      <span className="status-detail">{copy.detail}</span>
      {status === 'unavailable' || status === 'waking' ? (
        <button type="button" className="button button-secondary" onClick={onRetry}>
          Retry now
        </button>
      ) : null}
    </div>
  )
}
