import {
  sourceEvidenceResponseSchema,
  type SourceEvidenceResponse,
} from '@reliefcheck/contracts'

type Snapshot = SourceEvidenceResponse['snapshot']
type PublicFields = Omit<SourceEvidenceResponse, 'snapshot'>

/** A future DB adapter must read the active release and membership consistently. */
export interface SourceEvidenceRepository {
  lookup(sourceVersionId: string): Promise<{
    snapshot: Snapshot | null
    record: (PublicFields & {
      reviewState: 'approved' | 'pending' | 'rejected'
      releaseState: 'published' | 'retired' | 'ready' | 'building' | 'failed'
      memberReleaseId: string | null
    }) | null
  }>
  currentSnapshot(): Promise<Snapshot | null>
}

export type SourceEvidenceResult =
  | { kind: 'found'; evidence: SourceEvidenceResponse }
  | { kind: 'corpus_unavailable' | 'unavailable' | 'changed' }

/** Applies the public evidence gate without relying on a browser or a model status. */
export async function getSourceEvidence(
  repository: SourceEvidenceRepository,
  sourceVersionId: string,
  expected?: { releaseId: string; epoch: number },
): Promise<SourceEvidenceResult> {
  const { snapshot, record } = await repository.lookup(sourceVersionId)
  if (!snapshot) return { kind: 'corpus_unavailable' }
  if (expected && (snapshot.releaseId !== expected.releaseId || snapshot.epoch !== expected.epoch)) {
    return { kind: 'changed' }
  }
  if (
    !record || record.sourceVersionId !== sourceVersionId || record.reviewState !== 'approved' ||
    record.releaseState !== 'published' || record.memberReleaseId !== snapshot.releaseId
  ) {
    return { kind: 'unavailable' }
  }

  const current = await repository.currentSnapshot()
  if (!current || current.releaseId !== snapshot.releaseId || current.epoch !== snapshot.epoch) {
    return { kind: 'changed' }
  }

  const parsed = sourceEvidenceResponseSchema.safeParse({
    snapshot,
    sourceVersionId: record.sourceVersionId,
    title: record.title,
    sourceUrl: record.sourceUrl,
    publicationDate: record.publicationDate,
    reviewedAt: record.reviewedAt,
    excerpts: record.excerpts,
  })
  if (!parsed.success) return { kind: 'unavailable' }
  return { kind: 'found', evidence: parsed.data }
}
