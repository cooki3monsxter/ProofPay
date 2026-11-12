import type { Escrow, Evidence, LedgerEvent, Milestone } from "./types.js";

/**
 * Public, signed proof-of-delivery page for a released milestone. Linked from the evidence ProofPay
 * sends to PayPal when a buyer disputes a payment. Shows what was agreed, what was delivered and
 * what the checks found — no email addresses or keys.
 */
export function receiptPage(m: Milestone, e: Escrow, evidence: Evidence[], events: LedgerEvent[], attestation: string | null = null) {
  const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const results = new Map((m.lastVerdict?.results ?? []).map((r) => [r.criterionId, r]));
  const link = (v: string) => (/^https?:\/\//i.test(v) ? `<a href="${esc(v)}" rel="noopener noreferrer nofollow">${esc(v)}</a>` : esc(v));
  const money = `${e.currency} ${m.amount.toFixed(2)}`;
  const timeline = events
    .filter((x) => ["ORDER_CREATED", "FUNDS_HELD", "EVIDENCE_SUBMITTED", "GITHUB_EVENT", "VERIFICATION_PASSED", "VERIFICATION_FAILED", "HELD_FOR_REVIEW", "CAPTURED", "PAYOUT_SCHEDULED", "PAYOUT_SENT"].includes(x.type))
    .sort((a, b) => a.id - b.id);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Delivery receipt</title><style>
:root{--ink:#14213d;--ink2:#44506a;--ink3:#7a8499;--rule:#dfe3da;--green:#1f7a5a;--red:#b42318;--paper:#f3f5f0}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:36px 18px 60px}
.card{background:#fff;border:1px solid var(--rule);border-radius:14px;padding:22px 24px;margin-bottom:16px}
h1{font-size:26px;margin:0 0 4px;letter-spacing:-.02em}h2{font-size:16px;margin:0 0 10px}
.muted{color:var(--ink3);font-size:13.5px}.amt{font-size:28px;font-weight:800}
ul{margin:0;padding:0;list-style:none;display:grid;gap:10px}li{display:grid;grid-template-columns:22px 1fr;gap:8px}
.ok{color:var(--green);font-weight:800}.no{color:var(--red);font-weight:800}
.detail{color:var(--ink2);font-size:13.5px}a{color:inherit;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:13.5px}td{padding:6px 0;border-top:1px solid var(--rule);vertical-align:top}td:first-child{color:var(--ink3);width:150px}
</style></head><body><main>
<p class="muted">ProofPay delivery receipt · ${esc(m.id)}</p>
<div class="card"><h1>${esc(m.title)}</h1><p class="muted">Part of “${esc(e.title)}” · ${esc(e.clientName)} paid ${esc(e.freelancerName)}</p>
<p class="amt">${esc(money)}</p>
<p class="detail">The client's money was held by PayPal and captured only after the delivery below was checked against the agreed criteria.</p></div>
<div class="card"><h2>Agreed criteria and results</h2><ul>
${m.criteria.map((c) => { const r = results.get(c.id); return `<li><span class="${r?.passed ? "ok" : "no"}">${r ? (r.passed ? "✓" : "✕") : "–"}</span><div>${esc(c.description)}${r ? `<div class="detail">${esc(r.detail)} (${Math.round(r.confidence * 100)}% confidence)</div>` : ""}</div></li>`; }).join("")}
</ul></div>
<div class="card"><h2>Delivered</h2><ul>${evidence.map((v) => `<li><span>•</span><div>${v.kind === "text" ? `<span class="detail">${esc(v.value.slice(0, 600))}${v.value.length > 600 ? "…" : ""}</span>` : link(v.value)}<div class="muted">${esc(v.submittedAt.slice(0, 16).replace("T", " "))} UTC</div></div></li>`).join("") || "<li>None</li>"}</ul></div>
<div class="card"><h2>Timeline</h2><table>${timeline.map((t) => `<tr><td>${esc(t.ts.slice(0, 16).replace("T", " "))} UTC</td><td>${esc(publicLine(t))}</td></tr>`).join("")}</table></div>
${attestation ? `<p><a href="/verify#t=${esc(attestation)}" style="font-weight:700;color:var(--green)">✓ Check the signed proof of delivery independently</a></p>` : ""}
<p class="muted">PayPal capture ${esc(m.captureId ?? "–")}${m.payoutBatchId ? ` · payout batch ${esc(m.payoutBatchId)}` : ""}. This page is signed; changing the link invalidates it.</p>
</main></body></html>`;
}

/** Public wording for each ledger step — written fresh rather than reusing internal messages, which may contain emails. */
function publicLine(t: LedgerEvent) {
  const text: Record<string, string> = {
    ORDER_CREATED: "Client started funding with PayPal",
    FUNDS_HELD: "PayPal authorization placed — money held, client not yet charged",
    EVIDENCE_SUBMITTED: "Freelancer submitted proof of delivery",
    VERIFICATION_PASSED: "Automated checks passed",
    VERIFICATION_FAILED: "Automated checks failed — changes requested",
    HELD_FOR_REVIEW: "Held for the client's approval",
    CAPTURED: t.actor === "system" ? "Released automatically after all checks passed — PayPal captured the payment" : "Client approved the release — PayPal captured the payment",
    PAYOUT_SENT: "Freelancer paid via PayPal Payouts",
    PAYOUT_SCHEDULED: "Freelancer's payout scheduled (risk-based delay)",
    GITHUB_EVENT: "GitHub reported the pull request merged or CI finished",
  };
  return (text[t.type] ?? t.type).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]");
}
