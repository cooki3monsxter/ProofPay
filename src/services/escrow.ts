import { config } from "../config.js";
import * as db from "../db.js";
import { paypal } from "../paypal/gateway.js";
import { extractPlan, DraftPlan } from "../ai/extractor.js";
import { verifyMilestone, disputeBrief } from "../verify/engine.js";
import { scoreRisk } from "../ml/risk.js";
import { issueAgentKey, issueEscrowKeys, label, markClientClaimPending, receiptUrl, shareLink, SYSTEM, type Who } from "../auth.js";
import { attestationStatus, getAttestation, issueAttestation, type AttestationPayload } from "../proof.js";
import type { Criterion, Escrow, Milestone, MilestoneStatus, RiskAssessment } from "../types.js";

export type { Who } from "../auth.js";

export class EscrowError extends Error {
  constructor(public code: string, message: string, public httpStatus = 409) {
    super(message);
  }
}

const must = <T>(v: T | null | undefined, what: string): T => {
  if (v == null) throw new EscrowError("NOT_FOUND", `${what} not found`, 404);
  return v;
};
const expect = (m: Milestone, allowed: MilestoneStatus[], action: string) => {
  if (!allowed.includes(m.status))
    throw new EscrowError("INVALID_STATE", `Cannot ${action} a milestone in status ${m.status} (allowed: ${allowed.join(", ")})`);
};
const requireRole = (who: Who, roles: Who["role"][], action: string) => {
  if (!roles.includes(who.role)) throw new EscrowError("FORBIDDEN", `Only the ${roles.join(" or ")} can ${action}`, 403);
};
const humanOnly = (who: Who, action: string) => {
  if (who.viaAgent) throw new EscrowError("HUMAN_APPROVAL_REQUIRED", `An AI agent can't ${action}. The person must do this in the ProofPay dashboard.`, 403);
};
const nowIso = () => new Date().toISOString();
const DAY = 86_400_000;
const ORDER_LINK_TTL_MS = 2.5 * 3600 * 1000;
/** PayPal authorizations can be captured for up to 29 days. */
export const HOLD_VALID_DAYS = 29;
const HELD: MilestoneStatus[] = ["FUNDED", "SUBMITTED", "NEEDS_REVIEW", "CHANGES_REQUESTED", "DISPUTED"];

// ---------------------------------------------------------------------------
// Per-milestone lock: money-moving operations on one milestone run one at a time,
// so a double click or a webhook racing a redirect can't capture or void twice.
// (Single-instance; multi-instance deployments would use a DB row lock instead.)
// ---------------------------------------------------------------------------
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------
export async function draftFromScope(scopeText: string, currency = "USD") {
  return extractPlan(scopeText, currency);
}

export interface CreateEscrowInput {
  title: string;
  clientName: string;
  clientEmail: string;
  freelancerName: string;
  freelancerEmail: string;
  currency: string;
  scopeText: string;
  milestones: DraftPlan["milestones"];
  createdBy: Escrow["createdBy"];
}

/** Creates the escrow and its access keys. Keys are returned once and never stored in plain text. */
export function createEscrow(input: CreateEscrowInput) {
  const plan = DraftPlan.parse({ title: input.title, currency: input.currency, milestones: input.milestones });
  const { escrow, keys, agentKey } = db.tx(() => {
    const escrow = db.insertEscrow({
      title: plan.title, clientName: input.clientName, clientEmail: input.clientEmail,
      freelancerName: input.freelancerName, freelancerEmail: input.freelancerEmail,
      currency: plan.currency.toUpperCase(), scopeText: input.scopeText, createdBy: input.createdBy,
    });
    plan.milestones.forEach((m, i) => {
      const criteria: Criterion[] = m.criteria.map((c, k) => ({ id: `c${i + 1}_${k + 1}`, ...c }));
      db.insertMilestone({
        escrowId: escrow.id, seq: i + 1, title: m.title, description: m.description, amount: round2(m.amount),
        dueDate: m.dueInDays != null ? new Date(Date.now() + m.dueInDays * DAY).toISOString() : null,
        criteria,
      });
    });
    const byAgent = input.createdBy === "agent";
    const keys = issueEscrowKeys(escrow.id, { clientKey: !byAgent });
    const agentKey = byAgent ? issueAgentKey(escrow.id, "client", "created via MCP") : null;
    if (byAgent) markClientClaimPending(escrow.id);
    const total = plan.milestones.reduce((s, m) => s + m.amount, 0);
    db.logEvent({ escrowId: escrow.id, milestoneId: null, type: "ESCROW_CREATED", actor: input.createdBy === "agent" ? "client's agent" : "client",
      amount: round2(total), message: `Escrow "${escrow.title}" created with ${plan.milestones.length} milestones`, data: null });
    return { escrow, keys, agentKey };
  });
  return {
    escrow: view(escrow.id),
    access: keys.client
      ? { clientKey: keys.client, freelancerKey: keys.freelancer,
          clientLink: shareLink(escrow.id, keys.client), freelancerLink: shareLink(escrow.id, keys.freelancer) }
      : { agentKey: agentKey!, freelancerKey: keys.freelancer, freelancerLink: shareLink(escrow.id, keys.freelancer),
          clientAccess: "The client gets their dashboard link after approving the first PayPal hold." },
  };
}

