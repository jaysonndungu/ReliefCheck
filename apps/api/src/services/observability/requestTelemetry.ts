import type { NextFunction, Request, Response } from 'express'
import {
  ADMIN_METRICS_PATH, LIVENESS_PATH, READINESS_PATH,
  type ChatResponse, type RequestOutcome,
} from '@reliefcheck/contracts'

/**
 * US10 request instrumentation (ai.md §3 request_events, §10, §12).
 *
 * Privacy contract: an event carries request METADATA only. There is no field for the question,
 * appeal text, submitted URL, request body, headers, token, IP or session. Routes annotate the
 * outcome through `annotate()` with typed, enumerable values; nothing free-form reaches storage.
 *
 * Reliability contract: telemetry is best effort. A failed or dropped write never changes the
 * response the user receives; it increments `droppedEvents`, which the admin metrics expose as a
 * telemetry gap.
 */

export type RequestEvent = {
  requestId: string
  occurredAt: Date
  /** Route template relative to /api/v1, e.g. '/sources/:id'. '(unmatched)' for unknown routes. */
  endpoint: string
  method: string
  statusCode: number
  errorCode: string | null
  latencyMs: number
  stageTimings: Record<string, number> | null
  mode: ChatResponse['mode'] | null
  outcome: RequestOutcome | null
  retrievalMode: ChatResponse['retrievalMode'] | null
  disasterId: string | null
  releaseId: string | null
  epoch: number | null
  providerUsage: Record<string, number> | null
}

/** Persistence boundary; the pg implementation lives in db/requestEvents.ts. */
export type RequestEventSink = { insert(event: RequestEvent): Promise<void> }

/** Fields a route or service may attach to the current request's event. */
export type RequestAnnotation = Partial<Pick<RequestEvent,
  'mode' | 'outcome' | 'retrievalMode' | 'disasterId' | 'releaseId' | 'epoch' | 'providerUsage'>>

/** Receives the duration of one pipeline stage. Services take this, never an Express object. */
export type StageObserver = (stage: string, durationMs: number) => void

type TelemetryLocals = { annotation: RequestAnnotation; stages: Record<string, number> }

