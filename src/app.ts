import express, { type NextFunction, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z, ZodError } from "zod";
import { aiMode, config, paypalMode } from "./config.js";
import * as db from "./db.js";
import * as svc from "./services/escrow.js";
import { DraftMilestone } from "./ai/extractor.js";
import { paypal } from "./paypal/gateway.js";
import { DemoPayPalGateway } from "./paypal/demo.js";
import { PayPalApiError } from "./paypal/rest.js";
import { modelInfo } from "./ml/risk.js";
import { calibrationReport, exportOutcomesCsv } from "./ml/outcomes.js";
import { handleMcpRequest } from "./mcp/http.js";
import { handlePayPalWebhook } from "./webhooks.js";
import { claimClientKey, isAdmin, resolve, verifyReceiptSig, type Who } from "./auth.js";
import { receiptPage } from "./receipt.js";
import { jwks, trackRecord, verifyAttestation, attestationStatus, getAttestation } from "./proof.js";
import { handleGithubWebhook, verifyGithubSignature } from "./github-webhook.js";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");

const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).then((r) => { if (r !== undefined && !res.headersSent) res.json(r); }).catch(next);

// ---------------- access control ----------------
/** Key from `Authorization: Bearer <key>` (or `x-proofpay-key`). */
const keyOf = (req: Request) => {
  const h = req.header("authorization");
  if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return req.header("x-proofpay-key")?.trim() ?? null;
};
function whoFor(req: Request, escrowId: string): Who {
  const key = keyOf(req);
  if (!key) throw new svc.EscrowError("UNAUTHORIZED", "Send this escrow's access key as 'Authorization: Bearer <key>'", 401);
  const who = resolve(escrowId, key);
  if (!who) throw new svc.EscrowError("FORBIDDEN", "This key doesn't give access to this escrow", 403);
  return who;
}
function milestoneAccess(req: Request) {
  const m = db.getMilestone(String(req.params.id));
  if (!m) throw new svc.EscrowError("NOT_FOUND", "Milestone not found", 404);
  return { milestoneId: m.id, who: whoFor(req, m.escrowId) };
}
function requireAdmin(req: Request) {
  if (!isAdmin(keyOf(req))) throw new svc.EscrowError("FORBIDDEN", "Reviewer (admin) key required", 403);
}

// ---------------- validation ----------------
const Party = z.object({ name: z.string().trim().min(1).max(120), email: z.string().trim().email() });
const CreateBody = z.object({
  title: z.string().trim().min(1).max(200),
  currency: z.string().length(3).default("USD"),
  scopeText: z.string().max(30_000).default(""),
  client: Party,
  freelancer: Party,
  milestones: z.array(DraftMilestone).min(1).max(12),
});
const FromScopeBody = z.object({
  scopeText: z.string().min(20).max(30_000),
  currency: z.string().length(3).default("USD"),
  client: Party,
  freelancer: Party,
});
const httpUrl = z.string().trim().max(2048).url().refine((v) => /^https?:\/\//i.test(v), "must be an http(s) URL");
const EvidenceBody = z.object({
  items: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("github_pr"), value: httpUrl, note: z.string().max(2000).optional() }),
    z.object({ kind: z.literal("url"), value: httpUrl, note: z.string().max(2000).optional() }),
    z.object({ kind: z.literal("text"), value: z.string().trim().min(1).max(50_000), note: z.string().max(2000).optional() }),
  ])).min(1).max(10),
});
const Reason = z.object({ reason: z.string().trim().min(3).max(2000) });

