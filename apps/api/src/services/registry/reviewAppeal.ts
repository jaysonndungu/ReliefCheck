import { isIP } from 'node:net'
import {
  appealReviewResponseSchema, citationSchema,
  type AppealMatch, type AppealResult, type AppealReviewRequest, type AppealReviewResponse,
  type Citation,
} from '@reliefcheck/contracts'

type Snapshot = AppealReviewResponse['snapshot']

/** Read model for Anson's future registry adapter; no draft or raw source data belongs here. */
export type ReviewedRegistryRecord = {
  recordVersionId: string
  disasterId: string
  memberReleaseId: string | null
  reviewState: 'approved' | 'pending' | 'rejected'
  kind: 'campaign' | 'warning'
  title: string
  organizationName: string | null
  matchScope: 'host' | 'exact_url'
  matchValue: string
  normalizedHostname: string
  officialChannelUrl: string | null
  publicationDate: string | null
  reviewedAt: string
  reviewExpiresAt: string | null
  effectiveFrom: string | null
  effectiveUntil: string | null
  warningRetracted: boolean
  evidence: Array<{
    citation: Citation
    sourceReviewState: 'approved' | 'pending' | 'rejected'
    memberReleaseId: string | null
    sourceDisasterIds: string[]
  }>
}

export interface AppealRegistryRepository {
  lookup(disasterId: string): Promise<{ snapshot: Snapshot | null; records: ReviewedRegistryRecord[] }>
  currentSnapshot(): Promise<Snapshot | null>
}

type Target = { host: string; canonicalUrl: string }

