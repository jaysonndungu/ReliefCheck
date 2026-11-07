import { existsSync } from 'node:fs'
import { join } from 'node:path'
import express, { type Express } from 'express'
import { API_PREFIX } from '@reliefcheck/contracts'
import { errorHandler, requestId, sendError } from './http/errors.js'
import { healthRouter, type ReadinessProbe } from './routes/health.js'
import { adminRouter } from './routes/admin.js'
import type { StaffAuthDeps } from './middleware/staffAuth.js'

export type AppDeps = {
  /** null when no database is configured: readiness reports DATABASE_UNCONFIGURED. */
  readiness: ReadinessProbe | null
  /** null when auth or the database is not configured: staff routes fail closed. */
  staffAuth: StaffAuthDeps | null
  /** Built web assets directory; the UI is served only when it contains index.html. */
  webDist: string | null
}

export function createApp(deps: AppDeps): Express {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', false)

  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Frame-Options', 'DENY')
    next()
  })
  app.use(requestId)

  const api = express.Router()
  api.use(healthRouter(deps.readiness))
  api.use(adminRouter(deps.staffAuth))
  api.use((_request, response) => {
    sendError(response, 404, 'NOT_FOUND', 'API route not found.', false)
  })
  app.use(API_PREFIX, api)

  const indexPath = deps.webDist ? join(deps.webDist, 'index.html') : null
  if (deps.webDist && indexPath && existsSync(indexPath)) {
    app.use(express.static(deps.webDist, { index: false }))
    // SPA fallback so deep links such as /compare work on the hosted URL.
    app.get('/{*page}', (request, response, next) => {
      if (request.accepts('html')) {
        response.setHeader('Cache-Control', 'no-cache')
        response.sendFile(indexPath)
        return
      }
      next()
    })
  }

  app.use(errorHandler)
  return app
}