export function buildApp() {
  const app = express();
  app.disable("x-powered-by");
  // keep the raw body for webhook signature checks (GitHub)
  app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
  app.use((_req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
    next();
  });

  // ---------------- meta ----------------
  app.get("/api/health", (_req, res) => res.json({
    ok: true, paypal: paypalMode(), ai: aiMode(), model: modelInfo().version,
    policy: config.policy, platformFeePct: config.paypal.platformFeePct,
  }));

  // ---------------- AI planning (stateless, no data stored) ----------------
  app.post("/api/plans/draft", wrap(async (req) => {
    const { scopeText, currency } = z.object({ scopeText: z.string().min(20).max(30_000), currency: z.string().length(3).default("USD") }).parse(req.body);
    return svc.draftFromScope(scopeText, currency);
  }));

  // ---------------- escrows ----------------
  // Anyone can create an escrow; the response carries the only copies of its access keys.
  app.post("/api/escrows", wrap((req, res) => {
    const b = CreateBody.parse(req.body);
    res.status(201);
    return svc.createEscrow({
      title: b.title, currency: b.currency, scopeText: b.scopeText, milestones: b.milestones,
      clientName: b.client.name, clientEmail: b.client.email, freelancerName: b.freelancer.name, freelancerEmail: b.freelancer.email,
      createdBy: "web",
    });
  }));
  app.post("/api/escrows/from-scope", wrap(async (req, res) => {
    const b = FromScopeBody.parse(req.body);
    const plan = await svc.draftFromScope(b.scopeText, b.currency);
    res.status(201);
    const created = svc.createEscrow({
      title: plan.title, currency: plan.currency, scopeText: b.scopeText, milestones: plan.milestones,
      clientName: b.client.name, clientEmail: b.client.email, freelancerName: b.freelancer.name, freelancerEmail: b.freelancer.email,
      createdBy: req.header("x-created-by") === "agent" ? "agent" : "api",
    });
    return { plan, ...created };
  }));
  /** All escrows — reviewers only. Parties open their own escrows by id + key. */
  app.get("/api/escrows", wrap((req) => { requireAdmin(req); return svc.summaryList(); }));
  app.get("/api/escrows/:id", wrap((req) => {
    const id = String(req.params.id);
    if (!db.getEscrow(id)) throw new svc.EscrowError("NOT_FOUND", "Escrow not found", 404);
    const who = whoFor(req, id);
    return { ...svc.view(id), you: who };
  }));
  app.post("/api/escrows/:id/agent-keys", wrap((req, res) => {
    const id = String(req.params.id);
    if (!db.getEscrow(id)) throw new svc.EscrowError("NOT_FOUND", "Escrow not found", 404);
    const b = z.object({ label: z.string().max(80).default("agent") }).parse(req.body ?? {});
    res.status(201);
    return svc.createAgentKey(id, whoFor(req, id), b.label);
  }));
  /** Reviewers' cross-escrow risk desk. */
  app.get("/api/desk", wrap((req) => { requireAdmin(req); return svc.deskRows(); }));
  /** Scheduled work (hold expiry + due payouts). Runs in-process every 5 minutes; also callable by an external scheduler. */
  app.post("/api/admin/sweep", wrap(async (req) => {
    requireAdmin(req);
    return { ...svc.sweepHolds(), payouts: await svc.processDuePayouts() };
  }));

  // ---------------- portable proof (public) ----------------
  // CORS-open: any site or tool may fetch the key and verify attestations.
  app.get("/.well-known/jwks.json", (_req, res) => res.set({ "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" }).json(jwks()));
  /** Anyone can verify an attestation. Also works offline with the public key above. */
  app.post("/api/attestations/verify", wrap((req) => {
    const { token } = z.object({ token: z.string().min(20).max(20_000) }).parse(req.body);
    return verifyAttestation(token);
  }));
  app.post("/api/attestations/verify-bundle", wrap((req) => {
    const { tokens } = z.object({ tokens: z.array(z.string().min(20).max(20_000)).min(1).max(500) }).parse(req.body);
    return tokens.map(verifyAttestation);
  }));
  app.get("/api/attestations/:id/status", (req, res) => res.json({ id: req.params.id, status: attestationStatus(String(req.params.id)) }));
  /** The freelancer's own track record: every attestation issued to them, as one shareable bundle. */
  app.get("/api/escrows/:id/track-record", wrap((req) => {
    const id = String(req.params.id);
    const e = db.getEscrow(id);
    if (!e) throw new svc.EscrowError("NOT_FOUND", "Escrow not found", 404);
    const who = whoFor(req, id);
    if (who.role !== "freelancer" && who.role !== "reviewer") throw new svc.EscrowError("FORBIDDEN", "Only the freelancer can export their track record", 403);
    return trackRecord(e.freelancerEmail);
  }));
  app.get("/api/events", wrap((req) => {
    const escrowId = String(req.query.escrowId ?? "");
    if (!escrowId) { requireAdmin(req); return db.listEvents(); }
    whoFor(req, escrowId);
    return db.listEvents(escrowId);
  }));

  // ---------------- milestone lifecycle ----------------
  const act = (fn: (milestoneId: string, who: Who, req: Request) => Promise<unknown> | unknown) =>
    wrap((req) => { const { milestoneId, who } = milestoneAccess(req); return fn(milestoneId, who, req); });

  app.post("/api/milestones/:id/fund", act((id, who) => svc.fundMilestone(id, who)));
  app.post("/api/milestones/:id/evidence", act((id, who, req) => svc.submitEvidence(id, EvidenceBody.parse(req.body).items, who)));
  app.post("/api/milestones/:id/verify", act((id, who) => svc.runVerification(id, who)));
  app.post("/api/milestones/:id/release", act((id, who) => svc.release(id, who)));
  app.post("/api/milestones/:id/request-changes", act((id, who, req) => svc.requestChanges(id, Reason.parse(req.body).reason, who)));
  app.post("/api/milestones/:id/refund", act((id, who, req) => svc.refund(id, Reason.parse(req.body).reason, who)));
  app.post("/api/milestones/:id/retry-payout", act((id, who) => svc.retryPayout(id, who)));
  app.post("/api/milestones/:id/dispute", act((id, who, req) => svc.openDispute(id, Reason.parse(req.body).reason, who)));
  app.post("/api/milestones/:id/resolve", act((id, who, req) => {
    const b = z.object({ outcome: z.enum(["release", "refund"]), note: z.string().max(2000).default("") }).parse(req.body);
    return svc.resolveDispute(id, b.outcome, b.note, who);
  }));
  app.get("/api/milestones/:id/risk", act((id) => svc.currentRisk(id)));

  // ---------------- signed public receipt (proof of delivery) ----------------
  app.get("/receipts/:id", (req, res) => {
    const m = db.getMilestone(String(req.params.id));
    if (!m || !verifyReceiptSig(m.id, String(req.query.sig ?? "")) || m.status !== "RELEASED") return res.status(404).type("text").send("Receipt not found");
    res.type("html").send(receiptPage(m, db.getEscrow(m.escrowId)!, db.listEvidence(m.id), db.listEvents(m.escrowId).filter((x) => x.milestoneId === m.id), getAttestation(m.id)));
  });

  // ---------------- ML ----------------
  app.get("/api/ml/model", (_req, res) => res.json(modelInfo()));
  /** Labelled outcomes with the features logged at decision time — for retraining (reviewers only). */
  app.get("/api/ml/export", wrap((req, res) => { requireAdmin(req); res.type("text/csv").send(exportOutcomesCsv()); }));
  /** How well predicted risk matched real outcomes so far (reviewers only). */
  app.get("/api/ml/calibration", wrap((req) => { requireAdmin(req); return calibrationReport(); }));

  // ---------------- PayPal redirects & webhooks ----------------
  app.get("/paypal/return", wrap(async (req, res) => {
    const orderId = String(req.query.token ?? "");
    const m = db.getMilestoneByOrder(orderId);
    if (!m) return res.status(404).send("Unknown order");
    try {
      const after = await svc.onOrderApproved(orderId, "client");
      // Agent-created escrow: the person who just approved in PayPal receives the client key (once).
      const claimed = after.status !== "AWAITING_APPROVAL" ? claimClientKey(m.escrowId) : null;
      res.redirect(`/#/escrow/${m.escrowId}?funded=${m.id}${claimed ? `&key=${claimed}` : ""}`);
    } catch (e) {
      res.redirect(`/#/escrow/${m.escrowId}?error=${encodeURIComponent((e as Error).message)}`);
    }
  }));
  app.get("/paypal/cancel", (req, res) => {
    const m = db.getMilestone(String(req.query.milestone ?? ""));
    res.redirect(m ? `/#/escrow/${m.escrowId}?cancelled=${m.id}` : "/");
  });
  app.post("/api/webhooks/github", wrap(async (req, res) => {
    if (!verifyGithubSignature((req as any).rawBody, req.header("x-hub-signature-256") ?? undefined))
      throw new svc.EscrowError("BAD_SIGNATURE", "GitHub webhook signature doesn't match GITHUB_WEBHOOK_SECRET", 401);
    res.status(200);
    return handleGithubWebhook(String(req.header("x-github-event") ?? ""), req.body);
  }));
  app.post("/api/webhooks/paypal", wrap(async (req, res) => {
    res.status(200);
    return handlePayPalWebhook(req.headers, req.body);
  }));

  // ---------------- simulator-only helpers ----------------
  app.get("/demo-checkout/:orderId", (req, res) => {
    if (paypalMode() !== "demo") return res.status(404).end();
    const m = db.getMilestoneByOrder(req.params.orderId);
    if (!m) return res.status(404).send("Unknown order");
    const e = db.getEscrow(m.escrowId)!;
    res.type("html").send(demoCheckoutPage(req.params.orderId, e.title, m.title, m.amount, e.currency));
  });
  app.post("/demo-checkout/:orderId/approve", (req, res) => {
    const gw = paypal();
    if (!(gw instanceof DemoPayPalGateway)) return res.status(404).end();
    gw.approve(req.params.orderId);
    res.redirect(`/paypal/return?token=${encodeURIComponent(req.params.orderId)}`);
  });
  /** Simulator only: a buyer opens a PayPal dispute on a released milestone (to demo the chargeback defence). */
  app.post("/api/demo/paypal-dispute/:id", wrap(async (req) => {
    const gw = paypal();
    if (!(gw instanceof DemoPayPalGateway)) throw new svc.EscrowError("NOT_AVAILABLE", "Only available with the PayPal simulator", 404);
    const { milestoneId, who } = milestoneAccess(req);
    if (who.role !== "client" && who.role !== "reviewer") throw new svc.EscrowError("FORBIDDEN", "Only the client (buyer) can open a PayPal dispute", 403);
    const m = db.getMilestone(milestoneId)!;
    if (!m.captureId) throw new svc.EscrowError("INVALID_STATE", "Only released (captured) milestones can be disputed with PayPal");
    const disputeId = gw.simulateDispute(m.captureId, m.amount, db.getEscrow(m.escrowId)!.currency);
    await svc.onPayPalDispute(disputeId);
    return svc.view(m.escrowId, m.id);
  }));

  // ---------------- MCP (remote, Streamable HTTP) ----------------
  app.all("/mcp", (req, res, next) => handleMcpRequest(req, res).catch(next));

  // ---------------- UI ----------------
  app.get("/favicon.ico", (_req, res) => res.status(204).end()); // pages without an icon link (e.g. demo checkout)
  app.get("/openapi.yaml", (_req, res) => res.type("application/yaml").sendFile(join(here, "..", "apimatic", "src", "spec", "openapi.yaml")));
  app.use(express.static(publicDir, { extensions: ["html"] }));
  app.use("/vendor/ag-grid", express.static(join(here, "..", "node_modules", "ag-grid-community", "dist"), { maxAge: "7d" }));
  // Bryntum Gantt (trial package from public npm; loaded only when the Timeline tab opens)
  app.use("/vendor/bryntum", express.static(join(here, "..", "node_modules", "@bryntum", "gantt"), { maxAge: "7d", index: false }));

  // ---------------- errors ----------------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof svc.EscrowError) return res.status(err.httpStatus).json({ error: err.code, message: err.message });
    if (err instanceof ZodError) return res.status(400).json({ error: "VALIDATION_ERROR", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    if (err instanceof PayPalApiError) return res.status(502).json({ error: "PAYPAL_ERROR", message: err.message, debugId: err.debugId });
    const status = (err as any)?.status ?? (err as any)?.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) // e.g. malformed JSON body
      return res.status(status).json({ error: "BAD_REQUEST", message: (err as Error).message });
    console.error(err);
    res.status(500).json({ error: "INTERNAL", message: "Something went wrong on the server" });
  });
  return app;
}

