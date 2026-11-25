import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { AdminMetricsResponse } from '@reliefcheck/contracts'
import { MetricsDashboard } from '../features/admin/MetricsDashboard'

const WINDOWS = [
  { value: '1h', label: 'Last hour', hours: 1 },
  { value: '24h', label: 'Last 24 hours', hours: 24 },
  { value: '7d', label: 'Last 7 days', hours: 24 * 7 },
  { value: '14d', label: 'Last 14 days', hours: 24 * 14 },
] as const
type WindowValue = (typeof WINDOWS)[number]['value']

/** True only in `npm run dev`; Vite replaces it with `false` in production builds. */
const PREVIEW_AVAILABLE = import.meta.env.DEV

type Preview = { metrics: AdminMetricsResponse; disasterNames: Record<string, string> }

/**
 * US10 Performance section of the admin website (ai.md §12).
 * Real metrics require an admin session; staff sign-in is the next slice of work.
 * In local development `?preview=1` renders clearly labeled synthetic data.
 */
export function AdminPerformancePage() {
  const [searchParams] = useSearchParams()
  const [windowValue, setWindowValue] = useState<WindowValue>('24h')
  const [preview, setPreview] = useState<Preview | null>(null)
  const previewRequested = PREVIEW_AVAILABLE && searchParams.get('preview') === '1'

  useEffect(() => {
    document.title = 'Performance · Admin · ReliefCheck'
  }, [])

  useEffect(() => {
    if (!previewRequested) {
      setPreview(null)
      return
    }
    let cancelled = false
    const hours = WINDOWS.find((option) => option.value === windowValue)?.hours ?? 24
    const now = new Date()
    // Dynamic import keeps the synthetic fixture out of the production bundle entirely.
    void import('../features/admin/previewMetrics').then(({ previewMetrics, PREVIEW_DISASTERS }) => {
      if (cancelled) return
      setPreview({
        metrics: previewMetrics({ from: new Date(now.getTime() - hours * 3_600_000), to: now }, now),
        disasterNames: PREVIEW_DISASTERS,
      })
    })
    return () => { cancelled = true }
  }, [previewRequested, windowValue])

  return (
    <section aria-labelledby="page-title" className="admin-page">
      <p className="eyebrow">Admin</p>
      <h1 id="page-title">Performance</h1>
      <p className="lead">Request volume, failures and latency recorded by the ReliefCheck API.</p>

      {previewRequested ? (
        <p className="notice notice-preview" role="note">
          <strong>Synthetic preview data, not real traffic.</strong> This preview exists only in local
          development so the layout can be reviewed. Every number below is invented.
        </p>
      ) : null}

      {previewRequested ? (
      <div className="metrics-controls">
        <label htmlFor="metrics-window">Time window</label>
        <select id="metrics-window" value={windowValue} onChange={(event) => setWindowValue(event.target.value as WindowValue)}>
          {WINDOWS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>
      ) : null}

      {previewRequested ? (
        preview ? <MetricsDashboard metrics={preview.metrics} disasterNames={preview.disasterNames} />
          : <p aria-live="polite">Loading preview…</p>
      ) : (
        <div className="notice">
          <p><strong>Staff sign-in required.</strong> Real metrics are shown only to signed-in admins.
            The admin sign-in screen is not built yet, so this page cannot load real data.</p>
          {PREVIEW_AVAILABLE ? (
            <p><a href="?preview=1">Open the synthetic layout preview</a> (local development only).</p>
          ) : null}
        </div>
      )}
    </section>
  )
}
