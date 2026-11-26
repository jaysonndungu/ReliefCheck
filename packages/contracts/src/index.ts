import { z } from 'zod'

export const API_PREFIX = '/api/v1'
export const LIVENESS_PATH = '/health/live'
export const READINESS_PATH = '/health/ready'
export const ADMIN_ME_PATH = '/admin/me'
export const DISASTERS_PATH = '/disasters'
export const CHAT_PATH = '/chat'
export const CORPUS_SNAPSHOT_PATH = '/corpus/snapshot'
export const SOURCES_PATH = '/sources'
export const APPEALS_REVIEW_PATH = '/appeals/review'

export const livenessSchema = z.object({ status: z.literal('ok') })

/** Shared error envelope for every non-2xx API response (ai.md §9). */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
  }),
  requestId: z.uuid(),
})
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>

export const READINESS_ERROR_CODES = [
  'DATABASE_UNCONFIGURED',
  'DATABASE_UNAVAILABLE',
  'CORPUS_UNAVAILABLE',
] as const
export type ReadinessErrorCode = (typeof READINESS_ERROR_CODES)[number]

/** 200 body of GET /health/ready. Failures use the error envelope with HTTP 503. */
export const readinessSchema = z.object({
  status: z.literal('ready'),
  checks: z.object({ database: z.literal('ok'), corpus: z.literal('ok') }),
})
export type Readiness = z.infer<typeof readinessSchema>

export const STAFF_ROLES = ['developer', 'admin'] as const
export const staffRoleSchema = z.enum(STAFF_ROLES)
export type StaffRole = z.infer<typeof staffRoleSchema>

/** 200 body of GET /admin/me: the verified staff identity (US01 protected test endpoint). */
export const adminMeSchema = z.object({
  userId: z.uuid(),
  role: staffRoleSchema,
  capabilities: z.array(z.string().min(1)).max(32),
})
export type AdminMe = z.infer<typeof adminMeSchema>

/** US02 proposal: shared with the future answer and citation services. */
export const disasterSchema = z.object({
  id: z.uuid(),
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
})
export const disastersResponseSchema = z.object({ disasters: z.array(disasterSchema).max(100) })
export type Disaster = z.infer<typeof disasterSchema>
export type DisastersResponse = z.infer<typeof disastersResponseSchema>

export const chatModeSchema = z.enum(['factual', 'appeal_explanation', 'comparison'])
export const chatRequestSchema = z.object({
  requestId: z.uuid(),
  disasterId: z.uuid(),
  question: z.string().trim().min(1).max(2_000),
  mode: chatModeSchema.optional(),
  campaignIds: z.array(z.uuid()).max(4).optional(),
})
export type ChatRequest = z.infer<typeof chatRequestSchema>

export const corpusSnapshotSchema = z.object({
  releaseId: z.uuid(),
  epoch: z.number().int().nonnegative(),
})
export const snapshotSchema = corpusSnapshotSchema.extend({
  asOf: z.iso.datetime({ offset: true }),
})

const publicSourceUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol
  return protocol === 'https:' || protocol === 'http:'
}, 'Source URL must use HTTP or HTTPS')

export const citationSchema = z.object({
  id: z.string().min(1).max(100),
  sourceVersionId: z.uuid(),
  title: z.string().min(1).max(500),
  sourceUrl: publicSourceUrlSchema.nullable(),
  publicationDate: z.iso.date().nullable(),
  reviewedAt: z.iso.datetime({ offset: true }),
  locator: z.string().min(1).max(500),
  excerpt: z.string().min(1).max(12_000),
})
export type Citation = z.infer<typeof citationSchema>

export const answerStatusSchema = z.enum([
  'supported',
  'partial',
  'insufficient_evidence',
  'extractive_fallback',
])
export const chatResponseSchema = z.object({
  requestId: z.uuid(),
  snapshot: snapshotSchema,
  mode: chatModeSchema,
  status: answerStatusSchema,
  retrievalMode: z.enum(['hybrid', 'lexical_only', 'registry']),
  claims: z.array(z.object({
    text: z.string().min(1).max(2_000),
    citationIds: z.array(z.string().min(1).max(100)).min(1).max(6),
  })).max(12),
  citations: z.array(citationSchema).max(6),
  limitations: z.array(z.string().min(1).max(1_000)).max(12),
}).refine(
  (response) => response.status !== 'insufficient_evidence' || response.claims.length === 0,
  { path: ['claims'], message: 'An insufficient-evidence response cannot contain answer claims' },
)
export type ChatResponse = z.infer<typeof chatResponseSchema>

