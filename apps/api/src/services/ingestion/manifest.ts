import { isIP } from 'node:net'
import { z } from 'zod'

const nonBlank = z.string().trim().min(1)

function isSourceUrl(value: string): boolean {
  if (!/^https:\/\//i.test(value) || /[\s\\]/u.test(value) || /%(?![\da-f]{2})/i.test(value)) {
    return false
  }

  try {
    const url = new URL(value)
    const host = url.hostname.replace(/\.$/, '')
    return !url.username && !url.password && !url.port &&
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(host) &&
      !host.endsWith('.localhost') && !isIP(host)
  } catch {
    return false
  }
}

const referenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('web'), url: z.string().refine(isSourceUrl, 'Expected an HTTPS source URL without credentials, an IP address, or a custom port') }),
  z.strictObject({
    kind: z.literal('file'),
    path: nonBlank.refine(
      path => !/[\\:\x00-\x1f\x7f]/u.test(path) &&
        path.split('/').every(part => part && part !== '.' && part !== '..'),
      'Expected a relative file reference without traversal',
    ),
  }),
])

export const sourceRecordSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  title: nonBlank,
  reference: referenceSchema,
  publisher: nonBlank.nullable(),
  disaster: z.enum(['valencia-dana', 'hurricane-melissa']),
  sourceType: z.enum(['background', 'campaign', 'warning']),
  language: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).nullable(),
  publicationDate: z.iso.date().nullable(),
  reviewStatus: z.enum(['pending', 'approved', 'rejected']),
  reviewedBy: nonBlank.nullable(),
  reviewedAt: z.iso.datetime({ offset: true }).nullable(),
  notes: nonBlank,
}).superRefine((source, ctx) => {
  const pending = source.reviewStatus === 'pending'
  for (const field of ['reviewedBy', 'reviewedAt'] as const) {
    if (pending !== (source[field] === null)) {
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: pending ? 'Pending sources must have null review metadata' : 'Record the actual reviewer and review time',
      })
    }
  }
})

export const datasetManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sources: z.array(sourceRecordSchema),
}).superRefine(({ sources }, ctx) => {
  const seen = new Set<string>()
  sources.forEach(({ id }, index) => {
    const key = id.toLowerCase()
    if (seen.has(key)) {
      ctx.addIssue({ code: 'custom', path: ['sources', index, 'id'], message: `Duplicate source ID: ${id}` })
    }
    seen.add(key)
  })
})

export type SourceRecord = z.infer<typeof sourceRecordSchema>
