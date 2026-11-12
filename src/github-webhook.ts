import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import * as db from "./db.js";
import * as svc from "./services/escrow.js";

/**
 * GitHub webhook: merging the pull request is the release button.
 *
 * Point a repository webhook (content type application/json) at <host>/api/webhooks/github and subscribe
 * to "Pull requests", "Check suites" and "Check runs". When a PR that a freelancer submitted as proof is
 * merged, or its CI finishes, ProofPay re-runs verification. If everything passes, PayPal captures the hold.
 *
 * The webhook is only a trigger: verification always reads the real state from the GitHub API, so a forged
 * delivery can't release money. With GITHUB_WEBHOOK_SECRET set, signatures are checked as well.
 */
export function verifyGithubSignature(raw: Buffer | undefined, header: string | undefined) {
  const secret = config.github.webhookSecret;
  if (!secret) return true;
  if (!raw || !header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`);
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/** PR URLs this event is about. */
export function prUrlsFromEvent(event: string, body: any): string[] {
  const repoUrl: string | undefined = body?.repository?.html_url;
  const fromList = (prs: any[] | undefined) => (repoUrl ? (prs ?? []).map((p) => `${repoUrl}/pull/${p.number}`) : []);
  switch (event) {
    case "pull_request":
      return body?.action === "closed" && body?.pull_request?.merged ? [body.pull_request.html_url] : [];
    case "check_suite":
      return body?.action === "completed" ? fromList(body.check_suite?.pull_requests) : [];
    case "check_run":
      return body?.action === "completed" ? fromList(body.check_run?.pull_requests) : [];
    default:
      return [];
  }
}

export async function handleGithubWebhook(event: string, body: any) {
  if (event === "ping") return { ok: true, pong: true };
  const urls = [...new Set(prUrlsFromEvent(event, body))];
  const waiting = db.milestonesWithEvidence(urls).filter((m) => ["SUBMITTED", "CHANGES_REQUESTED", "NEEDS_REVIEW"].includes(m.status));
  const results: { milestoneId: string; status: string }[] = [];
  for (const m of waiting) {
    db.logEvent({ escrowId: m.escrowId, milestoneId: m.id, type: "GITHUB_EVENT", actor: "github", amount: null,
      message: `GitHub ${event === "pull_request" ? "reports the pull request was merged" : "finished CI"} (${urls.join(", ")}). Re-checking delivery.`, data: { event } });
    try {
      const v = await svc.runVerification(m.id, { role: "system", viaAgent: false });
      results.push({ milestoneId: m.id, status: v.milestones.find((x) => x.id === m.id)!.status });
    } catch (e) {
      results.push({ milestoneId: m.id, status: `error: ${(e as Error).message}` });
    }
  }
  return { ok: true, event, prs: urls, rechecked: results };
}
