import { createHmac } from "node:crypto";

/**
 * Outgoing event notifications (e.g. a Zapier "Catch Hook" → Slack, email, Google Sheets).
 * Set NOTIFY_WEBHOOK_URL; optionally NOTIFY_WEBHOOK_SECRET to sign the body
 * (header X-ProofPay-Signature: sha256=<hex HMAC of the raw body>).
 * Fire-and-forget: a slow or failing receiver never blocks money movement.
 */
const NOTIFY_TYPES = new Set([
  "ESCROW_CREATED", "FUNDS_HELD", "EVIDENCE_SUBMITTED", "VERIFICATION_PASSED", "VERIFICATION_FAILED",
  "HELD_FOR_REVIEW", "CAPTURED", "PAYOUT_SENT", "PAYOUT_FAILED", "DISPUTE_OPENED", "DISPUTE_RESOLVED",
  "PAYPAL_DISPUTE_OPENED", "DISPUTE_EVIDENCE_SENT", "HOLD_EXPIRING", "HOLD_EXPIRED", "AUTHORIZATION_VOIDED",
]);

export interface NotifyEvent {
  type: string; escrowId: string; milestoneId: string | null; actor: string; amount: number | null; message: string; ts: string;
}

let sink: ((body: string, headers: Record<string, string>) => void) | null = null;
/** test hook */
export function setNotifySink(fn: typeof sink) { sink = fn; }

export function notify(e: NotifyEvent) {
  const url = process.env.NOTIFY_WEBHOOK_URL?.trim();
  if ((!url && !sink) || !NOTIFY_TYPES.has(e.type)) return;
  const base = (process.env.PUBLIC_BASE_URL ?? process.env.RENDER_EXTERNAL_URL ?? "").replace(/\/$/, "");
  const body = JSON.stringify({
    event: e.type, escrowId: e.escrowId, milestoneId: e.milestoneId, actor: e.actor,
    amount: e.amount, message: e.message, at: e.ts,
    escrowUrl: base ? `${base}/#/escrow/${e.escrowId}` : undefined, // no key: opening it still needs the person's link
  });
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "proofpay-notify/1.0" };
  const secret = process.env.NOTIFY_WEBHOOK_SECRET?.trim();
  if (secret) headers["x-proofpay-signature"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  if (sink) return sink(body, headers);
  fetch(url!, { method: "POST", headers, body, signal: AbortSignal.timeout(5000) })
    .catch((err) => console.warn(`[notify] ${e.type} not delivered: ${(err as Error).message}`));
}