/** A person mints a key for their own AI agent; it carries their role with agent restrictions. */
export function createAgentKey(escrowId: string, who: Who, labelText: string) {
  must(db.getEscrow(escrowId), "Escrow");
  requireRole(who, ["client", "freelancer"], "create an agent key");
  humanOnly(who, "create more agent keys");
  const key = issueAgentKey(escrowId, who.role as "client" | "freelancer", labelText || "agent");
  db.logEvent({ escrowId, milestoneId: null, type: "AGENT_KEY_CREATED", actor: label(who), amount: null, message: `Agent access created for the ${who.role} (${labelText || "agent"})`, data: null });
  return { agentKey: key, role: who.role };
}

// ---------------------------------------------------------------------------
// Funding: PayPal Orders v2 with intent=AUTHORIZE (money held, not taken)
// ---------------------------------------------------------------------------
export function fundMilestone(milestoneId: string, who: Who) {
  return withLock(milestoneId, async () => {
    const m = must(db.getMilestone(milestoneId), "Milestone");
    const e = must(db.getEscrow(m.escrowId), "Escrow");
    requireRole(who, ["client"], "fund a milestone");
    const attempts = db.listEvents(e.id).filter((x) => x.milestoneId === m.id && x.type === "ORDER_CREATED");
    // PayPal approval links expire after ~3 hours; reuse a fresh one, otherwise create a new order.
    if (m.status === "AWAITING_APPROVAL" && m.approvalUrl && attempts[0] && Date.now() - Date.parse(attempts[0].ts) < ORDER_LINK_TTL_MS)
      return { milestone: m, approvalUrl: m.approvalUrl };
    expect(m, ["DRAFT", "AWAITING_APPROVAL"], "fund");

    // A PayPal hold lasts 29 days. Funding work due later than that would let the hold
    // expire before delivery, so ask for funding closer to the start instead.
    if (m.dueDate) {
      const latestDue = Date.now() + (HOLD_VALID_DAYS - 1) * DAY;
      if (Date.parse(m.dueDate) > latestDue) {
        const from = new Date(Date.parse(m.dueDate) - (HOLD_VALID_DAYS - 1) * DAY);
        throw new EscrowError("FUND_LATER",
          `PayPal holds last ${HOLD_VALID_DAYS} days and this milestone is due ${m.dueDate.slice(0, 10)}. Fund it on or after ${from.toISOString().slice(0, 10)} so the hold covers the delivery date.`);
      }
    }
    const base = config.publicBaseUrl;
    const order = await paypal().createOrder({
      referenceId: m.id, requestId: `order-${m.id}-${attempts.length + 1}`, amount: m.amount, currency: e.currency,
      description: `ProofPay escrow — ${e.title} — ${m.title}`,
      returnUrl: `${base}/paypal/return?milestone=${m.id}`,
      cancelUrl: `${base}/paypal/cancel?milestone=${m.id}`,
    });
    const updated = db.updateMilestone(m.id, { status: "AWAITING_APPROVAL", paypalOrderId: order.orderId, approvalUrl: order.approvalUrl });
    db.logEvent({ escrowId: e.id, milestoneId: m.id, type: "ORDER_CREATED", actor: label(who), amount: m.amount,
      message: `PayPal order ${order.orderId} created (intent AUTHORIZE). Waiting for client approval.`, data: { orderId: order.orderId } });
    return { milestone: updated, approvalUrl: order.approvalUrl };
  });
}

