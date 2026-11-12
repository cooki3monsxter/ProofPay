import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * ProofPay's agent interface. Any MCP client (Claude, Cursor, an autonomous procurement agent)
 * can hire and pay through these tools. Safety is enforced server-side, not by the prompt:
 *   - agents use AGENT keys; the server knows from the key that the caller is an agent
 *   - funding returns a PayPal approval link that a PERSON must approve with their own PayPal login
 *   - money is released automatically only when verification passes AND ML risk is low
 *   - an agent can never override a policy hold, refund, retry payouts or resolve disputes
 */
export type Api = (method: "GET" | "POST", path: string, body?: unknown, key?: string) => Promise<unknown>;

export function restApi(baseUrl: string): Api {
  return async (method, path, body, key) => {
    const headers: Record<string, string> = { "content-type": "application/json", "x-created-by": "agent" };
    if (key) headers.authorization = `Bearer ${key}`;
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error((j as any).message ?? res.statusText), { code: (j as any).error });
    return j;
  };
}

const ok = (data: unknown, hint?: string) => ({
  content: [{ type: "text" as const, text: (hint ? hint + "\n\n" : "") + JSON.stringify(data, null, 2) }],
});
const err = (e: any) => ({
  isError: true,
  content: [{ type: "text" as const, text: `${e.code ?? "ERROR"}: ${e.message}` }],
});
const safe = <A>(fn: (a: A) => Promise<ReturnType<typeof ok>>) => async (a: A) => { try { return await fn(a); } catch (e) { return err(e); } };

const escrowKey = z.string().min(10).describe("The agent key returned by proofpay_create_escrow (or one a person created for you in the dashboard)");

function compactEscrow(e: any) {
  return {
    id: e.id, title: e.title, status: e.status, currency: e.currency, totals: e.totals, you: e.you,
    milestones: e.milestones.map((m: any) => ({
      id: m.id, seq: m.seq, title: m.title, amount: m.amount, status: m.status, dueDate: m.dueDate,
      criteria: m.criteria.map((c: any) => `${c.type}: ${c.description}`),
      approvalUrl: m.status === "AWAITING_APPROVAL" ? m.approvalUrl : undefined,
      verdict: m.lastVerdict?.summary, risk: m.risk ? `${Math.round(m.risk.score * 100)}% (${m.risk.band})` : undefined,
      decision: m.decision, holdExpiresSoon: m.holdExpiresSoon || undefined, receiptUrl: m.receiptUrl ?? undefined,
    })),
  };
}

