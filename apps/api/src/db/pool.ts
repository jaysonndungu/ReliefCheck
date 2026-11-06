import pg from 'pg'
import type { ServerConfig } from '../config/env.js'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * Creates the request-handler pool (ai.md §2): 3 connections, verified TLS for any
 * non-local host, bounded statements. Migration credentials never come through here.
 */
export function createPool(database: NonNullable<ServerConfig['database']>): pg.Pool {
  const host = new URL(database.url).hostname
  const ssl = LOCAL_HOSTS.has(host)
    ? false
    : { rejectUnauthorized: true, ...(database.caCert ? { ca: database.caCert } : {}) }

  const pool = new pg.Pool({
    connectionString: database.url,
    ssl,
    max: 3,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 5_000,
    query_timeout: 6_000,
  })
  // An idle client error must not crash the process; readiness reports the outage.
  pool.on('error', () => {
    console.error('Database pool reported an idle client error.')
  })
  return pool
}
