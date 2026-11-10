import { Router, json } from 'express'
import { CHAT_PATH, chatRequestSchema } from '@reliefcheck/contracts'
import { sendError } from '../http/errors.js'
import { answerQuestion, type AnswerDeps } from '../services/generation/answerQuestion.js'
import { containsUrl } from '../services/generation/redact.js'

/** POST /api/v1/chat — US03 grounded factual answers. `deps` is null until retrieval is wired. */
export function chatRouter(deps: AnswerDeps | null): Router {
  const router = Router()
  router.post(CHAT_PATH, json({ limit: '16kb' }), async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const input = chatRequestSchema.safeParse(request.body)
    if (!input.success) {
      const oversized = typeof request.body?.question === 'string' && request.body.question.length > 2_000
      sendError(response, oversized ? 413 : 400, 'INVALID_CHAT_INPUT',
        'Select a disaster and enter a question of at most 2,000 characters.', false)
      return
    }
    // appeal_explanation and comparison modes arrive with the US08 router. Until then, fail
    // closed instead of answering a link or comparison from prose similarity.
    if ((input.data.mode && input.data.mode !== 'factual') || input.data.campaignIds?.length) {
      sendError(response, 422, 'MODE_UNAVAILABLE', 'Only general questions are supported in chat right now.', false)
      return
    }
    if (containsUrl(input.data.question)) {
      sendError(response, 422, 'APPEAL_REVIEW_REQUIRED',
        'Questions about a specific link are checked on the Check an Appeal page.', false)
      return
    }
    if (!deps) {
      sendError(response, 503, 'CHAT_UNAVAILABLE', 'Reviewed evidence search is not configured.', true)
      return
    }

    const controller = new AbortController()
    response.on('close', () => { if (!response.writableFinished) controller.abort() })
    try {
      const outcome = await answerQuestion(deps, input.data, controller.signal)
      if (outcome.kind === 'answered') response.json(outcome.response)
      else if (outcome.kind === 'corpus_unavailable') {
        sendError(response, 503, 'CORPUS_UNAVAILABLE', 'No reviewed knowledge base is published.', false)
      } else {
        sendError(response, 409, 'KB_CHANGED', 'The published evidence changed. Ask your question again.', true)
      }
    } catch {
      // No request body, question text or provider details are logged or returned.
      sendError(response, 503, 'CHAT_UNAVAILABLE', 'Answering is temporarily unavailable.', true)
    }
  })
  return router
}
