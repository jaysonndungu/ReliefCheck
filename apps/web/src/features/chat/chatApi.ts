import {
  API_PREFIX,
  CHAT_PATH,
  DISASTERS_PATH,
  chatRequestSchema,
  chatResponseSchema,
  disastersResponseSchema,
  errorEnvelopeSchema,
  type ChatRequest,
  type ChatResponse,
  type Disaster,
} from '@reliefcheck/contracts'

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new ApiError('INVALID_RESPONSE', 'The service returned an unreadable response.', true)
  }
}

async function handleResponse(response: Response): Promise<unknown> {
  const body = await readJson(response)
  if (!response.ok) {
    const parsed = errorEnvelopeSchema.safeParse(body)
    if (parsed.success) {
      const { code, message, retryable, retryAfterSeconds } = parsed.data.error
      throw new ApiError(code, message, retryable, retryAfterSeconds)
    }
    throw new ApiError('INVALID_RESPONSE', 'The service returned an invalid error response.', true)
  }
  return body
}

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
