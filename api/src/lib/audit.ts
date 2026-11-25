// Append-only audit trail (spec 14.7). Called inside the same transaction as the change it records.
import type { Db } from '../providers/db.js';
import type { Principal } from '../providers/auth.js';

export async function audit(
  db: Db,
  actor: Principal | null,
  action: string,
  entityType: string,
  entityId: string | null,
  details: Record<string, unknown> = {},
  correlationId?: string,
) {
  await db.query(
    `INSERT INTO spir.audit_event (actor_id, actor_role, action, entity_type, entity_id, details, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actor?.userId ?? 'system', actor?.role ?? 'SYSTEM', action, entityType, entityId, JSON.stringify(details), correlationId ?? null],
  );
}