/** US04 public excerpt response. Raw uploads and unpublished source text never belong here. */
export const sourceEvidenceResponseSchema = z.object({
  snapshot: snapshotSchema,
  sourceVersionId: citationSchema.shape.sourceVersionId,
  title: citationSchema.shape.title,
  sourceUrl: citationSchema.shape.sourceUrl,
  publicationDate: citationSchema.shape.publicationDate,
  reviewedAt: citationSchema.shape.reviewedAt,
  excerpts: z.array(z.object({
    locator: citationSchema.shape.locator,
    excerpt: citationSchema.shape.excerpt,
  })).min(1).max(20),
})
export type SourceEvidenceResponse = z.infer<typeof sourceEvidenceResponseSchema>

/** US13 deterministic appeal review. Classification fields are set only by the API. */
export const appealReviewRequestSchema = z.object({
  requestId: z.uuid(),
  disasterId: z.uuid(),
  input: z.string().trim().min(1).max(4_000),
})
export type AppealReviewRequest = z.infer<typeof appealReviewRequestSchema>

export const appealStatusSchema = z.enum([
  'documented_official_channel', 'published_warning_found', 'insufficient_evidence',
])
export const appealReasonSchema = z.enum([
  'MATCHED_OFFICIAL', 'MATCHED_WARNING', 'UNKNOWN_HOST', 'INVALID_TARGET', 'NO_TARGET',
  'MULTIPLE_TARGETS', 'EXPIRED_REVIEW', 'HISTORICAL_MATCH', 'RETRACTED_WARNING',
  'CONFLICTING_RECORDS', 'AMBIGUOUS_MATCH',
])
export const appealResultSchema = z.object({
  status: appealStatusSchema,
  reasonCodes: z.array(appealReasonSchema).min(1).max(8),
  targetHost: z.string().min(1).max(253).nullable(),
  scope: z.enum(['host', 'exact_url']).nullable(),
  matchedRecordIds: z.array(z.uuid()).max(20),
  citationIds: z.array(citationSchema.shape.id).max(20),
  historical: z.boolean(),
  conflict: z.boolean(),
})
export type AppealResult = z.infer<typeof appealResultSchema>

export const appealMatchSchema = z.object({
  recordVersionId: z.uuid(),
  kind: z.enum(['campaign', 'warning']),
  title: z.string().min(1).max(500),
  organizationName: z.string().min(1).max(300).nullable(),
  scope: z.enum(['host', 'exact_url']),
  officialChannelUrl: publicSourceUrlSchema.nullable(),
  publicationDate: citationSchema.shape.publicationDate,
  reviewedAt: citationSchema.shape.reviewedAt,
  historical: z.boolean(),
  retracted: z.boolean(),
  citationIds: z.array(citationSchema.shape.id).min(1).max(6),
})
export type AppealMatch = z.infer<typeof appealMatchSchema>

export const appealTargetSchema = z.object({
  targetHost: z.string().min(1).max(253),
  result: appealResultSchema,
  matches: z.array(appealMatchSchema).max(20),
})
export const appealReviewResponseSchema = z.object({
  requestId: z.uuid(),
  snapshot: snapshotSchema,
  result: appealResultSchema,
  targets: z.array(appealTargetSchema).max(10),
  citations: z.array(citationSchema).max(20),
})
export type AppealReviewResponse = z.infer<typeof appealReviewResponseSchema>

/**
 * US10 monitoring: GET /admin/metrics (admin only). Aggregates of relief.request_events metadata.
 * Every count is scoped to `window`; percentiles always travel with their sample count because a
 * p95 from a handful of requests is not meaningful (ai.md §12). There is no "accuracy" metric here:
 * evaluation results are a separate US09 report.
 */
export const ADMIN_METRICS_PATH = '/admin/metrics'
/** Matches the 14-day request-log retention (ai.md §10). */
export const METRICS_MAX_WINDOW_HOURS = 14 * 24

export const requestOutcomeSchema = z.enum([
  'supported', 'partial', 'insufficient_evidence', 'extractive_fallback',
  'documented_official_channel', 'published_warning_found',
])
export type RequestOutcome = z.infer<typeof requestOutcomeSchema>
export const retrievalModeSchema = chatResponseSchema.shape.retrievalMode

export const adminMetricsQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
}).refine((query) => !query.from || !query.to || Date.parse(query.from) < Date.parse(query.to), {
  path: ['from'], message: '`from` must be earlier than `to`',
}).refine((query) => !query.from || !query.to ||
  Date.parse(query.to) - Date.parse(query.from) <= METRICS_MAX_WINDOW_HOURS * 3_600_000, {
  path: ['from'], message: `The window can be at most ${METRICS_MAX_WINDOW_HOURS} hours`,
})
export type AdminMetricsQuery = z.infer<typeof adminMetricsQuerySchema>

