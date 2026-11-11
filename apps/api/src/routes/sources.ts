import { Router } from 'express'
import { z } from 'zod'
import { SOURCES_PATH } from '@reliefcheck/contracts'
import { sendError } from '../http/errors.js'
import { getSourceEvidence, type SourceEvidenceRepository } from '../services/sources/sourceEvidence.js'

const querySchema = z.object({
  releaseId: z.uuid().optional(),
  epoch: z.string().regex(/^\d+$/u).transform(Number).pipe(z.number().int().nonnegative()).optional(),
}).refine((value) => (value.releaseId === undefined) === (value.epoch === undefined))

export function sourcesRouter(repository: SourceEvidenceRepository | null): Router {
  const router = Router()
  router.get(`${SOURCES_PATH}/:sourceVersionId`, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const id = z.uuid().safeParse(request.params.sourceVersionId)
    const query = querySchema.safeParse(request.query)
    if (!id.success || !query.success) {
      sendError(response, 400, 'BAD_REQUEST', 'Invalid source reference.', false)
      return
    }
    if (!repository) {
      sendError(response, 503, 'SOURCE_EVIDENCE_UNAVAILABLE', 'Reviewed source evidence is not configured.', true)
      return
    }

    try {
      const expected = query.data.releaseId && query.data.epoch !== undefined
        ? { releaseId: query.data.releaseId, epoch: query.data.epoch }
        : undefined
      const result = await getSourceEvidence(repository, id.data, expected)
      if (result.kind === 'found') {
        response.json(result.evidence)
      } else if (result.kind === 'corpus_unavailable') {
        sendError(response, 503, 'CORPUS_UNAVAILABLE', 'No reviewed knowledge base is published.', false)
      } else if (result.kind === 'changed') {
        sendError(response, 409, 'KB_CHANGED', 'The published evidence changed. Refresh the answer.', true)
      } else {
        sendError(response, 404, 'SOURCE_UNAVAILABLE', 'This source is not available in the published evidence.', false)
      }
    } catch {
      sendError(response, 503, 'SOURCE_EVIDENCE_UNAVAILABLE', 'Reviewed source evidence is temporarily unavailable.', true)
    }
  })
  return router
}
