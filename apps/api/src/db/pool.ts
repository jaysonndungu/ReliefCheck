import pg from 'pg'
import type { ServerConfig } from '../config/env.js'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * Creates the request-handler pool (ai.md §2): 3 connections, verified TLS for any
 * non-local host, bounded statements. Migration credentials never come through here.
 */
export function createPool(database: NonNullable<ServerConfig['database']>): pg.Pool {
  let url: URL
  try {
    url = new URL(database.url)
  } catch {
    throw new Error('DATABASE_URL must be a valid Postgres connection URL.')
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash) {
    throw new Error('DATABASE_URL must be a valid Postgres connection URL.')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const local = LOCAL_HOSTS.has(host)
  const allowedModes = local ? ['disable', 'prefer', 'require', 'verify-full'] : ['require', 'verify-full']
  for (const [name, value] of url.searchParams) {
    if (name !== 'application_name' && !(name === 'sslmode' && allowedModes.includes(value))) {
      throw new Error('DATABASE_URL contains unsupported connection options.')
    }
  }
  // pg otherwise lets parameters in the URL replace the explicit TLS configuration.
  url.searchParams.delete('sslmode')
  const ssl = local
    ? false
    : { rejectUnauthorized: true, ...(database.caCert ? { ca: database.caCert } : {}) }

  const pool = new pg.Pool({
    connectionString: url.href,
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
