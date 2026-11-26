import {
  adminLogEntrySchema, adminLogsResponseSchema, type AdminLogEntry, type AdminLogsQuery,
} from '@reliefcheck/contracts'

export type LogsWindow = { from: Date; to: Date }
export type RequestLogsFilter = LogsWindow & Omit<AdminLogsQuery, 'from' | 'to' | 'cursor' | 'limit'>

export type RequestLogsRepository = {
  list: (input: {
    filter: RequestLogsFilter
    limit: number
    cursor: { occurredAt: Date; requestId: string } | null
  }) => Promise<{ entries: AdminLogEntry[]; hasMore: boolean }>
  deleteBefore: (cutoff: Date, limit: number) => Promise<number>
}

export type LogCursor = { occurredAt: Date; requestId: string }

export function encodeLogCursor(cursor: LogCursor): string {
  return Buffer.from(JSON.stringify({ occurredAt: cursor.occurredAt.toISOString(), requestId: cursor.requestId }), 'utf8')
    .toString('base64url')
}

export function decodeLogCursor(value: string): LogCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const candidate = parsed as { occurredAt?: unknown; requestId?: unknown }
    if (typeof candidate.occurredAt !== 'string' || typeof candidate.requestId !== 'string') return null
    const occurredAt = new Date(candidate.occurredAt)
    if (!Number.isFinite(occurredAt.getTime()) || !/^[0-9a-f-]{36}$/iu.test(candidate.requestId)) return null
    return { occurredAt, requestId: candidate.requestId }
  } catch {
    return null
  }
}

export function buildLogsResponse(
  result: { entries: AdminLogEntry[]; hasMore: boolean },
  window: LogsWindow,
  query: { limit: number },
  now: Date,
): ReturnType<typeof adminLogsResponseSchema.parse> {
  const entries = result.entries.map((entry) => adminLogEntrySchema.parse(entry))
  const last = entries.at(-1)
  return adminLogsResponseSchema.parse({
    entries,
    nextCursor: result.hasMore && last ? encodeLogCursor({ occurredAt: new Date(last.occurredAt), requestId: last.requestId }) : null,
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    generatedAt: now.toISOString(),
    retentionDays: 14,
  })
}
