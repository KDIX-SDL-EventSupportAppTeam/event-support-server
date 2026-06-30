import { randomUUID } from 'node:crypto'
import type { DbClient } from '../db/client.js'

export async function insertAuditLog(
  db: DbClient,
  params: {
    eventId: string
    actorId: string
    actorRole: string
    action: string
    targetType: string
    targetId?: string
    detail?: unknown
  },
): Promise<void> {
  await db.execute(
    `INSERT INTO audit_logs (id, event_id, actor_id, actor_role, action, target_type, target_id, detail)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      randomUUID(),
      params.eventId,
      params.actorId,
      params.actorRole,
      params.action,
      params.targetType,
      params.targetId ?? null,
      params.detail !== undefined ? JSON.stringify(params.detail) : null,
    ],
  )
}
