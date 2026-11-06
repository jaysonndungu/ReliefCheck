import { Router } from 'express'
import { ADMIN_ME_PATH, adminMeSchema, type StaffRole } from '@reliefcheck/contracts'
import { requireStaff, type StaffAuthDeps, type StaffIdentity } from '../middleware/staffAuth.js'

/** Capability names mirror the role column of the ai.md §9 route table. */
const CAPABILITIES: Record<StaffRole, string[]> = {
  developer: ['ingest', 'review', 'build_release'],
  admin: ['ingest', 'review', 'build_release', 'publish', 'kb_recovery', 'metrics', 'logs'],
}

export function adminRouter(staffAuth: StaffAuthDeps | null): Router {
  const router = Router()

  // US01 protected test endpoint: proves JWT verification + role lookup end to end.
  router.get(ADMIN_ME_PATH, requireStaff(staffAuth), (_request, response) => {
    const staff = response.locals.staff as StaffIdentity
    response.json(
      adminMeSchema.parse({ userId: staff.userId, role: staff.role, capabilities: CAPABILITIES[staff.role] }),
    )
  })

  return router
}
