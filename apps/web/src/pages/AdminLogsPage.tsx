import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { AdminLogEntry, AdminLogsResponse } from '@reliefcheck/contracts'
import { LogTable } from '../features/admin/LogTable'

const PREVIEW_AVAILABLE = import.meta.env.DEV
const PREVIEW_ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function previewLogs(now: Date): AdminLogsResponse {
  const entry = (minutes: number, statusCode: number, endpoint: string, outcome: AdminLogEntry['outcome']): AdminLogEntry => ({
    requestId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(minutes).padStart(12, '0')}`,
    occurredAt: new Date(now.getTime() - minutes * 60_000).toISOString(), endpoint, method: endpoint === '/chat' ? 'POST' : 'GET',
    statusCode, errorCode: statusCode >= 400 ? 'DATABASE_UNAVAILABLE' : null, latencyMs: minutes * 37,
    stageTimings: endpoint === '/chat' ? { retrieve: 42, generate: 1800 } : null,
    mode: endpoint === '/chat' ? 'factual' : null, outcome, retrievalMode: endpoint === '/chat' ? 'hybrid' : null,
    disasterId: null, releaseId: null, epoch: null, providerUsage: null,
  })
  const entries = [entry(4, 200, '/chat', 'supported'), entry(11, 503, '/chat', null), entry(19, 200, '/appeals/review', 'published_warning_found')]
  return { entries, nextCursor: null, window: { from: new Date(now.getTime() - 86_400_000).toISOString(), to: now.toISOString() }, generatedAt: now.toISOString(), retentionDays: 14 }
}

export function AdminLogsPage() {
  const [searchParams] = useSearchParams()
  const [logs, setLogs] = useState<AdminLogsResponse | null>(null)
  const preview = PREVIEW_AVAILABLE && searchParams.get('preview') === '1'
  useEffect(() => { document.title = 'Usage logs · Admin · ReliefCheck' }, [])
  useEffect(() => { setLogs(preview ? previewLogs(new Date()) : null) }, [preview])
  const windowLabel = useMemo(() => logs ? `${new Date(logs.window.from).toLocaleString()} – ${new Date(logs.window.to).toLocaleString()}` : '', [logs])

  return (
    <section aria-labelledby="page-title" className="admin-page">
      <p className="eyebrow">Admin</p>
      <h1 id="page-title">Usage logs</h1>
      <p className="lead">Safe request metadata retained for 14 days. Raw user text and credentials are never logged.</p>
      {preview ? <p className="notice notice-preview" role="note"><strong>Synthetic preview data, not real traffic.</strong> This local-only preview contains invented request metadata.</p> : null}
      {logs ? <><p className="metrics-window">Window: <strong>{windowLabel}</strong></p><LogTable entries={logs.entries} /></> : (
        <div className="notice">
          <p><strong>Staff sign-in required.</strong> Only signed-in admins can view usage logs.</p>
          {PREVIEW_AVAILABLE ? <p><a href="?preview=1">Open the synthetic layout preview</a> (local development only).</p> : null}
        </div>
      )}
    </section>
  )
}
