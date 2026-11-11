import { z } from 'zod'
import { sourceRecordSchema } from './manifest.js'

export const extractionSchema = z.strictObject({
  source: sourceRecordSchema,
  document: z.strictObject({
    sourceId: z.string(),
    contentHash: z.string(),
    title: z.string().trim().min(1),
    language: sourceRecordSchema.shape.language,
    publicationDate: sourceRecordSchema.shape.publicationDate,
    retrievedAt: z.iso.datetime({ offset: true }),
    blocks: z.array(z.strictObject({
      text: z.string(),
      page: z.number().int().positive().nullable(),
      heading: z.string().nullable(),
    })),
    warnings: z.array(z.string()),
  }),
})