function demoCheckoutPage(orderId: string, escrow: string, milestone: string, amount: number, currency: string) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Demo checkout</title><style>
body{font-family:system-ui,sans-serif;background:#f3f5f0;color:#14213d;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#fff;border:1px solid #dfe3da;border-radius:14px;padding:28px;max-width:400px;width:calc(100% - 32px)}
.tag{display:inline-block;background:#fbf0dc;color:#a86a12;font-size:12px;padding:3px 8px;border-radius:99px;margin-bottom:14px}
h1{font-size:20px;margin:0 0 6px}.amt{font-size:34px;font-weight:700;margin:18px 0}
p{color:#44506a;line-height:1.5;font-size:14px}button{width:100%;padding:13px;border:0;border-radius:10px;background:#14213d;color:#fff;font-size:15px;cursor:pointer}
</style></head><body><div class="card"><span class="tag">Simulator — no real PayPal call</span>
<h1>${esc(escrow)}</h1><p>${esc(milestone)}</p><div class="amt">${currency} ${amount.toFixed(2)}</div>
<p>With PayPal sandbox keys set, this step is PayPal's real approval page. Approving places an <b>authorization hold</b>: the money is reserved, not charged, until the work is verified.</p>
<form method="post" action="/demo-checkout/${esc(orderId)}/approve"><button>Approve hold</button></form></div></body></html>`;
}
