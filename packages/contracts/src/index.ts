import { z } from 'zod'

export const API_PREFIX = '/api/v1'
export const LIVENESS_PATH = '/health/live'
export const READINESS_PATH = '/health/ready'

export const livenessSchema = z.object({ status: z.literal('ok') })
