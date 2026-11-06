import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import express from 'express'
import {
  API_PREFIX,
  LIVENESS_PATH,
  READINESS_PATH,
  livenessSchema,
} from '@reliefcheck/contracts'

const app = express()
const api = express.Router()
const port = Number(process.env.PORT ?? 3000)
const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url))

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535.')
}

app.disable('x-powered-by')

api.get(LIVENESS_PATH, (_request, response) => {
  response.json(livenessSchema.parse({ status: 'ok' }))
})

api.get(READINESS_PATH, (_request, response) => {
  response.status(503).json({
    error: {
      code: 'CORPUS_UNAVAILABLE',
      message: 'The reviewed corpus is not available in this starter.',
      retryable: false,
    },
    requestId: randomUUID(),
  })
})

api.use((_request, response) => {
  response.status(404).json({
    error: { code: 'NOT_FOUND', message: 'API route not found.', retryable: false },
    requestId: randomUUID(),
  })
})

app.use(API_PREFIX, api)

const indexPath = fileURLToPath(new URL('../../web/dist/index.html', import.meta.url))
if (existsSync(indexPath)) {
  app.use(express.static(webRoot))
  app.get('/{*page}', (request, response, next) => {
    if (request.accepts('html')) {
      response.sendFile(indexPath)
      return
    }
    next()
  })
}

app.listen(port, () => {
  console.log(`ReliefCheck API listening on port ${port}`)
})
