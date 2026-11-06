import { z } from 'zod'

const optionalString = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional()

const optionalUrl = optionalString.pipe(z.url().optional())

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: optionalString,
  /** Optional PEM CA bundle for the database TLS chain (for example the Supabase pooler CA). */
  DATABASE_CA_CERT: optionalString,
  SUPABASE_AUTH_ISSUER: optionalUrl,
  SUPABASE_AUTH_JWKS_URL: optionalUrl,
})

export type ServerConfig = {
  port: number
  database: { url: string; caCert: string | undefined } | null
  staffAuth: { issuer: string; jwksUrl: URL; audience: string } | null
}

/**
 * Parses server-only configuration. Optional integrations stay disabled when unset so the
 * local starter runs without an .env; the features that need them fail closed (ai.md §15.11).
 * Values are never echoed back in errors.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')
    throw new Error(`Invalid server configuration: ${fields}`)
  }
  const values = parsed.data

  const issuer = values.SUPABASE_AUTH_ISSUER
  const jwksUrl = values.SUPABASE_AUTH_JWKS_URL
  if (Boolean(issuer) !== Boolean(jwksUrl)) {
    throw new Error(
      'Invalid server configuration: set both SUPABASE_AUTH_ISSUER and SUPABASE_AUTH_JWKS_URL, or neither.',
    )
  }
  if (jwksUrl && !jwksUrl.startsWith('https://')) {
    throw new Error('Invalid server configuration: SUPABASE_AUTH_JWKS_URL must use https.')
  }

  return {
    port: values.PORT,
    database: values.DATABASE_URL
      ? { url: values.DATABASE_URL, caCert: values.DATABASE_CA_CERT }
      : null,
    staffAuth:
      issuer && jwksUrl ? { issuer, jwksUrl: new URL(jwksUrl), audience: 'authenticated' } : null,
  }
}