/** Called from the PayPal return URL or the CHECKOUT.ORDER.APPROVED webhook. Idempotent. */
export function onOrderApproved(orderId: string, actorLabel = "client") {
  const found = must(db.getMilestoneByOrder(orderId), "Milestone for order");
  return withLock(found.id, async () => {
    const m = must(db.getMilestone(found.id), "Milestone");
    if (m.status !== "AWAITING_APPROVAL" || m.paypalOrderId !== orderId) return m; // already handled
    const auth = await paypal().authorizeOrder(orderId);
    const expires = auth.expiresAt ?? new Date(Date.now() + HOLD_VALID_DAYS * DAY).toISOString();
    const updated = db.updateMilestone(m.id, {
      status: "FUNDED", authorizationId: auth.authorizationId, authorizationExpiresAt: expires, fundedAt: nowIso(),
    });
    db.logEvent({ escrowId: m.escrowId, milestoneId: m.id, type: "FUNDS_HELD", actor: actorLabel, amount: m.amount,
      message: `Authorization ${auth.authorizationId} placed — funds held until ${expires.slice(0, 10)}, client not charged yet.`, data: auth });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Delivery → verification → policy decision
// ---------------------------------------------------------------------------
export interface EvidenceInput { kind: "github_pr" | "url" | "text"; value: string; note?: string }

export function submitEvidence(milestoneId: string, items: EvidenceInput[], who: Who) {
  return withLock(milestoneId, async () => {
    const m = must(db.getMilestone(milestoneId), "Milestone");
    requireRole(who, ["freelancer"], "submit work");
    expect(m, ["FUNDED", "CHANGES_REQUESTED"], "submit work for");
    if (!items.length) throw new EscrowError("NO_EVIDENCE", "Submit at least one piece of evidence", 400);
    for (const it of items) db.insertEvidence({ milestoneId: m.id, kind: it.kind, value: it.value.trim(), note: it.note ?? "" });
    db.updateMilestone(m.id, {
      status: "SUBMITTED", submittedAt: nowIso(),
      resubmissions: m.status === "CHANGES_REQUESTED" ? m.resubmissions + 1 : m.resubmissions,
    });
    db.logEvent({ escrowId: m.escrowId, milestoneId: m.id, type: "EVIDENCE_SUBMITTED", actor: label(who), amount: null,
      message: `${items.length} piece(s) of evidence submitted`, data: items });
    return verifyLocked(m.id, who);
  });
}

export function runVerification(milestoneId: string, who: Who) {
  return withLock(milestoneId, () => verifyLocked(milestoneId, who));
}

async function verifyLocked(milestoneId: string, who: Who) {
  const m = must(db.getMilestone(milestoneId), "Milestone");
  expect(m, ["SUBMITTED", "NEEDS_REVIEW", "CHANGES_REQUESTED"], "verify");
  const e = must(db.getEscrow(m.escrowId), "Escrow");
  const verdict = await verifyMilestone(m, db.listEvidence(m.id));
  const risk = riskFor({ ...m, lastVerdict: verdict }, e);
  db.updateMilestone(m.id, { lastVerdict: verdict, risk });
  db.logEvent({ escrowId: e.id, milestoneId: m.id, type: verdict.passed ? "VERIFICATION_PASSED" : "VERIFICATION_FAILED", actor: label(who),
    amount: null, message: `${verdict.summary} (confidence ${(verdict.confidence * 100).toFixed(0)}%, risk ${(risk.score * 100).toFixed(0)}% ${risk.band})`,
    data: { verdict, risk } });

  // ---- release policy: deterministic checks + AI verdict + ML risk + confidence guardrails ----
  if (!verdict.passed) {
    const failed = verdict.results.filter((r) => !r.passed);
    const waiting = failed.length > 0 && failed.every((r) => r.pending);
    db.updateMilestone(m.id, {
      status: "CHANGES_REQUESTED",
      decision: waiting
        ? "Waiting for the pull request to be merged and CI to finish. Payment is checked again automatically when GitHub reports the merge."
        : "Changes requested: one or more acceptance criteria were not met.",
    });
    return view(e.id, m.id);
  }
  const reasons: string[] = [];
  if (verdict.confidence < config.policy.minVerifierConfidence) reasons.push(`verifier confidence ${(verdict.confidence * 100).toFixed(0)}% is below ${(config.policy.minVerifierConfidence * 100).toFixed(0)}%`);
  if (risk.score >= config.policy.autoReleaseMaxRisk) reasons.push(`risk score ${(risk.score * 100).toFixed(0)}% is at or above ${(config.policy.autoReleaseMaxRisk * 100).toFixed(0)}%`);
  if (reasons.length) {
    db.updateMilestone(m.id, { status: "NEEDS_REVIEW", decision: `Held for client approval: ${reasons.join("; ")}.` });
    db.logEvent({ escrowId: e.id, milestoneId: m.id, type: "HELD_FOR_REVIEW", actor: "system", amount: m.amount, message: reasons.join("; "), data: null });
    return view(e.id, m.id);
  }
  db.updateMilestone(m.id, { status: "NEEDS_REVIEW", decision: "Auto-released: all criteria passed with high confidence and low risk." });
  await releaseLocked(m.id, SYSTEM, true);
  return view(e.id, m.id);
}

function riskFor(m: Milestone, e: Escrow) {
  const h = db.freelancerHistory(e.freelancerEmail);
  return scoreRisk({ milestone: m, currency: e.currency, verdict: m.lastVerdict,
    freelancerCompleted: h.completed, freelancerDisputes: h.disputes, firstEngagement: isFirstEngagement(e) });
}

/** Risk exactly as the release policy computes it (used by the risk endpoint and MCP tool). */
export function currentRisk(milestoneId: string) {
  const m = must(db.getMilestone(milestoneId), "Milestone");
  return riskFor(m, must(db.getEscrow(m.escrowId), "Escrow"));
}

function isFirstEngagement(e: Escrow) {
  return !db.listEscrows().some((x) => x.id !== e.id &&
    x.clientEmail.toLowerCase() === e.clientEmail.toLowerCase() &&
    x.freelancerEmail.toLowerCase() === e.freelancerEmail.toLowerCase());
}

// ---------------------------------------------------------------------------
// Money movement
// ---------------------------------------------------------------------------
export function release(milestoneId: string, who: Who) {
  return withLock(milestoneId, () => releaseLocked(milestoneId, who, false));
}

async function releaseLocked(milestoneId: string, who: Who, auto: boolean) {
  const m = must(db.getMilestone(milestoneId), "Milestone");
  const e = must(db.getEscrow(m.escrowId), "Escrow");
  if (m.status === "RELEASED") return view(e.id, m.id);
  expect(m, ["NEEDS_REVIEW", "DISPUTED"], "release");
  if (!auto) {
    requireRole(who, ["client", "reviewer"], "release a payment");
    humanOnly(who, "override a payment that policy held for review");
    if (m.status === "DISPUTED" && who.role !== "reviewer" && who.role !== "client")
      throw new EscrowError("FORBIDDEN", "Only a reviewer or the client can release a disputed milestone", 403);
  }

  const authId = await freshAuthorization(m, e);
  const cap = await paypal().captureAuthorization(authId, m.amount, e.currency, m.id);
  db.updateMilestone(m.id, { captureId: cap.captureId });
  db.logEvent({ escrowId: e.id, milestoneId: m.id, type: "CAPTURED", actor: auto ? "system" : label(who), amount: m.amount,
    message: `Captured ${fmt(m.amount, e.currency)} (capture ${cap.captureId}, ${cap.status})`, data: cap });

  db.updateMilestone(m.id, { status: "RELEASED", releasedAt: nowIso(), decision: auto ? m.decision : `Released by ${label(who)}.` });

  // Portable proof: a signed attestation the freelancer owns and anyone can verify.
  const release: AttestationPayload["release"] = auto ? "automatic" : who.role === "reviewer" ? "reviewer" : "client_approved";
  issueAttestation(m.id, release);
  db.logEvent({ escrowId: e.id, milestoneId: m.id, type: "ATTESTATION_ISSUED", actor: "system", amount: null,
    message: "Signed proof of delivery issued (Ed25519). Anyone can verify it against the public key.", data: null });

  // Risk-priced payout timing.
  const plan = payoutPlan(db.getMilestone(m.id)!, auto ? "auto" : who.role === "reviewer" ? "reviewer" : "client");
  db.updateMilestone(m.id, { payoutDueAt: new Date(Date.now() + plan.hours * 3_600_000).toISOString() });
  if (plan.hours > 0)
    db.logEvent({ escrowId: e.id, milestoneId: m.id, type: "PAYOUT_SCHEDULED", actor: "system", amount: null,
      message: `${plan.reason} The freelancer's payout goes out ${new Date(Date.now() + plan.hours * 3_600_000).toISOString().slice(0, 16).replace("T", " ")} UTC.`,
      data: plan });
  else await sendPayout(m.id);
  completeIfDone(e.id);
  return view(e.id, m.id);
}

/**
 * How long the freelancer's payout waits after capture. The wait protects against a buyer disputing the
 * payment with PayPal after release: low risk is paid instantly, higher risk waits a few days.
 * A client's (or reviewer's) explicit approval lowers the band by one.
 */
export function payoutPlan(m: Milestone, releasedBy: "auto" | "client" | "reviewer"): { hours: number; band: RiskAssessment["band"]; reason: string } {
  const order: RiskAssessment["band"][] = ["low", "medium", "high"];
  let band = m.risk?.band ?? "medium";
  if (releasedBy !== "auto") band = order[Math.max(0, order.indexOf(band) - 1)];
  const hours = band === "low" ? 0 : band === "medium" ? config.payoutDelay.mediumHours : config.payoutDelay.highHours;
  const why = m.risk?.reasons?.find((r) => r.impact > 0)?.label;
  const approved = releasedBy === "auto" ? "" : " after approval";
  const reason = hours === 0
    ? `Paid instantly: ${band} release risk${approved}.`
    : `Payout delayed ${hours >= 24 ? `${Math.round(hours / 24)} days` : `${hours} hours`}: ${band} release risk${approved}${why ? ` (biggest factor: ${why.toLowerCase()})` : ""}. This protects against a later PayPal dispute.`;
  return { hours, band, reason };
}

/** Sends every scheduled payout that's due. Runs from the sweep (Render cron) and the in-process timer. */
export async function processDuePayouts(now = Date.now()) {
  let sent = 0;
  for (const m of db.listMilestonesInStatus(["RELEASED"])) {
    if (m.payoutBatchId || !m.payoutDueAt || Date.parse(m.payoutDueAt) > now) continue;
    await withLock(m.id, async () => {
      const fresh = db.getMilestone(m.id)!;
      if (fresh.payoutBatchId) return;
      await sendPayout(fresh.id);
      if (db.getMilestone(fresh.id)!.payoutBatchId) sent++;
    });
  }
  return { sent };
}

/** Pays the freelancer's share of a captured milestone. Safe to call again if a payout failed. */
async function sendPayout(milestoneId: string) {
  const m = must(db.getMilestone(milestoneId), "Milestone");
  const e = must(db.getEscrow(m.escrowId), "Escrow");
  if (m.payoutBatchId) return;
  if (m.paypalDisputeId && !/RESOLVED/i.test(m.paypalDisputeStatus ?? "")) {
    if (!db.listEvents(e.id).some((x) => x.milestoneId === m.id && x.type === "PAYOUT_PAUSED"))
      db.logEvent({ escrowId: e.id, milestoneId: m.id, type: "PAYOUT_PAUSED", actor: "system", amount: null,
        message: `Payout paused: the buyer opened PayPal dispute ${m.paypalDisputeId} before it went out. A reviewer can pay it once the dispute is settled.`, data: null });
    return;
  }
  const fee = round2(m.amount * config.paypal.platformFeePct / 100);
  const payoutAmt = round2(m.amount - fee);
  const attempt = db.listEvents(e.id).filter((x) => x.milestoneId === m.id && x.type === "PAYOUT_FAILED").length + 1;
  try {
    const p = await paypal().createPayout({
      senderBatchId: `pp_${m.id}_${attempt}`, receiverEmail: e.freelancerEmail, amount: payoutAmt, currency: e.currency,
      note: `Payment for "${m.title}" (${e.title}) — verified by ProofPay`,
    });
    db.updateMilestone(m.id, { payoutBatchId: p.payoutBatchId });
    db.logEvent({ escrowId: e.id, milestoneId: m.id, type: "PAYOUT_SENT", actor: "system", amount: payoutAmt,
      message: `Paid ${fmt(payoutAmt, e.currency)} to ${e.freelancerEmail} (batch ${p.payoutBatchId}); platform fee ${fmt(fee, e.currency)}`, data: p });
  } catch (err) {
    // The capture already succeeded, so the money is safe with the platform. Never lose track of it.
    db.logEvent({ escrowId: e.id, milestoneId: m.id, type: "PAYOUT_FAILED", actor: "system", amount: payoutAmt,
      message: `Payout failed — retry from the dashboard: ${(err as Error).message}`, data: null });
  }
}

export function retryPayout(milestoneId: string, who: Who) {
  return withLock(milestoneId, async () => {
    const m = must(db.getMilestone(milestoneId), "Milestone");
    requireRole(who, ["client", "reviewer"], "send a payout now");
    humanOnly(who, "send payouts");
    expect(m, ["RELEASED"], "send the payout for");
    if (m.payoutBatchId) throw new EscrowError("ALREADY_PAID", "This milestone's payout already went out");
    const disputeOpen = m.paypalDisputeId && !/RESOLVED/i.test(m.paypalDisputeStatus ?? "");
    if (disputeOpen && who.role !== "reviewer")
      throw new EscrowError("PAYPAL_DISPUTE_OPEN", "A PayPal dispute is open on this payment. A reviewer decides when the payout goes out.", 409);
    if (disputeOpen) db.updateMilestone(m.id, { paypalDisputeStatus: "RESOLVED_BY_REVIEWER" });
    db.updateMilestone(m.id, { payoutDueAt: nowIso() });
    await sendPayout(m.id);
    return view(m.escrowId, m.id);
  });
}

async function freshAuthorization(m: Milestone, e: Escrow) {
  if (!m.authorizationId) throw new EscrowError("NOT_FUNDED", "Milestone has no authorization to capture");
  if (m.authorizationExpiresAt && Date.now() > Date.parse(m.authorizationExpiresAt))
    throw new EscrowError("HOLD_EXPIRED", "The PayPal hold for this milestone has expired. The client needs to fund it again.");
  const honorEnds = (m.fundedAt ? Date.parse(m.fundedAt) : Date.now()) + 3 * DAY;
  if (Date.now() < honorEnds) return m.authorizationId;
  try {
    const r = await paypal().reauthorize(m.authorizationId, m.amount, e.currency);
    db.updateMilestone(m.id, { authorizationId: r.authorizationId, authorizationExpiresAt: r.expiresAt ?? m.authorizationExpiresAt });
    db.logEvent({ escrowId: e.id, milestoneId: m.id, type: "REAUTHORIZED", actor: "system", amount: m.amount,
      message: `Honor period ended; reauthorized as ${r.authorizationId}`, data: r });
    return r.authorizationId;
  } catch {
    return m.authorizationId; // capture may still succeed within the 29-day validity window
  }
}

/**
 * Hold housekeeping (runs on a timer). Warns 3 days before a PayPal hold expires and, once it has
 * expired, moves the milestone back to "not funded" so the client can fund it again — instead of a
 * release failing at the worst moment.
 */
export function sweepHolds(now = Date.now()) {
  const out = { expiring: 0, expired: 0 };
  for (const m of db.listMilestonesInStatus(HELD)) {
    if (!m.authorizationExpiresAt) continue;
    const exp = Date.parse(m.authorizationExpiresAt);
    const events = db.listEvents(m.escrowId).filter((x) => x.milestoneId === m.id);
    if (now > exp) {
      if (m.status === "DISPUTED") {
        if (!events.some((x) => x.type === "HOLD_EXPIRED"))
          db.logEvent({ escrowId: m.escrowId, milestoneId: m.id, type: "HOLD_EXPIRED", actor: "system", amount: m.amount,
            message: "PayPal hold expired during the dispute; the client was never charged. Resolve as a refund or fund again.", data: null });
        continue;
      }
      db.updateMilestone(m.id, {
        status: "DRAFT", authorizationId: null, authorizationExpiresAt: null, paypalOrderId: null, approvalUrl: null, fundedAt: null,
        decision: "The PayPal hold expired before release. The client was never charged and can fund this milestone again.",
      });
      db.logEvent({ escrowId: m.escrowId, milestoneId: m.id, type: "HOLD_EXPIRED", actor: "system", amount: m.amount,
        message: "PayPal hold expired (29-day limit). Milestone is unfunded again; evidence is kept.", data: null });
      out.expired++;
    } else if (exp - now < 3 * DAY && !events.some((x) => x.type === "HOLD_EXPIRING" && x.data && (x.data as any).expiresAt === m.authorizationExpiresAt)) {
      db.logEvent({ escrowId: m.escrowId, milestoneId: m.id, type: "HOLD_EXPIRING", actor: "system", amount: m.amount,
        message: `PayPal hold expires ${m.authorizationExpiresAt.slice(0, 10)}. Release, request changes or dispute before then.`,
        data: { expiresAt: m.authorizationExpiresAt } });
      out.expiring++;
    }
  }
  return out;
}

export function requestChanges(milestoneId: string, reason: string, who: Who) {
  return withLock(milestoneId, async () => {
    const m = must(db.getMilestone(milestoneId), "Milestone");
    requireRole(who, ["client"], "request changes");
    expect(m, ["NEEDS_REVIEW", "SUBMITTED"], "request changes on");
    db.updateMilestone(m.id, { status: "CHANGES_REQUESTED", decision: `Changes requested by ${label(who)}: ${reason}` });
    db.logEvent({ escrowId: m.escrowId, milestoneId: m.id, type: "CHANGES_REQUESTED", actor: label(who), amount: null, message: reason, data: null });
    return view(m.escrowId, m.id);
  });
}

/**
 * Who may return held money to the client, and when. Escrow only works if neither side can
 * unilaterally grab the money once the other has done their part:
 *  - client: before funding, or once a funded milestone is past its deadline with no proof submitted.
 *    After proof is submitted the client must request changes or open a dispute instead.
 *  - freelancer: any time before release (voluntarily giving the money back).
 *  - reviewer: when resolving a dispute.
 *  - agents: never.
 */
export function refundAllowed(m: Milestone, who: Who): { ok: true } | { ok: false; code: string; why: string } {
  if (who.viaAgent) return { ok: false, code: "HUMAN_APPROVAL_REQUIRED", why: "Refunds must be confirmed by a person in the dashboard" };
  if (who.role === "reviewer" || who.role === "system")
    return m.status === "DISPUTED" ? { ok: true } : { ok: false, code: "INVALID_STATE", why: "Reviewers refund only disputed milestones" };
  if (who.role === "freelancer")
    return HELD.includes(m.status) ? { ok: true } : { ok: false, code: "INVALID_STATE", why: "Nothing is held for this milestone" };
  if (m.status === "DRAFT" || m.status === "AWAITING_APPROVAL") return { ok: true };
  if (m.status === "FUNDED") {
    const due = m.dueDate ? Date.parse(m.dueDate) : NaN;
    if (Number.isFinite(due) && Date.now() > due) return { ok: true };
    return { ok: false, code: "FREELANCER_PROTECTED", why: "The freelancer is working on this funded milestone. You can cancel once the deadline passes without delivery, or open a dispute." };
  }
  return { ok: false, code: "FREELANCER_PROTECTED", why: "Work has been submitted for this milestone. Request changes or open a dispute instead of cancelling." };
}

export function refund(milestoneId: string, reason: string, who: Who) {
  return withLock(milestoneId, () => refundLocked(milestoneId, reason, who));
}

async function refundLocked(milestoneId: string, reason: string, who: Who) {
  const m = must(db.getMilestone(milestoneId), "Milestone");
  const e = must(db.getEscrow(m.escrowId), "Escrow");
  expect(m, ["DRAFT", "AWAITING_APPROVAL", ...HELD], "refund");
  const allowed = refundAllowed(m, who);
  if (!allowed.ok) throw new EscrowError(allowed.code, allowed.why, 403);
  if (m.authorizationId && !(m.authorizationExpiresAt && Date.now() > Date.parse(m.authorizationExpiresAt))) {
    await paypal().voidAuthorization(m.authorizationId);
    db.logEvent({ escrowId: e.id, milestoneId: m.id, type: "AUTHORIZATION_VOIDED", actor: label(who), amount: m.amount,
      message: `Hold released back to client (${m.authorizationId} voided) — client was never charged. ${reason}`, data: null });
  } else {
    db.logEvent({ escrowId: e.id, milestoneId: m.id, type: "MILESTONE_CANCELLED", actor: label(who), amount: null, message: reason, data: null });
  }
  db.updateMilestone(m.id, { status: "REFUNDED", decision: `Refunded by ${label(who)}: ${reason}` });
  completeIfDone(e.id);
  return view(e.id, m.id);
}

export function openDispute(milestoneId: string, reason: string, who: Who) {
  return withLock(milestoneId, async () => {
    const m = must(db.getMilestone(milestoneId), "Milestone");
    requireRole(who, ["client", "freelancer"], "open a dispute");
    expect(m, ["FUNDED", "SUBMITTED", "NEEDS_REVIEW", "CHANGES_REQUESTED"], "dispute");
    const brief = await disputeBrief(m, db.listEvidence(m.id), reason, label(who));
    db.updateMilestone(m.id, { status: "DISPUTED", decision: `Dispute brief: ${brief}` });
    db.logEvent({ escrowId: m.escrowId, milestoneId: m.id, type: "DISPUTE_OPENED", actor: label(who), amount: m.amount, message: reason, data: { brief } });
    return view(m.escrowId, m.id);
  });
}

export function resolveDispute(milestoneId: string, outcome: "release" | "refund", note: string, who: Who) {
  return withLock(milestoneId, async () => {
    const m = must(db.getMilestone(milestoneId), "Milestone");
    requireRole(who, ["reviewer"], "resolve disputes");
    expect(m, ["DISPUTED"], "resolve");
    db.logEvent({ escrowId: m.escrowId, milestoneId: m.id, type: "DISPUTE_RESOLVED", actor: "reviewer", amount: m.amount, message: `${outcome}: ${note}`, data: null });
    return outcome === "release" ? releaseLocked(m.id, who, false) : refundLocked(m.id, note || "Dispute resolved in the client's favour", who);
  });
}

// ---------------------------------------------------------------------------
// PayPal buyer disputes / chargebacks AFTER release
// A released milestone can still be disputed with PayPal by the buyer. ProofPay matches the
// dispute to the capture and answers it with the verification record as proof of fulfillment.
// ---------------------------------------------------------------------------
export async function onPayPalDispute(disputeId: string) {
  const d = await paypal().getDispute(disputeId);
  const m = d.transactionIds.map((t) => db.getMilestoneByCapture(t)).find(Boolean) ?? null;
  if (!m) return { matched: false as const, disputeId };
  return withLock(m.id, async () => {
    const fresh = must(db.getMilestone(m.id), "Milestone");
    const e = must(db.getEscrow(fresh.escrowId), "Escrow");
    const isNew = fresh.paypalDisputeId !== d.id;
    db.updateMilestone(fresh.id, { paypalDisputeId: d.id, paypalDisputeStatus: d.status });
    if (isNew)
      db.logEvent({ escrowId: e.id, milestoneId: fresh.id, type: "PAYPAL_DISPUTE_OPENED", actor: "paypal", amount: d.amount,
        message: `Buyer opened PayPal dispute ${d.id} (${d.reason}) on capture ${fresh.captureId}.`, data: d });
    else
      db.logEvent({ escrowId: e.id, milestoneId: fresh.id, type: "PAYPAL_DISPUTE_UPDATED", actor: "paypal", amount: d.amount,
        message: `PayPal dispute ${d.id} is now ${d.status}.`, data: { status: d.status } });

    const alreadySent = db.listEvents(e.id).some((x) => x.milestoneId === fresh.id && x.type === "DISPUTE_EVIDENCE_SENT" && (x.data as any)?.disputeId === d.id);
    const canRespond = /WAITING_FOR_SELLER_RESPONSE|OPEN/i.test(d.status);
    if (config.paypal.autoDisputeEvidence && canRespond && !alreadySent) {
      const notes = disputeEvidenceNotes(fresh, e);
      try {
        await paypal().provideEvidence(d.id, { type: "PROOF_OF_FULFILLMENT", notes });
        db.logEvent({ escrowId: e.id, milestoneId: fresh.id, type: "DISPUTE_EVIDENCE_SENT", actor: "system", amount: null,
          message: `Sent verification record to PayPal for dispute ${d.id}.`, data: { disputeId: d.id, notes } });
      } catch (err) {
        db.logEvent({ escrowId: e.id, milestoneId: fresh.id, type: "DISPUTE_EVIDENCE_FAILED", actor: "system", amount: null,
          message: `Could not send evidence for dispute ${d.id}: ${(err as Error).message}. Respond in the PayPal Resolution Center.`, data: { disputeId: d.id } });
      }
    }
    return { matched: true as const, disputeId: d.id, milestoneId: fresh.id };
  });
}

/** Plain-text proof of fulfillment for PayPal (max 2000 chars), linking the signed public receipt. */
export function disputeEvidenceNotes(m: Milestone, e: Escrow) {
  const ev = db.listEvidence(m.id);
  const lines = [
    `ProofPay verified delivery before charging. Escrow "${e.title}", milestone "${m.title}" (${fmt(m.amount, e.currency)}).`,
    `Agreed acceptance criteria and automated results:`,
    ...m.criteria.map((c) => {
      const r = m.lastVerdict?.results.find((x) => x.criterionId === c.id);
      return `- ${c.description}: ${r ? (r.passed ? "PASSED" : "FAILED") : "not checked"}${r ? ` — ${r.detail}` : ""}`;
    }),
    `Evidence submitted ${m.submittedAt?.slice(0, 10) ?? "?"}: ${ev.map((x) => (x.kind === "text" ? "written deliverable" : x.value)).join(", ") || "none"}.`,
    `Funds were authorized on ${m.fundedAt?.slice(0, 10) ?? "?"} and captured only after verification on ${m.releasedAt?.slice(0, 10) ?? "?"}.`,
    `Full verification receipt: ${receiptUrl(m.id)}`,
  ];
  let text = lines.join("\n");
  if (text.length > 2000) text = text.slice(0, 1900) + `…\nFull verification receipt: ${receiptUrl(m.id)}`;
  return text;
}

function completeIfDone(escrowId: string) {
  const ms = db.listMilestones(escrowId);
  if (ms.every((m) => m.status === "RELEASED" || m.status === "REFUNDED")) {
    db.setEscrowStatus(escrowId, ms.some((m) => m.status === "RELEASED") ? "COMPLETED" : "CANCELLED");
    db.logEvent({ escrowId, milestoneId: null, type: "ESCROW_CLOSED", actor: "system", amount: null, message: "All milestones settled", data: null });
  }
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------
export function view(escrowId: string, focusMilestoneId?: string) {
  const e = must(db.getEscrow(escrowId), "Escrow");
  const milestones = db.listMilestones(e.id).map((m) => ({
    ...m,
    evidence: db.listEvidence(m.id),
    receiptUrl: m.status === "RELEASED" ? receiptUrl(m.id) : null,
    attestation: m.status === "RELEASED" || m.status === "REFUNDED" ? getAttestation(m.id) : null,
    attestationStatus: getAttestation(m.id) ? attestationStatus(m.id) : null,
    payoutPaused: !!(m.status === "RELEASED" && !m.payoutBatchId && m.paypalDisputeId && !/RESOLVED/i.test(m.paypalDisputeStatus ?? "")),
    holdExpiresSoon: !!(m.authorizationExpiresAt && HELD.includes(m.status) && Date.parse(m.authorizationExpiresAt) - Date.now() < 3 * DAY),
  }));
  const sum = (pred: (m: Milestone) => boolean) => round2(milestones.filter(pred).reduce((s, m) => s + m.amount, 0));
  return {
    ...e,
    totals: {
      total: sum(() => true),
      held: sum((m) => HELD.includes(m.status)),
      released: sum((m) => m.status === "RELEASED"),
      refunded: sum((m) => m.status === "REFUNDED"),
    },
    milestones,
    focus: focusMilestoneId ?? null,
  };
}

export function summary(escrowId: string) {
  const v = view(escrowId);
  return { id: v.id, title: v.title, clientName: v.clientName, freelancerName: v.freelancerName, currency: v.currency,
    status: v.status, createdBy: v.createdBy, createdAt: v.createdAt, totals: v.totals,
    milestoneCount: v.milestones.length, needsReview: v.milestones.filter((m) => m.status === "NEEDS_REVIEW" || m.status === "DISPUTED").length };
}

/** One row per milestone across all escrows — the reviewers' risk desk (AG Grid). */
export function deskRows() {
  const now = Date.now();
  return db.listEscrows().flatMap((e) => {
    const events = db.listEvents(e.id);
    return db.listMilestones(e.id).map((m) => {
      const last = events.find((x) => x.milestoneId === m.id);
      const exp = m.authorizationExpiresAt && HELD.includes(m.status) ? Date.parse(m.authorizationExpiresAt) : null;
      return {
        escrowId: e.id, escrowTitle: e.title, client: e.clientName, freelancer: e.freelancerName, createdBy: e.createdBy,
        milestoneId: m.id, milestone: `${m.seq}. ${m.title}`, amount: m.amount, currency: e.currency, status: m.status,
        risk: m.risk?.score ?? null, riskBand: m.risk?.band ?? null, topReason: m.risk?.reasons?.[0]?.label ?? null,
        confidence: m.lastVerdict?.confidence ?? null, criteriaPassed: m.lastVerdict ? m.lastVerdict.results.filter((r) => r.passed).length : null,
        criteriaTotal: m.criteria.length, resubmissions: m.resubmissions,
        dueDate: m.dueDate, holdDaysLeft: exp ? Math.round(((exp - now) / DAY) * 10) / 10 : null,
        paypalDispute: m.paypalDisputeId ? `${m.paypalDisputeId} (${m.paypalDisputeStatus})` : null,
        lastEvent: last ? `${last.type} · ${last.ts.slice(0, 16).replace("T", " ")}` : null, lastEventAt: last?.ts ?? null,
      };
    });
  });
}

export function summaryList() {
  return db.listEscrows().map((e) => summary(e.id));
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number, c: string) => `${c} ${n.toFixed(2)}`;