export function buildMcpServer(api: Api) {
  const server = new McpServer({ name: "proofpay", version: "1.1.0" }, {
    instructions: "ProofPay holds payments in PayPal escrow and releases them only on verified proof of work. Typical flow: proofpay_create_escrow (keep the agentKey; send freelancerLink to the freelancer) → proofpay_fund_milestone (give the person the approval link — only they can approve it) → the freelancer delivers → read the decision with proofpay_get_escrow. Never claim money moved unless a tool result shows status RELEASED. If a tool returns HUMAN_APPROVAL_REQUIRED, tell the person what to do in the dashboard; don't retry.",
  });

  server.registerTool("proofpay_draft_plan", {
    title: "Draft escrow plan from a scope of work",
    description: "Use AI to split a freelance scope into milestones with amounts and machine-checkable acceptance criteria. Creates nothing.",
    inputSchema: { scopeText: z.string().min(20), currency: z.string().length(3).default("USD") },
    annotations: { readOnlyHint: true },
  }, safe(async (a) => ok(await api("POST", "/api/plans/draft", a))));

  server.registerTool("proofpay_create_escrow", {
    title: "Create escrow from scope",
    description: "Create a milestone escrow between a client and a freelancer from a plain-language scope of work. Returns an agentKey for you, and a freelancerLink to send to the freelancer. The client gets their own dashboard link when they approve the first PayPal hold.",
    inputSchema: {
      scopeText: z.string().min(20).describe("The agreed scope, with milestones, amounts and acceptance criteria"),
      clientName: z.string(), clientEmail: z.string().email(),
      freelancerName: z.string(), freelancerEmail: z.string().email().describe("Freelancer's PayPal email — payouts go here"),
      currency: z.string().length(3).default("USD"),
    },
  }, safe(async (a) => {
    const r: any = await api("POST", "/api/escrows/from-scope", {
      scopeText: a.scopeText, currency: a.currency,
      client: { name: a.clientName, email: a.clientEmail }, freelancer: { name: a.freelancerName, email: a.freelancerEmail },
    });
    return ok({
      agentKey: r.access.agentKey, freelancerLink: r.access.freelancerLink, clientAccess: r.access.clientAccess,
      warnings: r.plan.warnings, aiEngine: r.plan.engine, escrow: compactEscrow(r.escrow),
    }, "Escrow created. Keep agentKey for the next calls. Send freelancerLink to the freelancer. Next: fund the first milestone.");
  }));

  server.registerTool("proofpay_get_escrow", {
    title: "Get escrow", description: "Get an escrow with every milestone's status, verdict, risk score and decision.",
    inputSchema: { escrowId: z.string(), escrowKey }, annotations: { readOnlyHint: true },
  }, safe(async (a) => ok(compactEscrow(await api("GET", `/api/escrows/${a.escrowId}`, undefined, a.escrowKey)))));

  server.registerTool("proofpay_fund_milestone", {
    title: "Fund milestone (PayPal hold)",
    description: "Create a PayPal order with intent AUTHORIZE for this milestone. Returns an approval URL that the person must open and approve with their own PayPal login. You cannot approve payments.",
    inputSchema: { milestoneId: z.string(), escrowKey },
  }, safe(async (a) => {
    const r: any = await api("POST", `/api/milestones/${a.milestoneId}/fund`, undefined, a.escrowKey);
    return ok({ approvalUrl: r.approvalUrl, status: r.milestone.status },
      "Ask the person to open approvalUrl and approve. Funds are held (authorized), not charged, until the work is verified.");
  }));

  server.registerTool("proofpay_submit_work", {
    title: "Submit proof of work",
    description: "Submit delivery evidence for a funded milestone (needs a freelancer's agent key). Verification runs immediately; if every criterion passes with high confidence and the ML risk score is low, PayPal captures the hold and pays the freelancer automatically.",
    inputSchema: {
      milestoneId: z.string(), escrowKey,
      githubPrUrl: z.string().url().optional(), deployedUrl: z.string().url().optional(),
      text: z.string().optional().describe("Written deliverable or description"), note: z.string().optional(),
    },
    annotations: { destructiveHint: true },
  }, safe(async (a) => {
    const items = [
      a.githubPrUrl && { kind: "github_pr", value: a.githubPrUrl, note: a.note },
      a.deployedUrl && { kind: "url", value: a.deployedUrl, note: a.note },
      a.text && { kind: "text", value: a.text, note: a.note },
    ].filter(Boolean);
    const r: any = await api("POST", `/api/milestones/${a.milestoneId}/evidence`, { items }, a.escrowKey);
    const m = r.milestones.find((x: any) => x.id === a.milestoneId);
    return ok({ status: m.status, decision: m.decision, verdict: m.lastVerdict, risk: m.risk && { score: m.risk.score, band: m.risk.band, reasons: m.risk.reasons } });
  }));

  server.registerTool("proofpay_verify_milestone", {
    title: "Re-run verification", description: "Re-run acceptance checks on already-submitted evidence (e.g. after a PR was merged or CI finished).",
    inputSchema: { milestoneId: z.string(), escrowKey },
  }, safe(async (a) => {
    const r: any = await api("POST", `/api/milestones/${a.milestoneId}/verify`, undefined, a.escrowKey);
    const m = r.milestones.find((x: any) => x.id === a.milestoneId);
    return ok({ status: m.status, decision: m.decision, verdict: m.lastVerdict?.summary, risk: m.risk && { score: m.risk.score, band: m.risk.band } });
  }));

  server.registerTool("proofpay_release_milestone", {
    title: "Release payment",
    description: "Ask to release a held milestone. Payments held by policy can only be released by the person in the dashboard — the server will refuse with HUMAN_APPROVAL_REQUIRED.",
    inputSchema: { milestoneId: z.string(), escrowKey }, annotations: { destructiveHint: true },
  }, safe(async (a) => ok(compactEscrow(await api("POST", `/api/milestones/${a.milestoneId}/release`, undefined, a.escrowKey)))));

  server.registerTool("proofpay_request_changes", {
    title: "Request changes", description: "Send submitted work back to the freelancer with what to fix. The money stays held.",
    inputSchema: { milestoneId: z.string(), escrowKey, reason: z.string().min(3) },
  }, safe(async (a) => ok(compactEscrow(await api("POST", `/api/milestones/${a.milestoneId}/request-changes`, { reason: a.reason }, a.escrowKey)))));

  server.registerTool("proofpay_open_dispute", {
    title: "Open dispute", description: "Freeze a milestone and generate a neutral AI evidence brief for a human reviewer.",
    inputSchema: { milestoneId: z.string(), escrowKey, reason: z.string().min(3) },
  }, safe(async (a) => ok(compactEscrow(await api("POST", `/api/milestones/${a.milestoneId}/dispute`, { reason: a.reason }, a.escrowKey)))));

  server.registerTool("proofpay_explain_risk", {
    title: "Explain release risk", description: "Show the ML risk score for a milestone and the top factors behind it.",
    inputSchema: { milestoneId: z.string(), escrowKey }, annotations: { readOnlyHint: true },
  }, safe(async (a) => ok(await api("GET", `/api/milestones/${a.milestoneId}/risk`, undefined, a.escrowKey))));

  return server;
}
