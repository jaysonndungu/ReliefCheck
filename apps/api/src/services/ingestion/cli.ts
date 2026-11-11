import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { datasetManifestSchema, sourceRecordSchema } from './manifest.js'
import { extractionSchema } from './extractionSchema.js'
import { preprocessDocument } from './preprocess.js'

const manifestPath = fileURLToPath(new URL('../../../../../data/drafts/source-manifest.json', import.meta.url))


async function readJson(path: string): Promise<unknown> {
  return JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/u, ''))
}

async function main() {
  const [command, path, ...rest] = process.argv.slice(2)
  if (rest.length || !(
    (command === 'validate' && !path) ||
    ((command === 'upsert' || command === 'preprocess') && path)
  )) throw new Error('Use validate, upsert <source.json>, or preprocess <extraction.json>')

  if (command === 'preprocess') {
    const { document, source } = extractionSchema.parse(await readJson(path))
    const result = preprocessDocument(document, source)
    console.log(JSON.stringify(result, null, 2))
    if (result.needsReview) process.exitCode = 2
    return
  }

  const manifest = datasetManifestSchema.parse(await readJson(manifestPath))
  if (command === 'validate') {
    console.log(`Valid draft manifest with ${manifest.sources.length} sources.`)
    return
  }

  const record = sourceRecordSchema.parse(await readJson(path))
  const index = manifest.sources.findIndex(source => source.id === record.id)
  if (index === -1) manifest.sources.push(record)
  else manifest.sources[index] = record

  const validated = datasetManifestSchema.parse(manifest)
  const temporary = `${manifestPath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(validated, null, 2) + '\n', { flag: 'wx' })
    await rename(temporary, manifestPath)
  } finally {
    await rm(temporary, { force: true })
  }
  console.log(`${index === -1 ? 'Added' : 'Updated'} ${record.id} in the draft manifest.`)
}

main().catch((error: unknown) => {
  if (error instanceof z.ZodError) {
    for (const issue of error.issues) console.error(`${issue.path.join('.') || 'input'}: ${issue.message}`)
  } else {
    console.error(error instanceof Error ? error.message : String(error))
  }
  process.exitCode = 1
})
