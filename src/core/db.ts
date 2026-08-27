/**
 * Database access, tenant-scoped.
 *
 * There is exactly one supported way to touch tenant data: `withTenant`.
 * Everything else in the platform goes through it, and the reason is the most
 * important line in this file:
 *
 *     SELECT set_config('app.tenant_id', $1, true)
 *                                        ^^^^ transaction-local
 *
 * Connections come from a pool and are reused. If the tenant setting were
 * session-scoped (`false`), it would survive the connection being returned to
 * the pool — and the next request, for a different clinic, would inherit it.
 * That is a cross-tenant data leak with no error message and no stack trace.
 *
 * Transaction-local means it resets on COMMIT or ROLLBACK, every time,
 * whatever happens. Combined with policies that fail closed, the worst case
 * for a forgotten tenant context is a query returning nothing.
 */

import pg from "pg";

export interface DbConfig {
  connectionString: string;
  /** Owner connections bypass RLS. Only the platform console may use one. */
  role: "app" | "owner";
  max?: number;
  /**
   * PEM certificate authority to verify the server against.
   *
   * PHI in transit has to be encrypted *and* the endpoint authenticated —
   * `sslmode=require` alone does neither properly: it encrypts but accepts any
   * certificate, so it stops a passive listener and not an active one. Passing
   * the CA here turns on full verification. In AWS this is the RDS global
   * bundle; the container has it on disk and `DATABASE_CA_PATH` points at it.
   */
  ca?: string;
  /**
   * Supplies a credential per connection instead of a static password.
   *
   * In AWS this returns a signed IAM token valid for fifteen minutes, so no
   * database password exists to be leaked or rotated. See core/rds-auth.ts.
   */
  password?: () => Promise<string>;
}

/**
 * Chooses between a connection string and discrete fields.
 *
 * This exists because of one line in node-postgres:
 *
 *     config = Object.assign({}, config, parse(config.connectionString))
 *
 * The parsed connection string is merged *over* everything else, and parsing a
 * URL with no password yields `password: ""` — a key that is present, so it
 * wins. Passing both a `connectionString` and a `password` function therefore
 * discards the function without a word and sends an empty password, which the
 * server rejects with "empty password returned by client".
 *
 * Nothing catches this locally: development uses ordinary URLs with no
 * password function, so the two paths only ever collide in AWS, where the
 * credential is a signed IAM token.
 *
 * So when a token function is supplied the URL is decomposed and the string is
 * not passed at all. There is nothing left for pg to merge over the top.
 */
function connectionOf(config: DbConfig): pg.PoolConfig {
  if (!config.password) return { connectionString: config.connectionString };

  const url = new URL(config.connectionString);
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    database: url.pathname.replace(/^\//, ""),
    // Called on every new connection, which is the right cadence for a token
    // that expires in fifteen minutes.
    password: config.password,
  };
}

export class Db {
  private pool: pg.Pool;
  readonly role: "app" | "owner";

  constructor(config: DbConfig) {
    this.pool = new pg.Pool({
      max: config.max ?? 10,
      // Local development connects over a unix socket or loopback with no CA,
      // where TLS buys nothing. Anywhere a CA is supplied, verify strictly.
      ...(config.ca ? { ssl: { ca: config.ca, rejectUnauthorized: true } } : {}),
      ...connectionOf(config),
    });
    this.role = config.role;
  }

  /**
   * Runs `fn` inside a transaction scoped to one tenant. Every tenant-facing
   * query in the platform goes through here.
   */
  async withTenant<T>(
    tenantId: string,
    fn: (tx: pg.PoolClient) => Promise<T>
  ): Promise<T> {
    if (this.role === "owner") {
      throw new Error(
        "withTenant called on an owner connection — owner bypasses RLS, so " +
          "tenant scoping would be silently ineffective. Use withPlatform."
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // `true` = local to this transaction. Never change this.
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Cross-tenant access for the platform owner console. Deliberately a
   * different method on a different credential, so "see every clinic" is
   * always an explicit choice that shows up in a code review.
   */
  async withPlatform<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
    if (this.role !== "owner") {
      throw new Error("withPlatform requires an owner connection");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Cheapest possible round trip, for readiness checks. Deliberately touches
   * no table: this answers "is the connection alive", not "is the data right",
   * and it must not be able to fail because of row-level security.
   */
  async ping(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT 1");
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ------------------------------------------------------------------ audit

export interface AuditEntry {
  actorId?: string;
  actorRole?: string;
  action: "READ" | "CREATE" | "UPDATE" | "DELETE" | "EXPORT";
  entityType: string;
  entityId?: string;
  /**
   * Identifiers and outcomes only. **Never PHI values.** Audit tables are
   * routinely the least-protected store in a system; a name or a diagnosis
   * written here defeats the point of protecting it everywhere else.
   */
  detail?: Record<string, unknown>;
  ipAddress?: string;
}

export async function audit(
  tx: pg.PoolClient,
  tenantId: string,
  entry: AuditEntry
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log
       (tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      tenantId,
      entry.actorId ?? null,
      entry.actorRole ?? null,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      JSON.stringify(entry.detail ?? {}),
      entry.ipAddress ?? null,
    ]
  );
}

// ------------------------------------------------------- pipeline events

export interface EventRecord {
  visitId?: string;
  patientId?: string;
  eventType: string;
  fromStage?: string;
  toStage?: string;
  source: "system" | "network" | "staff" | "patient" | "timer";
  actor?: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
}

/**
 * Appends to the event log. Returns false when the event was a duplicate —
 * the caller usually treats that as success, because a network re-sending an
 * event is normal rather than exceptional.
 */
export async function appendEvent(
  tx: pg.PoolClient,
  tenantId: string,
  event: EventRecord
): Promise<boolean> {
  const result = await tx.query(
    `INSERT INTO pipeline_events
       (tenant_id, visit_id, patient_id, event_type, from_stage, to_stage,
        source, actor, payload, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      tenantId,
      event.visitId ?? null,
      event.patientId ?? null,
      event.eventType,
      event.fromStage ?? null,
      event.toStage ?? null,
      event.source,
      event.actor ?? null,
      JSON.stringify(event.payload ?? {}),
      event.idempotencyKey ?? null,
    ]
  );
  return (result.rowCount ?? 0) > 0;
}
