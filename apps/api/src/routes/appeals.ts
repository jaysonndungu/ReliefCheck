import { Router, json } from 'express'
import { APPEALS_REVIEW_PATH, appealReviewRequestSchema } from '@reliefcheck/contracts'
import { sendError } from '../http/errors.js'
import { reviewAppeal, type AppealRegistryRepository } from '../services/registry/reviewAppeal.js'

export function appealsRouter(repository: AppealRegistryRepository | null): Router {
  const router = Router()
  router.post(APPEALS_REVIEW_PATH, json({ limit: '8kb' }), async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const input = appealReviewRequestSchema.safeParse(request.body)
    if (!input.success) {
      const oversized = typeof request.body?.input === 'string' && request.body.input.length > 4_000
      sendError(response, oversized ? 413 : 400, 'INVALID_APPEAL_INPUT',
        'Select a disaster and enter a URL or appeal text of at most 4,000 characters.', false)
      return
    }
    if (!repository) {
      sendError(response, 503, 'APPEAL_REVIEW_UNAVAILABLE', 'Reviewed appeal records are not configured.', true)
      return
    }
    try {
      const outcome = await reviewAppeal(repository, input.data)
      if (outcome.kind === 'reviewed') response.json(outcome.response)
      else if (outcome.kind === 'corpus_unavailable') {
        sendError(response, 503, 'CORPUS_UNAVAILABLE', 'No reviewed knowledge base is published.', false)
      } else sendError(response, 409, 'KB_CHANGED', 'The published evidence changed. Review the appeal again.', true)
    } catch {
      sendError(response, 503, 'APPEAL_REVIEW_UNAVAILABLE', 'Appeal review is temporarily unavailable.', true)
    }
  })
  return router
}
