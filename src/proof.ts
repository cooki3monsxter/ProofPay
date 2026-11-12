import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { config } from "./config.js";
import * as db from "./db.js";
import type { Escrow, Evidence, Milestone } from "./types.js";

/**
 * Portable proof of delivery.
 *
 * Every milestone ProofPay releases gets a delivery attestation: a compact JWS (RFC 7515) signed with
 * Ed25519 (alg "EdDSA"). The public key is published at /.well-known/jwks.json, so anyone — PayPal's
 * dispute team, another marketplace, the freelancer's next client — can check it with any standard JOSE
 * library or in the browser, without trusting ProofPay or calling its API.
 *
 * Privacy: the attestation names no one. The freelancer and client appear only as salted SHA-256 hashes
 * of their email. A freelancer proves "this is me" by telling a verifier their email, which the verifier
 * hashes and compares. Written deliverables appear only as a hash; URLs (PRs, live sites) are included.
 *
 * The freelancer owns the result: they can export all their attestations as one bundle and share it,
 * and it stays verifiable even if ProofPay goes away.
 */

export const SUBJECT_SALT = "proofpay:subject:";
export const subjectHash = (email: string) =>
  `sha256:${createHash("sha256").update(SUBJECT_SALT + email.trim().toLowerCase()).digest("hex")}`;
const sha256 = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export interface AttestationPayload {
  v: 1;
  typ: "proofpay.delivery";
  iss: string; // issuer base URL
  jti: string; // milestone id
  iat: number; // seconds since epoch
  freelancer: string; // subject hash
  client: string; // subject hash
  work: {
    title: string;
    project: string;
    amount: number;
    currency: string;
    criteria: { type: string; description: string; passed: boolean; confidence: number }[];
    evidence: string[]; // URLs, or sha256 of written deliverables
    verifier: "claude" | "heuristic";
  };
  timeline: { fundedAt: string | null; submittedAt: string | null; releasedAt: string | null; dueDate: string | null; onTime: boolean | null };
  payment: { network: "paypal"; captureId: string | null };
  release: "automatic" | "client_approved" | "reviewer";
}

// ---------------------------------------------------------------- keys
let keys: { priv: KeyObject; pub: KeyObject; kid: string } | null = null;

function loadKeys() {
  if (keys) return keys;
  let pem = process.env.ATTESTATION_PRIVATE_KEY?.replace(/\\n/g, "\n").trim() || db.getSetting("attestation_private_key");
  if (!pem) {
    const { privateKey } = generateKeyPairSync("ed25519");
    pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    db.setSetting("attestation_private_key", pem);
  }
  const priv = createPrivateKey(pem);
  const pub = createPublicKey(priv);
  const raw = pub.export({ format: "jwk" }).x as string;
  keys = { priv, pub, kid: `pp-${createHash("sha256").update(raw).digest("hex").slice(0, 16)}` };
  return keys;
}
export function resetProofKeys() { keys = null; }

export function jwks() {
  const k = loadKeys();
  const jwk = k.pub.export({ format: "jwk" }) as { kty: string; crv: string; x: string };
  return { keys: [{ ...jwk, kid: k.kid, alg: "EdDSA", use: "sig" }] };
}

// ---------------------------------------------------------------- issue
export function buildPayload(m: Milestone, e: Escrow, evidence: Evidence[], release: AttestationPayload["release"]): AttestationPayload {
  const results = new Map((m.lastVerdict?.results ?? []).map((r) => [r.criterionId, r]));
  const due = m.dueDate ? Date.parse(m.dueDate) : NaN;
  const sub = m.submittedAt ? Date.parse(m.submittedAt) : NaN;
  return {
    v: 1,
    typ: "proofpay.delivery",
    iss: config.publicBaseUrl,
    jti: m.id,
    iat: Math.floor(Date.now() / 1000),
    freelancer: subjectHash(e.freelancerEmail),
    client: subjectHash(e.clientEmail),
    work: {
      title: m.title,
      project: e.title,
      amount: m.amount,
      currency: e.currency,
      criteria: m.criteria.map((c) => {
        const r = results.get(c.id);
        return { type: c.type, description: c.description, passed: !!r?.passed, confidence: Number((r?.confidence ?? 0).toFixed(2)) };
      }),
      evidence: evidence.map((x) => (x.kind === "text" ? sha256(x.value) : x.value)),
      verifier: m.lastVerdict?.engine ?? "heuristic",
    },
    timeline: {
      fundedAt: m.fundedAt, submittedAt: m.submittedAt, releasedAt: m.releasedAt, dueDate: m.dueDate,
      onTime: Number.isFinite(due) && Number.isFinite(sub) ? sub <= due : null,
    },
    payment: { network: "paypal", captureId: m.captureId },
    release,
  };
}

