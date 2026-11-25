import type { AdminMetricsResponse, LatencySummary } from '@reliefcheck/contracts'

/** Below this many samples a p95 is shown with an explicit reliability warning (ai.md §12). */
export const MIN_RELIABLE_SAMPLES = 20

const OUTCOME_LABELS: Record<string, string> = {
  supported: 'Supported answer',
  partial: 'Partial answer',
  insufficient_evidence: 'Insufficient evidence',
  extractive_fallback: 'Excerpts only (degraded)',
  documented_official_channel: 'Appeal: documented official channel',
  published_warning_found: 'Appeal: published warning found',
}
const MODE_LABELS: Record<string, string> = {
  factual: 'Factual', appeal_explanation: 'Appeal explanation', comparison: 'Comparison',
}
const RETRIEVAL_LABELS: Record<string, string> = {
  hybrid: 'Hybrid (semantic + keyword)', lexical_only: 'Keyword only (degraded)', registry: 'Registry lookup',
}

const numberFormat = new Intl.NumberFormat('en-US')
const count = (value: number) => numberFormat.format(value)

export function formatMs(value: number | null): string {
  if (value === null) return '—'
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)} s`
  return `${Math.round(value)} ms`
}

function share(part: number, whole: number): string {
  if (whole === 0) return '—'
  const percent = (part / whole) * 100
  return `${percent < 1 && percent > 0 ? '<1' : Math.round(percent)}%`
}

function formatWindow(window: AdminMetricsResponse['window']): string {
  const format = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })
  return `${format.format(new Date(window.from))} – ${format.format(new Date(window.to))}`
}

function StatTile({ label, value, detail, attention }: {
  label: string; value: string; detail: string; attention?: boolean
}) {
  return (
    <div className={attention ? 'stat-tile stat-tile-attention' : 'stat-tile'}>
      <dt className="stat-label">
        {attention ? <span aria-hidden="true" className="stat-icon">▲ </span> : null}
        {label}
      </dt>
      <dd className="stat-value">{value}</dd>
      <dd className="stat-detail">{attention ? <strong>Needs attention. </strong> : null}{detail}</dd>
    </div>
  )
}

function LatencyCells({ summary }: { summary: LatencySummary }) {
  const lowSample = summary.sampleCount > 0 && summary.sampleCount < MIN_RELIABLE_SAMPLES
  return (
    <>
      <td className="numeric">{count(summary.sampleCount)}</td>
      <td className="numeric">{formatMs(summary.p50Ms)}</td>
      <td className="numeric">
        {formatMs(summary.p95Ms)}
        {lowSample ? <span className="low-sample"> (few samples)</span> : null}
      </td>
    </>
  )
}

function CountTable({ caption, heading, rows, total }: {
  caption: string; heading: string; rows: Array<{ label: string; count: number }>; total: number
}) {
  return (
    <div className="table-scroll">
      <table className="metrics-table">
        <caption>{caption}</caption>
        <thead>
          <tr><th scope="col">{heading}</th><th scope="col" className="numeric">Requests</th><th scope="col" className="numeric">Share</th></tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={3} className="empty-row">No requests in this window.</td></tr>
          ) : rows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td className="numeric">{count(row.count)}</td>
              <td className="numeric">{share(row.count, total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Presentational US10 dashboard. Every figure comes from the validated metrics response. */
export function MetricsDashboard({ metrics, disasterNames }: {
  metrics: AdminMetricsResponse
  disasterNames: Record<string, string>
}) {
  const { totals, latency } = metrics
  const total = totals.requests
  const of = (value: number) => `${share(value, total)} of ${count(total)} requests`
  const lowSample = latency.sampleCount < MIN_RELIABLE_SAMPLES

  return (
    <div className="metrics-dashboard">
      <p className="metrics-window">
        Window: <strong>{formatWindow(metrics.window)}</strong>. All counts and percentiles cover this window only.
      </p>

      {metrics.telemetry.droppedEvents > 0 ? (
        <p className="notice notice-warning" role="status">
          <strong>Telemetry gap:</strong> {count(metrics.telemetry.droppedEvents)} request
          {metrics.telemetry.droppedEvents === 1 ? ' was' : 's were'} not recorded since this server started
          ({new Date(metrics.telemetry.processStartedAt).toLocaleString('en-US')}). Counts below may be low.
        </p>
      ) : null}

      <section aria-labelledby="totals-heading">
        <h2 id="totals-heading">Requests</h2>
        {total === 0 ? (
          <p className="notice">No requests were recorded in this window.</p>
        ) : null}
        <dl className="stat-grid">
          <StatTile label="Total requests" value={count(total)} detail="Health checks are not counted" />
          <StatTile label="Succeeded" value={count(totals.succeeded)} detail={of(totals.succeeded)} />
          <StatTile label="Degraded responses" value={count(totals.degraded)} detail={`${of(totals.degraded)}: excerpts only or keyword-only search`} attention={totals.degraded > 0} />
          <StatTile label="Infrastructure failures" value={count(totals.infrastructureFailures)} detail={`${of(totals.infrastructureFailures)}: HTTP 5xx`} attention={totals.infrastructureFailures > 0} />
          <StatTile label="Client errors" value={count(totals.clientErrors)} detail={`${of(totals.clientErrors)}: invalid input, auth or not found`} />
          <StatTile label="Quota or rate limited" value={count(totals.quotaBlocked)} detail={`${of(totals.quotaBlocked)}: HTTP 429`} attention={totals.quotaBlocked > 0} />
        </dl>
      </section>

      <section aria-labelledby="latency-heading">
        <h2 id="latency-heading">Latency</h2>
        <dl className="stat-grid">
          <StatTile label="Median (p50)" value={formatMs(latency.p50Ms)} detail={`n = ${count(latency.sampleCount)} requests`} />
          <StatTile label="95th percentile (p95)" value={formatMs(latency.p95Ms)}
            detail={lowSample ? `n = ${count(latency.sampleCount)}: too few samples for a reliable p95` : `n = ${count(latency.sampleCount)} requests`} />
        </dl>

        <div className="table-scroll">
          <table className="metrics-table">
            <caption>By endpoint. Failures are responses with HTTP status 400 or higher.</caption>
            <thead>
              <tr>
                <th scope="col">Endpoint</th>
                <th scope="col" className="numeric">Requests</th>
                <th scope="col" className="numeric">Failures</th>
                <th scope="col" className="numeric">Samples</th>
                <th scope="col" className="numeric">p50</th>
                <th scope="col" className="numeric">p95</th>
              </tr>
            </thead>
            <tbody>
              {metrics.endpoints.length === 0 ? (
                <tr><td colSpan={6} className="empty-row">No requests in this window.</td></tr>
              ) : metrics.endpoints.map((row) => (
                <tr key={`${row.method} ${row.endpoint}`}>
                  <th scope="row"><code>{row.method} {row.endpoint}</code></th>
                  <td className="numeric">{count(row.requests)}</td>
                  <td className="numeric">{count(row.failures)} ({share(row.failures, row.requests)})</td>
                  <LatencyCells summary={row} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="table-scroll">
          <table className="metrics-table">
            <caption>By pipeline stage (chat requests). Samples count requests that reached the stage.</caption>
            <thead>
              <tr>
                <th scope="col">Stage</th>
                <th scope="col" className="numeric">Samples</th>
                <th scope="col" className="numeric">p50</th>
                <th scope="col" className="numeric">p95</th>
              </tr>
            </thead>
            <tbody>
              {metrics.stages.length === 0 ? (
                <tr><td colSpan={4} className="empty-row">No stage timings in this window.</td></tr>
              ) : metrics.stages.map((row) => (
                <tr key={row.stage}>
                  <th scope="row">{row.stage}</th>
                  <LatencyCells summary={row} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="breakdown-heading">
        <h2 id="breakdown-heading">Outcomes and usage</h2>
        <div className="metrics-columns">
          <CountTable caption="Answer and appeal outcomes" heading="Outcome" total={total}
            rows={metrics.outcomes.map((row) => ({ label: OUTCOME_LABELS[row.outcome] ?? row.outcome, count: row.count }))} />
          <CountTable caption="Retrieval mode" heading="Mode" total={total}
            rows={metrics.byRetrievalMode.map((row) => ({ label: RETRIEVAL_LABELS[row.retrievalMode] ?? row.retrievalMode, count: row.count }))} />
          <CountTable caption="Prompt mode" heading="Mode" total={total}
            rows={metrics.byMode.map((row) => ({ label: MODE_LABELS[row.mode] ?? row.mode, count: row.count }))} />
          <CountTable caption="Selected disaster" heading="Disaster" total={total}
            rows={metrics.byDisaster.map((row) => ({ label: disasterNames[row.disasterId] ?? 'Unknown or retired event', count: row.count }))} />
        </div>
        <p className="metrics-footnote">
          Share is out of all {count(total)} requests in the window, so rows in a table need not add up to 100%.
          This page reports operations only. Answer accuracy is measured separately in the evaluation report (US09).
        </p>
      </section>
    </div>
  )
}