const LOCALS_KEY = 'telemetry'
/** Platform probes and the metrics page's own refreshes would otherwise dominate the counts. */
const EXCLUDED_ENDPOINTS = new Set([LIVENESS_PATH, READINESS_PATH, ADMIN_METRICS_PATH])
const UNMATCHED = '(unmatched)'
const MAX_STAGES = 12
const MAX_LATENCY_MS = 600_000
const STAGE_NAME = /^[a-z][a-z0-9_]{0,31}$/
const ERROR_CODE = /^[A-Z0-9_]{1,64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ENDPOINT = /^[A-Za-z0-9/:_.()-]{1,100}$/
const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'])

function locals(response: Response): TelemetryLocals | undefined {
  return response.locals[LOCALS_KEY] as TelemetryLocals | undefined
}

/** Attach typed outcome metadata to the current request. A no-op when telemetry is disabled. */
export function annotate(response: Response, annotation: RequestAnnotation): void {
  const current = locals(response)
  if (current) Object.assign(current.annotation, annotation)
}

/** A StageObserver bound to this request. Durations for a repeated stage are summed. */
export function stageObserver(response: Response): StageObserver | undefined {
  const current = locals(response)
  if (!current) return undefined
  return (stage, durationMs) => {
    if (!STAGE_NAME.test(stage) || !Number.isFinite(durationMs) || durationMs < 0) return
    const known = stage in current.stages
    if (!known && Object.keys(current.stages).length >= MAX_STAGES) return
    current.stages[stage] = (current.stages[stage] ?? 0) + durationMs
  }
}

/** Times an async stage for an optional observer, including when it throws. */
export async function timeStage<T>(observe: StageObserver | undefined, stage: string, work: () => Promise<T>): Promise<T> {
  if (!observe) return work()
  const started = performance.now()
  try {
    return await work()
  } finally {
    observe(stage, performance.now() - started)
  }
}

/** Express 5 sets `request.route` for the matched route; otherwise the route was unknown. */
function endpointTemplate(request: Request): string {
  const path = (request.route as { path?: unknown } | undefined)?.path
  return typeof path === 'string' && ENDPOINT.test(path) ? path : UNMATCHED
}

function sanitizeNumbers(input: Record<string, number> | null | undefined): Record<string, number> | null {
  if (!input) return null
  const entries = Object.entries(input)
    .filter(([key, value]) => STAGE_NAME.test(key) && Number.isFinite(value) && value >= 0)
    .slice(0, MAX_STAGES)
    .map(([key, value]) => [key, Math.min(Math.round(value), MAX_LATENCY_MS)] as const)
  return entries.length ? Object.fromEntries(entries) : null
}

/** Defensive normalization at the persistence boundary; never trust that every caller was typed. */
export function sanitizeEvent(event: RequestEvent): RequestEvent | null {
  if (!UUID.test(event.requestId) || !METHODS.has(event.method)) return null
  if (!Number.isInteger(event.statusCode) || event.statusCode < 100 || event.statusCode > 599) return null
  const uuidOrNull = (value: string | null | undefined) => (value && UUID.test(value) ? value : null)
  return {
    ...event,
    endpoint: ENDPOINT.test(event.endpoint) ? event.endpoint : UNMATCHED,
    errorCode: event.errorCode && ERROR_CODE.test(event.errorCode) ? event.errorCode : null,
    latencyMs: Math.min(Math.max(Math.round(event.latencyMs), 0), MAX_LATENCY_MS),
    stageTimings: sanitizeNumbers(event.stageTimings),
    providerUsage: sanitizeNumbers(event.providerUsage),
    disasterId: uuidOrNull(event.disasterId),
    releaseId: uuidOrNull(event.releaseId),
    epoch: Number.isInteger(event.epoch) && (event.epoch as number) >= 0 ? event.epoch : null,
  }
}

export type RequestTelemetry = {
  middleware: (request: Request, response: Response, next: NextFunction) => void
  droppedEvents: () => number
  processStartedAt: Date
  /** Resolves once in-flight writes settle. For tests and graceful shutdown. */
  flush: () => Promise<void>
}

export type RequestTelemetryOptions = {
  /** Upper bound on concurrent telemetry writes so logging cannot starve the 3-connection pool. */
  maxInFlight?: number
  now?: () => Date
  /** Safe local log line for a failed write. Receives only the request ID and a SQLSTATE-like code. */
  onWriteFailure?: (requestId: string, code: string) => void
}

/**
 * Builds the recording middleware. Mount it on the /api/v1 router, after the request-ID middleware,
 * so `request.route` resolves to API route templates.
 */
export function createRequestTelemetry(sink: RequestEventSink, options: RequestTelemetryOptions = {}): RequestTelemetry {
  const maxInFlight = options.maxInFlight ?? 10
  const now = options.now ?? (() => new Date())
  const onWriteFailure = options.onWriteFailure ?? ((requestId, code) => {
    console.error(`Telemetry write failed (requestId ${requestId}, code ${code})`)
  })
  const processStartedAt = now()
  const inFlight = new Set<Promise<void>>()
  let dropped = 0

  function write(event: RequestEvent) {
    const safe = sanitizeEvent(event)
    if (!safe) {
      dropped += 1
      return
    }
    if (inFlight.size >= maxInFlight) {
      dropped += 1
      return
    }
    const pending = Promise.resolve()
      .then(() => sink.insert(safe))
      .catch((error: unknown) => {
        dropped += 1
        // Never log the error message or detail: pg includes failing row values in `detail`.
        const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
          ? error.code.replace(/[^A-Z0-9_]/gi, '').slice(0, 16) || 'UNKNOWN'
          : 'UNKNOWN'
        onWriteFailure(safe.requestId, code)
      })
      .finally(() => { inFlight.delete(pending) })
    inFlight.add(pending)
  }

  function middleware(request: Request, response: Response, next: NextFunction) {
    const started = performance.now()
    const occurredAt = now()
    const state: TelemetryLocals = { annotation: {}, stages: {} }
    response.locals[LOCALS_KEY] = state
    let recorded = false

    const record = (closedEarly: boolean) => {
      if (recorded) return
      recorded = true
      const endpoint = endpointTemplate(request)
      if (EXCLUDED_ENDPOINTS.has(endpoint)) return
      const requestId = response.locals.requestId as string | undefined
      if (!requestId) return
      const errorCode = closedEarly
        ? 'CLIENT_CLOSED'
        : (response.locals.errorCode as string | undefined) ?? null
      const { annotation } = state
      write({
        requestId,
        occurredAt,
        endpoint,
        method: request.method,
        statusCode: response.statusCode,
        errorCode,
        latencyMs: performance.now() - started,
        stageTimings: Object.keys(state.stages).length ? { ...state.stages } : null,
        mode: annotation.mode ?? null,
        outcome: annotation.outcome ?? null,
        retrievalMode: annotation.retrievalMode ?? null,
        disasterId: annotation.disasterId ?? null,
        releaseId: annotation.releaseId ?? null,
        epoch: annotation.epoch ?? null,
        providerUsage: annotation.providerUsage ?? null,
      })
    }

    response.once('finish', () => record(false))
    response.once('close', () => record(!response.writableFinished))
    next()
  }

  return {
    middleware,
    droppedEvents: () => dropped,
    processStartedAt,
    flush: async () => { await Promise.allSettled([...inFlight]) },
  }
}
