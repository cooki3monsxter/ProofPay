export type CriterionType = "github_pr_merged" | "github_checks_passed" | "url_live" | "url_contains" | "ai_judgment";

export interface Criterion {
  id: string;
  type: CriterionType;
  description: string;
  /** e.g. { text: "Checkout" } for url_contains, { pathPrefix: "src/" } for github */
  params?: Record<string, string>;
}

export type MilestoneStatus =
  | "DRAFT" // created, not funded
  | "AWAITING_APPROVAL" // PayPal order created, client must approve on PayPal
  | "FUNDED" // payment authorized and held, not captured
  | "SUBMITTED" // freelancer submitted proof
  | "NEEDS_REVIEW" // verified but policy requires a human
  | "CHANGES_REQUESTED" // verification failed, freelancer can resubmit
  | "RELEASED" // captured + paid out to freelancer
  | "DISPUTED"
  | "REFUNDED"; // authorization voided, client never charged

export type EscrowStatus = "ACTIVE" | "COMPLETED" | "CANCELLED";

export interface Escrow {
  id: string;
  title: string;
  clientName: string;
  clientEmail: string;
  freelancerName: string;
  freelancerEmail: string;
  currency: string;
  scopeText: string;
  status: EscrowStatus;
  createdBy: "web" | "agent" | "api";
  createdAt: string;
}

export interface Verdict {
  passed: boolean;
  confidence: number;
  results: CriterionResult[];
  summary: string;
  verifiedAt: string;
  engine: "claude" | "heuristic";
}

export interface RiskAssessment {
  score: number; // probability of a bad outcome (dispute / non-delivery)
  band: "low" | "medium" | "high";
  reasons: { feature: string; impact: number; label: string }[];
  modelVersion: string;
  /** Raw feature vector at decision time — logged so the model can be retrained on real outcomes. */
  features?: Record<string, number>;
}

export interface Milestone {
  id: string;
  escrowId: string;
  seq: number;
  title: string;
  description: string;
  amount: number;
  dueDate: string | null;
  criteria: Criterion[];
  status: MilestoneStatus;
  paypalOrderId: string | null;
  approvalUrl: string | null;
  authorizationId: string | null;
  authorizationExpiresAt: string | null;
  captureId: string | null;
  payoutBatchId: string | null;
  resubmissions: number;
  fundedAt: string | null;
  submittedAt: string | null;
  releasedAt: string | null;
  lastVerdict: Verdict | null;
  risk: RiskAssessment | null;
  decision: string | null;
  /** A PayPal buyer dispute / chargeback opened against this milestone's capture. */
  paypalDisputeId: string | null;
  paypalDisputeStatus: string | null;
  /** When the freelancer's payout goes out (risk-priced). Null = not scheduled / already paid. */
  payoutDueAt: string | null;
}

export interface CriterionResult {
  criterionId: string;
  passed: boolean;
  confidence: number; // 0..1
  detail: string;
  /** Not failed, just not finished yet (PR open, CI running). The GitHub webhook re-checks it. */
  pending?: boolean;
}

export interface Evidence {
  id: string;
  milestoneId: string;
  kind: "github_pr" | "url" | "text";
  value: string;
  note: string;
  submittedAt: string;
}

export interface LedgerEvent {
  id: number;
  ts: string;
  escrowId: string;
  milestoneId: string | null;
  type: string;
  actor: string;
  amount: number | null;
  message: string;
  data: unknown;
}
