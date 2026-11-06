import type { NextFunction, Request, Response } from 'express'
import type pg from 'pg'
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { z } from 'zod'
import { staffRoleSchema, type StaffRole } from '@reliefcheck/contracts'
import { sendError } from '../http/errors.js'
import type { ServerConfig } from '../config/env.js'

export type StaffIdentity = { userId: string; role: StaffRole }

export interface StaffRoleRepository {
  /** Returns the enabled role for a verified Auth user, or null when absent/disabled. */
  findEnabledRole(userId: string): Promise<StaffRole | null>
}

export type StaffAuthDeps = {
  /** Verifies signature, issuer, audience and expiry; resolves to the Auth user ID. */
  verifyToken(token: string): Promise<string>
  roles: StaffRoleRepository
}

const ALLOWED_ALGORITHMS = ['ES256', 'RS256']
const userIdSchema = z.uuid()

export function createJwtVerifier(
  staffAuth: NonNullable<ServerConfig['staffAuth']>,
  keySet: JWTVerifyGetKey = createRemoteJWKSet(staffAuth.jwksUrl),
): StaffAuthDeps['verifyToken'] {
  return async (token) => {
    const { payload } = await jwtVerify(token, keySet, {
      issuer: staffAuth.issuer,
      audience: staffAuth.audience,
      algorithms: ALLOWED_ALGORITHMS,
      requiredClaims: ['sub', 'exp'],
    })
    return userIdSchema.parse(payload.sub)
  }
}

export function createPgStaffRoleRepository(pool: pg.Pool): StaffRoleRepository {
  return {
    async findEnabledRole(userId) {
      const result = await pool.query<{ role: string }>(
        'SELECT role FROM relief.staff_roles WHERE user_id = $1 AND enabled = true',
        [userId],
      )
      const parsed = staffRoleSchema.safeParse(result.rows[0]?.role)
      return parsed.success ? parsed.data : null
    },
  }
}

function bearerToken(request: Request): string | null {
  const header = request.get('authorization')
  if (!header) return null
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header)
  return match?.[1] ?? null
}

/**
 * Verifies the staff JWT and looks up the enabled role on every privileged request
 * (ai.md §9). Decoded-but-unverified claims and user metadata are never trusted.
 * When auth or the database is not configured, every request fails closed with 503.
 */
export function requireStaff(deps: StaffAuthDeps | null, allowed: readonly StaffRole[] = ['developer', 'admin']) {
  return async (request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store')
    if (!deps) {
      sendError(response, 503, 'AUTH_UNCONFIGURED', 'Staff authentication is not configured on this server.', false)
      return
    }
    const token = bearerToken(request)
    if (!token) {
      response.setHeader('WWW-Authenticate', 'Bearer')
      sendError(response, 401, 'UNAUTHENTICATED', 'A valid staff session is required.', false)
      return
    }

    let userId: string
    try {
      userId = await deps.verifyToken(token)
    } catch {
      response.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"')
      sendError(response, 401, 'UNAUTHENTICATED', 'A valid staff session is required.', false)
      return
    }

    let role: StaffRole | null
    try {
      role = await deps.roles.findEnabledRole(userId)
    } catch {
      sendError(response, 503, 'DATABASE_UNAVAILABLE', 'Staff roles cannot be checked right now.', true)
      return
    }
    if (!role || !allowed.includes(role)) {
      sendError(response, 403, 'FORBIDDEN', 'This account does not have access to this action.', false)
      return
    }

    response.locals.staff = { userId, role } satisfies StaffIdentity
    next()
  }
}
