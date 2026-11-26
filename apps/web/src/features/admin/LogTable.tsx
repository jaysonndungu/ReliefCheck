import type { AdminLogEntry } from '@reliefcheck/contracts'

function display(value: string | number | null): string {
  return value === null ? '—' : String(value)
}

export function LogTable({ entries }: { entries: AdminLogEntry[] }) {
  return (
    <div className="table-scroll">
      <table className="metrics-table logs-table">
        <caption>Request metadata only. User questions, appeal text, URLs and credentials are never shown.</caption>
        <thead>
          <tr>
            <th scope="col">Time</th><th scope="col">Request</th><th scope="col">Endpoint</th>
            <th scope="col">Status</th><th scope="col">Latency</th><th scope="col">Mode / outcome</th>
            <th scope="col">Error</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 ? (
            <tr><td colSpan={7} className="empty-row">No request logs match this window.</td></tr>
          ) : entries.map((entry) => (
            <tr key={entry.requestId}>
              <td>{new Date(entry.occurredAt).toLocaleString()}</td>
              <td><code>{entry.requestId.slice(0, 8)}</code></td>
              <td><code>{entry.method} {entry.endpoint}</code></td>
              <td>{entry.statusCode}</td>
              <td>{entry.latencyMs} ms</td>
              <td>{display(entry.mode)}{entry.outcome ? ` / ${entry.outcome}` : ''}</td>
              <td>{display(entry.errorCode)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
