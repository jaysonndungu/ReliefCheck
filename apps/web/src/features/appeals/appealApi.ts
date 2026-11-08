import {
  API_PREFIX, APPEALS_REVIEW_PATH, appealReviewRequestSchema, appealReviewResponseSchema,
  type AppealReviewRequest, type AppealReviewResponse,
} from '@reliefcheck/contracts'
import { ApiError, handleResponse } from '../../lib/api'

export async function reviewAppeal(request: AppealReviewRequest, signal: AbortSignal): Promise<AppealReviewResponse> {
  const payload = appealReviewRequestSchema.parse(request)
  try {
    const response = await fetch(`${API_PREFIX}${APPEALS_REVIEW_PATH}`, {
      method: 'POST', signal, cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const parsed = appealReviewResponseSchema.safeParse(await handleResponse(response))
    if (!parsed.success || parsed.data.requestId !== payload.requestId) {
      throw new ApiError('INVALID_RESPONSE', 'The appeal review response is invalid.', true)
    }
    const known = new Set(parsed.data.citations.map((citation) => citation.id))
    const referenced = [parsed.data.result.citationIds,
      ...parsed.data.targets.flatMap((target) => [target.result.citationIds, ...target.matches.map((match) => match.citationIds)])]
    if (referenced.some((ids) => ids.some((id) => !known.has(id)))) {
      throw new ApiError('INVALID_RESPONSE', 'The appeal review response is invalid.', true)
    }
    return parsed.data
  } catch (error) {
    if (error instanceof ApiError || signal.aborted) throw error
    throw new ApiError('NETWORK_ERROR', 'The appeal review service could not be reached.', true)
  }
}
