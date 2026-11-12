import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import type { Escrow, Evidence, LedgerEvent, Milestone } from "./types.js";
import { notify } from "./notify.js";

let db: DatabaseSync;

export function openDb(path = config.dbPath) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS escrows (
      id TEXT PRIMARY KEY, title TEXT, client_name TEXT, client_email TEXT,
      freelancer_name TEXT, freelancer_email TEXT, currency TEXT, scope_text TEXT,
      status TEXT, created_by TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS milestones (
      id TEXT PRIMARY KEY, escrow_id TEXT, seq INTEGER, title TEXT, description TEXT,
      amount REAL, due_date TEXT, criteria TEXT, status TEXT,
      paypal_order_id TEXT, approval_url TEXT, authorization_id TEXT,
      authorization_expires_at TEXT, capture_id TEXT, payout_batch_id TEXT,
      resubmissions INTEGER DEFAULT 0, funded_at TEXT, submitted_at TEXT, released_at TEXT,
      last_verdict TEXT, risk TEXT, decision TEXT);
    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY, milestone_id TEXT, kind TEXT, value TEXT, note TEXT, submitted_at TEXT);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, escrow_id TEXT, milestone_id TEXT,
      type TEXT, actor TEXT, amount REAL, message TEXT, data TEXT);
    CREATE TABLE IF NOT EXISTS access_keys (
      key_hash TEXT PRIMARY KEY, escrow_id TEXT, role TEXT, agent INTEGER DEFAULT 0, label TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
    CREATE INDEX IF NOT EXISTS idx_ms_escrow ON milestones(escrow_id);
    CREATE INDEX IF NOT EXISTS idx_ms_order ON milestones(paypal_order_id);
    CREATE INDEX IF NOT EXISTS idx_ev_escrow ON events(escrow_id);
    CREATE INDEX IF NOT EXISTS idx_keys_escrow ON access_keys(escrow_id);
  `);
  // additive migrations for databases created by earlier versions
  const cols = new Set((db.prepare(`PRAGMA table_info(milestones)`).all() as any[]).map((c) => c.name));
  for (const [col, type] of [["paypal_dispute_id", "TEXT"], ["paypal_dispute_status", "TEXT"], ["payout_due_at", "TEXT"]] as const)
    if (!cols.has(col)) db.exec(`ALTER TABLE milestones ADD COLUMN ${col} ${type}`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ms_capture ON milestones(capture_id)`);
  return db;
}

// ---------- settings (persisted secrets etc.) ----------
export function getSetting(k: string): string | null {
  const r: any = db.prepare(`SELECT v FROM settings WHERE k=?`).get(k);
  return r ? String(r.v) : null;
}
export function setSetting(k: string, v: string) {
  db.prepare(`INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(k, v);
}

// ---------- access keys (only hashes are stored) ----------
export function insertKey(hash: string, escrowId: string, role: string, agent: boolean, label: string) {
  db.prepare(`INSERT INTO access_keys VALUES (?,?,?,?,?,?)`).run(hash, escrowId, role, agent ? 1 : 0, label, now());
}
export function findKey(hash: string): { escrowId: string; role: string; agent: boolean; label: string } | null {
  const r: any = db.prepare(`SELECT * FROM access_keys WHERE key_hash=?`).get(hash);
  return r ? { escrowId: r.escrow_id, role: r.role, agent: !!r.agent, label: r.label } : null;
}

/** Runs fn in a single SQLite transaction. */
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const now = () => new Date().toISOString();
const json = (v: unknown) => (v == null ? null : JSON.stringify(v));
const parse = <T>(v: unknown): T | null => (v == null ? null : (JSON.parse(String(v)) as T));

// ---------- escrows ----------
const toEscrow = (r: any): Escrow => ({
  id: r.id, title: r.title, clientName: r.client_name, clientEmail: r.client_email,
  freelancerName: r.freelancer_name, freelancerEmail: r.freelancer_email,
  currency: r.currency, scopeText: r.scope_text, status: r.status,
  createdBy: r.created_by, createdAt: r.created_at,
});

export function insertEscrow(e: Omit<Escrow, "id" | "createdAt" | "status">): Escrow {
  const row: Escrow = { ...e, id: newId("esc"), status: "ACTIVE", createdAt: now() };
  db.prepare(`INSERT INTO escrows VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.id, row.title, row.clientName, row.clientEmail, row.freelancerName,
    row.freelancerEmail, row.currency, row.scopeText, row.status, row.createdBy, row.createdAt);
  return row;
}
export const getEscrow = (id: string) => {
  const r = db.prepare(`SELECT * FROM escrows WHERE id=?`).get(id);
  return r ? toEscrow(r) : null;
};
export const listEscrows = () =>
  db.prepare(`SELECT * FROM escrows ORDER BY created_at DESC`).all().map(toEscrow);