const countSchema = z.number().int().nonnegative()
const latencySummarySchema = z.object({
  sampleCount: countSchema,
  /** null when sampleCount is 0. */
  p50Ms: z.number().nonnegative().nullable(),
  p95Ms: z.number().nonnegative().nullable(),
})
export type LatencySummary = z.infer<typeof latencySummarySchema>

export const adminMetricsResponseSchema = z.object({
  window: z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }),
  generatedAt: z.iso.datetime({ offset: true }),
  totals: z.object({
    requests: countSchema,
    /** 2xx responses. */
    succeeded: countSchema,
    /** 4xx excluding 429: validation, auth and not-found responses. */
    clientErrors: countSchema,
    /** 429 admission or provider quota limits. */
    quotaBlocked: countSchema,
    /** 5xx: a required dependency or the server failed. */
    infrastructureFailures: countSchema,
    /** 200 responses served in a degraded state: extractive fallback or lexical-only retrieval. */
    degraded: countSchema,
  }),
  outcomes: z.array(z.object({ outcome: requestOutcomeSchema, count: countSchema })).max(20),
  latency: latencySummarySchema,
  endpoints: z.array(latencySummarySchema.extend({
    endpoint: z.string().min(1).max(100),
    method: z.string().min(1).max(10),
    requests: countSchema,
    failures: countSchema,
  })).max(100),
  stages: z.array(latencySummarySchema.extend({ stage: z.string().min(1).max(32) })).max(20),
  byMode: z.array(z.object({ mode: chatModeSchema, count: countSchema })).max(10),
  byRetrievalMode: z.array(z.object({ retrievalMode: retrievalModeSchema, count: countSchema })).max(10),
  byDisaster: z.array(z.object({ disasterId: z.uuid(), count: countSchema })).max(100),
  /** Telemetry writes that failed or were dropped in this server process (ai.md §10 telemetry gaps). */
  telemetry: z.object({
    processStartedAt: z.iso.datetime({ offset: true }),
    droppedEvents: countSchema,
  }),
})
export type AdminMetricsResponse = z.infer<typeof adminMetricsResponseSchema>

/** US12 usage logs: safe request metadata only; never raw user input or credentials. */
export const ADMIN_LOGS_PATH = '/admin/logs'
export const LOGS_MAX_PAGE_SIZE = 100

const logFilterEnum = z.string().trim().min(1).max(100)
export const adminLogsQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  endpoint: logFilterEnum.optional(),
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']).optional(),
  statusCode: z.coerce.number().int().min(100).max(599).optional(),
  mode: chatModeSchema.optional(),
  outcome: requestOutcomeSchema.optional(),
  retrievalMode: retrievalModeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(LOGS_MAX_PAGE_SIZE).default(50),
  cursor: z.string().trim().min(1).max(512).optional(),
}).refine((query) => !query.from || !query.to || Date.parse(query.from) < Date.parse(query.to), {
  path: ['from'], message: '`from` must be earlier than `to`',
}).refine((query) => !query.from || !query.to ||
  Date.parse(query.to) - Date.parse(query.from) <= METRICS_MAX_WINDOW_HOURS * 3_600_000, {
  path: ['from'], message: `The window can be at most ${METRICS_MAX_WINDOW_HOURS} hours`,
})
export type AdminLogsQuery = z.infer<typeof adminLogsQuerySchema>

const safeMetadataRecordSchema = z.record(z.string().max(32), z.number().finite().nonnegative().max(600_000))
export const adminLogEntrySchema = z.object({
  requestId: z.uuid(),
  occurredAt: z.iso.datetime({ offset: true }),
  endpoint: z.string().min(1).max(100),
  method: z.string().min(1).max(10),
  statusCode: z.number().int().min(100).max(599),
  errorCode: z.string().regex(/^[A-Z0-9_]+$/u).max(64).nullable(),
  latencyMs: z.number().int().nonnegative().max(600_000),
  stageTimings: safeMetadataRecordSchema.nullable(),
  mode: chatModeSchema.nullable(),
  outcome: requestOutcomeSchema.nullable(),
  retrievalMode: retrievalModeSchema.nullable(),
  disasterId: z.uuid().nullable(),
  releaseId: z.uuid().nullable(),
  epoch: z.number().int().nonnegative().nullable(),
  providerUsage: z.record(z.string().max(32), z.number().finite().nonnegative().max(10_000_000)).nullable(),
})
export type AdminLogEntry = z.infer<typeof adminLogEntrySchema>

export const adminLogsResponseSchema = z.object({
  entries: z.array(adminLogEntrySchema).max(LOGS_MAX_PAGE_SIZE),
  nextCursor: z.string().min(1).max(512).nullable(),
  window: z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }),
  generatedAt: z.iso.datetime({ offset: true }),
  retentionDays: z.literal(14),
})
export type AdminLogsResponse = z.infer<typeof adminLogsResponseSchema>
