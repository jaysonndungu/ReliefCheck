import {
  API_PREFIX,
  SOURCES_PATH,
  sourceEvidenceResponseSchema,
  type SourceEvidenceResponse,
} from '@reliefcheck/contracts'
import { ApiError, handleResponse } from '../../lib/api'

export async function loadSourceEvidence(
  sourceVersionId: string,
  expected: { releaseId: string; epoch: number } | null,
  signal: AbortSignal,
): Promise<SourceEvidenceResponse> {
  const params = new URLSearchParams()
  if (expected) {
    params.set('releaseId', expected.releaseId)
    params.set('epoch', String(expected.epoch))
  }
  const suffix = params.size ? `?${params}` : ''
  try {
    const response = await fetch(`${API_PREFIX}${SOURCES_PATH}/${encodeURIComponent(sourceVersionId)}${suffix}`, {
      signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })
    const parsed = sourceEvidenceResponseSchema.safeParse(await handleResponse(response))
    if (!parsed.success || parsed.data.sourceVersionId !== sourceVersionId ||
        (expected && (parsed.data.snapshot.releaseId !== expected.releaseId || parsed.data.snapshot.epoch !== expected.epoch))) {
      throw new ApiError('INVALID_RESPONSE', 'The source response is invalid.', true)
    }
    return parsed.data
  } catch (error) {
    if (error instanceof ApiError || signal.aborted) throw error
    throw new ApiError('NETWORK_ERROR', 'The source service could not be reached.', true)
  }
}