export const setEscrowStatus = (id: string, status: Escrow["status"]) =>
  db.prepare(`UPDATE escrows SET status=? WHERE id=?`).run(status, id);

// ---------- milestones ----------
const toMilestone = (r: any): Milestone => ({
  id: r.id, escrowId: r.escrow_id, seq: r.seq, title: r.title, description: r.description,
  amount: r.amount, dueDate: r.due_date, criteria: parse(r.criteria) ?? [], status: r.status,
  paypalOrderId: r.paypal_order_id, approvalUrl: r.approval_url,
  authorizationId: r.authorization_id, authorizationExpiresAt: r.authorization_expires_at,
  captureId: r.capture_id, payoutBatchId: r.payout_batch_id, resubmissions: r.resubmissions,
  fundedAt: r.funded_at, submittedAt: r.submitted_at, releasedAt: r.released_at,
  lastVerdict: parse(r.last_verdict), risk: parse(r.risk), decision: r.decision,
  paypalDisputeId: r.paypal_dispute_id ?? null, paypalDisputeStatus: r.paypal_dispute_status ?? null,
  payoutDueAt: r.payout_due_at ?? null,
});

export function insertMilestone(m: Pick<Milestone, "escrowId" | "seq" | "title" | "description" | "amount" | "dueDate" | "criteria">): Milestone {
  const id = newId("ms");
  db.prepare(`INSERT INTO milestones (id, escrow_id, seq, title, description, amount, due_date, criteria, status)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(
    id, m.escrowId, m.seq, m.title, m.description, m.amount, m.dueDate, json(m.criteria), "DRAFT");
  return getMilestone(id)!;
}
export const getMilestone = (id: string) => {
  const r = db.prepare(`SELECT * FROM milestones WHERE id=?`).get(id);
  return r ? toMilestone(r) : null;
};
export const getMilestoneByOrder = (orderId: string) => {
  const r = db.prepare(`SELECT * FROM milestones WHERE paypal_order_id=?`).get(orderId);
  return r ? toMilestone(r) : null;
};
export const getMilestoneByCapture = (captureId: string) => {
  const r = db.prepare(`SELECT * FROM milestones WHERE capture_id=?`).get(captureId);
  return r ? toMilestone(r) : null;
};
/** Milestones whose evidence includes one of these URLs (used by the GitHub webhook). */
export function milestonesWithEvidence(urls: string[]) {
  if (!urls.length) return [];
  const rows = db.prepare(`SELECT DISTINCT milestone_id FROM evidence WHERE lower(rtrim(value, '/')) IN (${urls.map(() => "?").join(",")})`)
    .all(...urls.map((u) => u.toLowerCase().replace(/\/+$/, ""))) as any[];
  return rows.map((r) => getMilestone(r.milestone_id)).filter((m): m is Milestone => !!m);
}
export const listMilestonesInStatus = (statuses: string[]) =>
  db.prepare(`SELECT * FROM milestones WHERE status IN (${statuses.map(() => "?").join(",")})`).all(...statuses).map(toMilestone);
export const getMilestoneByAuthorization = (authId: string) => {
  const r = db.prepare(`SELECT * FROM milestones WHERE authorization_id=?`).get(authId);
  return r ? toMilestone(r) : null;
};
export const listMilestones = (escrowId: string) =>
  db.prepare(`SELECT * FROM milestones WHERE escrow_id=? ORDER BY seq`).all(escrowId).map(toMilestone);

const columnMap: Record<string, string> = {
  status: "status", paypalOrderId: "paypal_order_id", approvalUrl: "approval_url",
  authorizationId: "authorization_id", authorizationExpiresAt: "authorization_expires_at",
  captureId: "capture_id", payoutBatchId: "payout_batch_id", resubmissions: "resubmissions",
  fundedAt: "funded_at", submittedAt: "submitted_at", releasedAt: "released_at",
  lastVerdict: "last_verdict", risk: "risk", decision: "decision",
  paypalDisputeId: "paypal_dispute_id", paypalDisputeStatus: "paypal_dispute_status",
  payoutDueAt: "payout_due_at",
};
export function updateMilestone(id: string, patch: Partial<Milestone>): Milestone {
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = columnMap[k];
    if (!col) continue;
    sets.push(`${col}=?`);
    vals.push(typeof v === "object" && v !== null ? JSON.stringify(v) : v);
  }
  if (sets.length) db.prepare(`UPDATE milestones SET ${sets.join(",")} WHERE id=?`).run(...vals, id);
  return getMilestone(id)!;
}

// ---------- evidence ----------
export function insertEvidence(e: Omit<Evidence, "id" | "submittedAt">): Evidence {
  const row = { ...e, id: newId("evd"), submittedAt: now() };
  db.prepare(`INSERT INTO evidence VALUES (?,?,?,?,?,?)`).run(
    row.id, row.milestoneId, row.kind, row.value, row.note, row.submittedAt);
  return row;
}
export const listEvidence = (milestoneId: string): Evidence[] =>
  db.prepare(`SELECT * FROM evidence WHERE milestone_id=? ORDER BY submitted_at`).all(milestoneId).map((r: any) => ({
    id: r.id, milestoneId: r.milestone_id, kind: r.kind, value: r.value, note: r.note, submittedAt: r.submitted_at,
  }));

// ---------- ledger events ----------
export function logEvent(e: Omit<LedgerEvent, "id" | "ts">) {
  const ts = now();
  db.prepare(`INSERT INTO events (ts, escrow_id, milestone_id, type, actor, amount, message, data)
              VALUES (?,?,?,?,?,?,?,?)`).run(
    ts, e.escrowId, e.milestoneId, e.type, e.actor, e.amount, e.message, json(e.data));
  notify({ type: e.type, escrowId: e.escrowId, milestoneId: e.milestoneId, actor: e.actor, amount: e.amount, message: e.message, ts });
}
const toEvent = (r: any): LedgerEvent => ({
  id: r.id, ts: r.ts, escrowId: r.escrow_id, milestoneId: r.milestone_id, type: r.type,
  actor: r.actor, amount: r.amount, message: r.message, data: parse(r.data),
});
export const listEvents = (escrowId?: string) =>
  (escrowId
    ? db.prepare(`SELECT * FROM events WHERE escrow_id=? ORDER BY id DESC`).all(escrowId)
    : db.prepare(`SELECT * FROM events ORDER BY id DESC LIMIT 500`).all()
  ).map(toEvent);

/** Track record of a freelancer across all escrows — feeds the ML risk model. */
export function freelancerHistory(email: string) {
  // "bad" = a dispute was opened, or the milestone was funded and refunded without any delivery.
  // A client cancelling before funding says nothing about the freelancer, so it doesn't count.
  const r: any = db.prepare(`
    SELECT
      SUM(CASE WHEN m.status='RELEASED' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM events v WHERE v.milestone_id = m.id AND v.type = 'DISPUTE_OPENED')
                 OR (m.status='REFUNDED' AND m.authorization_id IS NOT NULL AND m.submitted_at IS NULL)
               THEN 1 ELSE 0 END) AS bad
    FROM milestones m JOIN escrows e ON e.id = m.escrow_id
    WHERE lower(e.freelancer_email) = lower(?)`).get(email);
  return { completed: Number(r?.completed ?? 0), disputes: Number(r?.bad ?? 0) };
}
