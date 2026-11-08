import { errorEnvelopeSchema } from '@reliefcheck/contracts'

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

export async function handleResponse(response: Response): Promise<unknown> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ApiError('INVALID_RESPONSE', 'The service returned an unreadable response.', true)
  }
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