export function signAttestation(payload: AttestationPayload) {
  const k = loadKeys();
  const header = b64u(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: k.kid }));
  const body = b64u(JSON.stringify(payload));
  const sig = sign(null, Buffer.from(`${header}.${body}`), k.priv);
  return `${header}.${body}.${b64u(sig)}`;
}

/** Issues (once) and stores the attestation for a released milestone. */
export function issueAttestation(milestoneId: string, release: AttestationPayload["release"]) {
  const m = db.getMilestone(milestoneId);
  if (!m || m.status !== "RELEASED") return null;
  const existing = db.getSetting(`attestation:${m.id}`);
  if (existing) return existing;
  const e = db.getEscrow(m.escrowId)!;
  const token = signAttestation(buildPayload(m, e, db.listEvidence(m.id), release));
  db.setSetting(`attestation:${m.id}`, token);
  return token;
}
export const getAttestation = (milestoneId: string) => db.getSetting(`attestation:${milestoneId}`);

// ---------------------------------------------------------------- verify
export type Verification =
  | { valid: true; kid: string; payload: AttestationPayload; status: AttestationStatus }
  | { valid: false; reason: string };
export type AttestationStatus = "valid" | "disputed" | "revoked" | "unknown";

/** Checks the signature against our published key, then looks up the live status. */
export function verifyAttestation(token: string): Verification {
  const parts = token.trim().split(".");
  if (parts.length !== 3) return { valid: false, reason: "Not a compact JWS (expected header.payload.signature)" };
  let header: any, payload: AttestationPayload;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch {
    return { valid: false, reason: "The token isn't valid base64url JSON" };
  }
  const k = loadKeys();
  if (header.alg !== "EdDSA") return { valid: false, reason: `Unsupported algorithm ${header.alg}` };
  if (header.kid !== k.kid) return { valid: false, reason: `Signed with key ${header.kid}, which this issuer doesn't publish` };
  const ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), k.pub, Buffer.from(parts[2], "base64url"));
  if (!ok) return { valid: false, reason: "Signature doesn't match — the attestation was altered or isn't from this issuer" };
  return { valid: true, kid: k.kid, payload, status: attestationStatus(payload.jti) };
}

/**
 * Live status. The signature proves what was verified at release; status says whether anything
 * happened afterwards: a PayPal dispute that's still open, or a refund after release.
 */
export function attestationStatus(milestoneId: string): AttestationStatus {
  const m = db.getMilestone(milestoneId);
  if (!m) return "unknown";
  if (m.status === "REFUNDED") return "revoked";
  if (m.paypalDisputeId && !/RESOLVED/i.test(m.paypalDisputeStatus ?? "")) return "disputed";
  return "valid";
}

// ---------------------------------------------------------------- track record
/** Every attestation issued to the freelancer behind this email — the bundle they own and share. */
export function trackRecord(freelancerEmail: string) {
  const subject = subjectHash(freelancerEmail);
  const tokens: string[] = [];
  for (const e of db.listEscrows()) {
    if (e.freelancerEmail.toLowerCase() !== freelancerEmail.toLowerCase()) continue;
    for (const m of db.listMilestones(e.id)) {
      const t = getAttestation(m.id);
      if (t) tokens.push(t);
    }
  }
  return { subject, issuer: config.publicBaseUrl, count: tokens.length, tokens };
}
