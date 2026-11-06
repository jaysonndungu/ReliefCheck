import { z } from 'zod'

export const API_PREFIX = '/api/v1'
export const LIVENESS_PATH = '/health/live'
export const READINESS_PATH = '/health/ready'
export const ADMIN_ME_PATH = '/admin/me'

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
