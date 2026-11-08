import { z } from 'zod'

export const API_PREFIX = '/api/v1'
export const LIVENESS_PATH = '/health/live'
export const READINESS_PATH = '/health/ready'
export const ADMIN_ME_PATH = '/admin/me'
export const DISASTERS_PATH = '/disasters'
export const CHAT_PATH = '/chat'
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

export const snapshotSchema = z.object({
  releaseId: z.uuid(),
  epoch: z.number().int().nonnegative(),
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
