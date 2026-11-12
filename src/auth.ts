import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import * as db from "./db.js";

/**
 * Access control.
 *
 * Every escrow gets one secret key per party (client, freelancer). Keys travel inside share links
 * (`/#/escrow/<id>?key=...` — the fragment is never sent to servers or logs) and are stored only as
 * SHA-256 hashes. A key belongs to exactly one escrow and one role.
 *
 * Agent keys: a person can mint an extra key for their AI agent. The server knows from the key itself
 * that the caller is an agent, so an agent can't escape its restrictions by calling the REST API
 * directly instead of going through MCP.
 *
 * Reviewers use the platform ADMIN_KEY (generated and persisted on first start if not configured).
 */
export type Role = "client" | "freelancer" | "reviewer" | "system";
export interface Who { role: Role; viaAgent: boolean }

export const SYSTEM: Who = { role: "system", viaAgent: false };
export const label = (w: Who) => (w.viaAgent ? `${w.role}'s agent` : w.role);

const hash = (k: string) => createHash("sha256").update(k).digest("hex");
const newKey = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;

export function issueEscrowKeys(escrowId: string, opts: { clientKey: boolean } = { clientKey: true }) {
  const freelancer = newKey("ppf");
  db.insertKey(hash(freelancer), escrowId, "freelancer", false, "freelancer link");
  const client = opts.clientKey ? issueClientKey(escrowId) : null;
  return { client, freelancer };
}

export function issueClientKey(escrowId: string) {
  const client = newKey("ppc");
  db.insertKey(hash(client), escrowId, "client", false, "client link");
  return client;
}

/**
 * Escrows created by an AI agent: the agent never sees the person's client key. The person
 * receives it when they approve the first PayPal hold — approving requires their own PayPal login,
 * so it doubles as proof that they're the client. One-time.
 */
export function markClientClaimPending(escrowId: string) { db.setSetting(`claim:${escrowId}`, "pending"); }
export function claimClientKey(escrowId: string): string | null {
  if (db.getSetting(`claim:${escrowId}`) !== "pending") return null;
  db.setSetting(`claim:${escrowId}`, "claimed");
  return issueClientKey(escrowId);
}

export function issueAgentKey(escrowId: string, role: "client" | "freelancer", labelText = "agent") {
  const key = newKey(role === "client" ? "ppca" : "ppfa");
  db.insertKey(hash(key), escrowId, role, true, labelText);
  return key;
}

export const shareLink = (escrowId: string, key: string) => `${config.publicBaseUrl}/#/escrow/${escrowId}?key=${key}`;

let adminKey: string | null = null;
export function getAdminKey() {
  if (adminKey) return adminKey;
  adminKey = config.adminKey || db.getSetting("admin_key");
  if (!adminKey) {
    adminKey = newKey("ppadmin");
    db.setSetting("admin_key", adminKey);
    console.log(`  Generated reviewer key (set ADMIN_KEY to choose your own): ${adminKey}`);
  }
  return adminKey;
}
export function resetAuthCache() { adminKey = null; receiptSecret = null; }

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function isAdmin(key: string | null | undefined) {
  return !!key && safeEq(key, getAdminKey());
}

/** Who is calling, for this escrow. null = no valid access. */
export function resolve(escrowId: string, key: string | null | undefined): Who | null {
  if (!key) return null;
  if (isAdmin(key)) return { role: "reviewer", viaAgent: false };
  const k = db.findKey(hash(key));
  if (!k || k.escrowId !== escrowId) return null;
  return { role: k.role as Role, viaAgent: k.agent };
}

// ---- signed public receipts (shareable proof of delivery, used as PayPal dispute evidence) ----
let receiptSecret: string | null = null;
function getReceiptSecret() {
  if (receiptSecret) return receiptSecret;
  receiptSecret = db.getSetting("receipt_secret");
  if (!receiptSecret) {
    receiptSecret = randomBytes(32).toString("hex");
    db.setSetting("receipt_secret", receiptSecret);
  }
  return receiptSecret;
}
export const receiptSig = (milestoneId: string) =>
  createHmac("sha256", getReceiptSecret()).update(`receipt:${milestoneId}`).digest("base64url").slice(0, 32);
export const receiptUrl = (milestoneId: string) => `${config.publicBaseUrl}/receipts/${milestoneId}?sig=${receiptSig(milestoneId)}`;
export const verifyReceiptSig = (milestoneId: string, sig: string) => safeEq(sig, receiptSig(milestoneId));
