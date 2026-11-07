import { randomUUID } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import type { ErrorEnvelope } from '@reliefcheck/contracts'

/** Assigns a tracing ID to every request. It is for tracing, never authorization. */
export function requestId(_request: Request, response: Response, next: NextFunction) {
  const id = randomUUID()
  response.locals.requestId = id
  response.setHeader('X-Request-Id', id)
  next()
}

export function sendError(
  response: Response,
  status: number,
  code: string,
  message: string,
  retryable: boolean,
  retryAfterSeconds?: number,
) {
  const body: ErrorEnvelope = {
    error: { code, message, retryable, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) },
    requestId: (response.locals.requestId as string | undefined) ?? randomUUID(),
  }
  if (retryAfterSeconds !== undefined) response.setHeader('Retry-After', String(retryAfterSeconds))
  response.status(status).json(body)
}

/** Final error handler: no stack traces, provider internals or request bodies in output or logs. */
export function errorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  next: NextFunction,
) {
  if (response.headersSent) {
    next(error)
    return
  }
  const status =
    typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
      ? error.status
      : 500
  if (status >= 400 && status < 500) {
    sendError(response, status, 'BAD_REQUEST', 'The request could not be processed.', false)
    return
  }
  console.error(`Unhandled API error (requestId ${String(response.locals.requestId)})`)
  sendError(response, 500, 'INTERNAL_ERROR', 'An unexpected error occurred.', true)
}
