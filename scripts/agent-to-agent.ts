/**
 * Agent hires agent, with PayPal escrow in between.
 *
 * Two independent MCP clients talk to ProofPay with different keys:
 *   buyer-agent   — works for a client. Creates the escrow, asks for funding, tries to release money.
 *   seller-agent  — works for a freelancer. Delivers the work and submits proof.
 * People stay in the loop exactly where money moves: the client approves the PayPal hold, and the
 * freelancer gives their agent its key.
 *
 *   npm run demo:agents                                   # offline, text deliverable, simulator
 *   npm run demo:agents -- --pr https://github.com/you/repo/pull/7   # code deliverable (real PR)
 *   PROOFPAY_URL=https://your-app.onrender.com npm run demo:agents
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createInterface } from "node:readline/promises";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const BASE = (arg("url") ?? process.env.PROOFPAY_URL ?? "http://localhost:8080").replace(/\/$/, "");
const PR = arg("pr");

const c = { dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", amber: "\x1b[33m", blue: "\x1b[34m", red: "\x1b[31m", reset: "\x1b[0m" };
const say = (who: "buyer" | "seller" | "person" | "proofpay", msg: string) => {
  const tag = { buyer: `${c.blue}buyer-agent ${c.reset}`, seller: `${c.amber}seller-agent${c.reset}`, person: `${c.bold}person      ${c.reset}`, proofpay: `${c.green}ProofPay    ${c.reset}` }[who];
  console.log(`${tag}  ${msg}`);
};
const pause = (ms = 600) => new Promise((r) => setTimeout(r, ms));

async function connect(name: string) {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  return client;
}
async function tool(client: Client, name: string, args: Record<string, unknown>) {
  const r: any = await client.callTool({ name, arguments: args });
  const text: string = r.content?.[0]?.text ?? "";
  if (r.isError) return { error: text };
  const json = text.includes("\n\n{") ? text.slice(text.indexOf("\n\n{") + 2) : text;
  return JSON.parse(json);
}

const SCOPE = PR
  ? `Fix the checkout bug in our shop
Milestone 1: Checkout fix - $120, due in 3 days. Code delivered as a GitHub PR merged to main.`
  : `API docs for the Sweet Crumbs bakery ordering service
Milestone 1: README - $80, due in 3 days. Acceptance: a README covering installation, environment variables, and example requests for creating and listing orders.`;

const README = `# Sweet Crumbs Ordering API
## Installation
npm install, then npm start. Requires Node 22.
## Environment variables
DATABASE_URL (Postgres connection string), PORT (default 8080), PAYPAL_CLIENT_ID for checkout.
## Example requests
Create an order: POST /orders with {"item":"sourdough","qty":2}.
List orders: GET /orders returns the newest first.`;

async function main() {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health) throw new Error(`ProofPay isn't reachable at ${BASE}. Start it with npm run dev.`);
  console.log(`${c.dim}ProofPay at ${BASE} · PayPal ${health.paypal} · AI ${health.ai}${c.reset}\n`);

  const buyer = await connect("buyer-agent");
  const seller = await connect("seller-agent");

  // 1 — buyer agent hires
  say("buyer", `Hiring a freelancer for: "${SCOPE.split("\n")[0]}"`);
  const created = await tool(buyer, "proofpay_create_escrow", {
    scopeText: SCOPE, clientName: "Sweet Crumbs (via buyer-agent)", clientEmail: "owner@sweetcrumbs.example",
    freelancerName: "Riya (via seller-agent)", freelancerEmail: "riya@freelance.example",
  });
  if (created.error) throw new Error(created.error);
  const escrowId = created.escrow.id;
  const ms = created.escrow.milestones[0];
  say("proofpay", `Escrow ${escrowId}: "${ms.title}" for $${ms.amount}. Criteria: ${ms.criteria.join("; ")}`);
  say("proofpay", `buyer-agent got an agent key. It never sees the client's own key.`);
  await pause();

  // 2 — funding needs a person
  const funded = await tool(buyer, "proofpay_fund_milestone", { milestoneId: ms.id, escrowKey: created.agentKey });
  say("buyer", `Asked to fund it. I can't approve payments, so here's the PayPal link for my person.`);
  if (health.paypal === "demo") {
    const orderId = new URL(funded.approvalUrl).pathname.split("/").pop()!;
    await fetch(`${BASE}/demo-checkout/${orderId}/approve`, { method: "POST", redirect: "manual" });
    const ret = await fetch(`${BASE}/paypal/return?token=${orderId}`, { redirect: "manual" });
    say("person", `Approved the PayPal hold (simulator). Got the client dashboard link: ${ret.headers.get("location")?.includes("key=") ? "yes" : "no"}`);
  } else {
    say("person", `Open this and approve with your sandbox buyer account:\n              ${funded.approvalUrl}`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question(`${c.dim}              Press Enter after approving…${c.reset}`);
    rl.close();
  }
  say("proofpay", `$${ms.amount} is held at PayPal. Nobody has been charged.`);
  await pause();

  // 3 — the freelancer gives their own agent a key
  const flKey = new URL(created.freelancerLink.replace("/#/", "/")).searchParams.get("key");
  const minted = await fetch(`${BASE}/api/escrows/${escrowId}/agent-keys`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${flKey}` }, body: JSON.stringify({ label: "seller-agent" }),
  }).then((r) => r.json());
  say("person", `Freelancer opened their link and created a key for seller-agent.`);
  await pause();

  // 4 — seller agent delivers
  if (PR) say("seller", `Opened and shipped ${PR}. Submitting it as proof.`);
  else say("seller", `Wrote the README (${README.length} chars). Submitting it as proof.`);
  const submitted = await tool(seller, "proofpay_submit_work", PR
    ? { milestoneId: ms.id, escrowKey: minted.agentKey, githubPrUrl: PR }
    : { milestoneId: ms.id, escrowKey: minted.agentKey, text: README });
  if (submitted.error) throw new Error(submitted.error);
  const results = submitted.verdict?.results ?? [];
  for (const r of results) say("proofpay", `${r.passed ? `${c.green}✓${c.reset}` : r.pending ? `${c.amber}…${c.reset}` : `${c.red}✕${c.reset}`} ${r.detail}`);
  if (submitted.risk) say("proofpay", `Release risk ${Math.round(submitted.risk.score * 100)}% (${submitted.risk.band}).`);
  say("proofpay", `Decision: ${submitted.decision}`);
  await pause();

  // 5 — the buyer agent tries to push money out
  const state = await tool(buyer, "proofpay_get_escrow", { escrowId, escrowKey: created.agentKey });
  const m = state.milestones[0];
  if (m.status === "NEEDS_REVIEW") {
    say("buyer", `Looks done to me. Releasing the payment…`);
    const rel = await tool(buyer, "proofpay_release_milestone", { milestoneId: ms.id, escrowKey: created.agentKey });
    say("proofpay", `${c.red}${rel.error ?? "released"}${c.reset}`);
    say("buyer", `Understood — my person needs to approve this one in the dashboard.`);
  } else if (m.status === "RELEASED") {
    say("proofpay", `${c.green}Released: PayPal captured the hold.${c.reset} ${m.receiptUrl ? `Receipt: ${m.receiptUrl}` : ""}`);
  } else if (m.status === "CHANGES_REQUESTED" && PR) {
    say("seller", `Waiting for a maintainer to merge. With the GitHub webhook set up, merging releases the payment.`);
  }
  console.log(`\n${c.dim}Open the escrow as the reviewer or follow the client link to see the ledger: ${BASE}/#/escrow/${escrowId}${c.reset}`);
  await buyer.close();
  await seller.close();
}

main().catch((e) => { console.error(`${c.red}${(e as Error).message}${c.reset}`); process.exit(1); });
