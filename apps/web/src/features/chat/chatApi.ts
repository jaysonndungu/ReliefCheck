import {
  API_PREFIX,
  CHAT_PATH,
  DISASTERS_PATH,
  chatRequestSchema,
  chatResponseSchema,
  disastersResponseSchema,
  type ChatRequest,
  type ChatResponse,
  type Disaster,
} from '@reliefcheck/contracts'
import { ApiError, handleResponse } from '../../lib/api'

export async function getDisasters(signal: AbortSignal): Promise<Disaster[]> {
  try {
    const response = await fetch(`${API_PREFIX}${DISASTERS_PATH}`, {
      signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })
    const parsed = disastersResponseSchema.safeParse(await handleResponse(response))
    if (!parsed.success) throw new ApiError('INVALID_RESPONSE', 'The disaster list is invalid.', true)
    return parsed.data.disasters
  } catch (error) {
    if (error instanceof ApiError || signal.aborted) throw error
    throw new ApiError('NETWORK_ERROR', 'The service could not be reached.', true)
  }
}

export async function askQuestion(request: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
  const payload = chatRequestSchema.parse(request)
  try {
    const response = await fetch(`${API_PREFIX}${CHAT_PATH}`, {
      method: 'POST',
      signal,
      cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const parsed = chatResponseSchema.safeParse(await handleResponse(response))
    if (!parsed.success || parsed.data.requestId !== payload.requestId || parsed.data.mode !== 'factual') {
      throw new ApiError('INVALID_RESPONSE', 'The answer response is invalid.', true)
    }
    const knownCitations = new Set(parsed.data.citations.map((citation) => citation.id))
    if (parsed.data.claims.some((claim) => claim.citationIds.some((id) => !knownCitations.has(id)))) {
      throw new ApiError('INVALID_RESPONSE', 'The answer response is invalid.', true)
    }
    return parsed.data
  } catch (error) {
    if (error instanceof ApiError || signal.aborted) throw error
    throw new ApiError('NETWORK_ERROR', 'The service could not be reached.', true)
  }
}