/** WHATWG/IDNA canonicalization. Never fetches or follows a submitted URL. */
export function normalizeTarget(raw: string): Target | null {
  const value = raw.trim()
  if (!value || /%(?![0-9a-fA-F]{2})/u.test(value)) return null
  const bareHost = !value.includes('://') && /^[^\s/:?#@]+$/u.test(value) && value.includes('.')
  if (!bareHost && !/^https?:\/\//iu.test(value)) return null
  const authority = bareHost ? value : /^https?:\/\/([^/?#]*)/iu.exec(value)?.[1]
  if (!authority || authority.includes('%')) return null
  try {
    const url = new URL(bareHost ? `https://${value}` : value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null
    const host = url.hostname.toLowerCase().replace(/\.$/u, '')
    if (!host || host.endsWith('.') || isIP(host.replace(/^\[|\]$/gu, ''))) return null
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(host)) return null
    url.hostname = host
    url.hash = ''
    return { host, canonicalUrl: url.href }
  } catch {
    return null
  }
}

function extractTargets(input: string): { targets: Target[]; invalid: boolean } {
  const trimmed = input.trim()
  // Preserve every URL character. Dropping punctuation could turn an unreviewed
  // destination into an exact-URL match for a different reviewed destination.
  const links = [...trimmed.matchAll(/https?:\/\/[^\s<>"']+/giu)].map((match) => match[0])
  const candidates = links.length ? links : [trimmed]
  const targets: Target[] = []
  let invalid = false
  for (const candidate of candidates) {
    const target = normalizeTarget(candidate)
    if (!target) { invalid = true; continue }
    if (!targets.some((existing) => existing.canonicalUrl === target.canonicalUrl)) targets.push(target)
  }
  return { targets: targets.slice(0, 10), invalid: invalid || candidates.length > 10 }
}

function validEvidence(record: ReviewedRegistryRecord, releaseId: string, disasterId: string): Citation[] {
  const found = new Map<string, Citation>()
  for (const item of record.evidence) {
    if (item.sourceReviewState !== 'approved' || item.memberReleaseId !== releaseId ||
        !item.sourceDisasterIds.includes(disasterId)) continue
    const citation = citationSchema.safeParse(item.citation)
    if (citation.success) {
      const existing = found.get(citation.data.id)
      if (existing && JSON.stringify(existing) !== JSON.stringify(citation.data)) {
        throw new Error('Conflicting reviewed citation IDs')
      }
      found.set(citation.data.id, citation.data)
    }
  }
  return [...found.values()].slice(0, 6)
}

function currentCampaign(record: ReviewedRegistryRecord, now: number): boolean {
  const expiry = record.reviewExpiresAt ? Date.parse(record.reviewExpiresAt) : NaN
  const reviewed = Date.parse(record.reviewedAt)
  if (!Number.isFinite(expiry) || !Number.isFinite(reviewed) || reviewed > now || expiry <= now ||
      reviewed + 30 * 24 * 60 * 60 * 1_000 <= now) return false
  if (record.effectiveFrom) {
    const starts = Date.parse(record.effectiveFrom)
    if (!Number.isFinite(starts) || starts > now) return false
  }
  if (record.effectiveUntil) {
    const ends = Date.parse(record.effectiveUntil)
    if (!Number.isFinite(ends) || ends <= now) return false
  }
  return true
}

function matchesTarget(record: ReviewedRegistryRecord, target: Target): boolean {
  const reviewedTarget = normalizeTarget(record.matchValue)
  if (!reviewedTarget || reviewedTarget.host !== record.normalizedHostname || reviewedTarget.host !== target.host) return false
  if (record.matchScope === 'exact_url' && reviewedTarget.canonicalUrl !== target.canonicalUrl) return false
  if (record.kind === 'campaign') {
    const destination = record.officialChannelUrl && normalizeTarget(record.officialChannelUrl)
    if (!destination || destination.host !== record.normalizedHostname) return false
  }
  return true
}

function result(status: AppealResult['status'], reasons: AppealResult['reasonCodes'], targetHost: string | null,
  matches: AppealMatch[], conflict = false): AppealResult {
  return {
    status, reasonCodes: reasons, targetHost,
    scope: matches.length === 1 ? matches[0]!.scope : null,
    matchedRecordIds: matches.map((match) => match.recordVersionId),
    citationIds: [...new Set(matches.flatMap((match) => match.citationIds))],
    historical: matches.some((match) => match.historical), conflict,
  }
}

export type AppealReviewOutcome =
  | { kind: 'reviewed'; response: AppealReviewResponse }
  | { kind: 'corpus_unavailable' | 'changed' }

export async function reviewAppeal(
  repository: AppealRegistryRepository,
  request: AppealReviewRequest,
  now = new Date(),
): Promise<AppealReviewOutcome> {
  const { snapshot, records } = await repository.lookup(request.disasterId)
  if (!snapshot) return { kind: 'corpus_unavailable' }
  const extracted = extractTargets(request.input)
  const citations = new Map<string, Citation>()
  const targets = extracted.targets.map((target) => {
    const matches: AppealMatch[] = []
    for (const record of records) {
      if (record.disasterId !== request.disasterId || record.memberReleaseId !== snapshot.releaseId ||
          record.reviewState !== 'approved' || !matchesTarget(record, target)) continue
      const evidence = validEvidence(record, snapshot.releaseId, request.disasterId)
      if (!evidence.length) continue
      const historical = record.kind === 'warning' ? record.warningRetracted : !currentCampaign(record, now.getTime())
      const match: AppealMatch = {
        recordVersionId: record.recordVersionId, kind: record.kind, title: record.title,
        organizationName: record.organizationName, scope: record.matchScope,
        officialChannelUrl: record.kind === 'campaign' ? record.officialChannelUrl : null,
        publicationDate: record.publicationDate, reviewedAt: record.reviewedAt,
        historical, retracted: record.kind === 'warning' && record.warningRetracted,
        citationIds: evidence.map((item) => item.id),
      }
      matches.push(match)
      evidence.forEach((item) => {
        const existing = citations.get(item.id)
        if (existing && JSON.stringify(existing) !== JSON.stringify(item)) {
          throw new Error('Conflicting reviewed citation IDs')
        }
        citations.set(item.id, item)
      })
    }
    const activeWarnings = matches.filter((match) => match.kind === 'warning' && !match.retracted)
    const activeCampaigns = matches.filter((match) => match.kind === 'campaign' && !match.historical)
    let decision: AppealResult
    if (activeWarnings.length && activeCampaigns.length) {
      decision = result('insufficient_evidence', ['CONFLICTING_RECORDS'], target.host, matches, true)
    } else if (activeWarnings.length) {
      decision = result('published_warning_found', ['MATCHED_WARNING'], target.host, matches)
    } else if (activeCampaigns.length === 1) {
      decision = result('documented_official_channel', ['MATCHED_OFFICIAL'], target.host, matches)
    } else if (activeCampaigns.length > 1) {
      decision = result('insufficient_evidence', ['AMBIGUOUS_MATCH'], target.host, matches)
    } else if (matches.some((match) => match.kind === 'campaign')) {
      decision = result('insufficient_evidence', ['EXPIRED_REVIEW', 'HISTORICAL_MATCH'], target.host, matches)
    } else if (matches.some((match) => match.retracted)) {
      decision = result('insufficient_evidence', ['RETRACTED_WARNING', 'HISTORICAL_MATCH'], target.host, matches)
    } else {
      decision = result('insufficient_evidence', ['UNKNOWN_HOST'], target.host, matches)
    }
    return { targetHost: target.host, result: decision, matches }
  })

  const aggregate = targets.length === 1 && !extracted.invalid
    ? targets[0]!.result
    : result('insufficient_evidence',
      targets.length > 1 ? ['MULTIPLE_TARGETS'] : [extracted.invalid ? 'INVALID_TARGET' : 'NO_TARGET'],
      null, targets.flatMap((target) => target.matches))

  const current = await repository.currentSnapshot()
  if (!current || current.releaseId !== snapshot.releaseId || current.epoch !== snapshot.epoch) return { kind: 'changed' }
  if (citations.size > 20) throw new Error('Reviewed citation limit exceeded')
  const response = appealReviewResponseSchema.parse({
    requestId: request.requestId, snapshot, result: aggregate, targets,
    citations: [...citations.values()],
  })
  return { kind: 'reviewed', response }
}
