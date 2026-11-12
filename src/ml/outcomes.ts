import * as db from "../db.js";
import { featureNames } from "./risk.js";

/**
 * Real outcomes for the risk model. Each settled milestone becomes a labelled example using the
 * feature vector logged at decision time (not recomputed later, which would leak the outcome).
 *
 * Label = 1 ("bad") when a dispute was opened inside ProofPay, a PayPal dispute/chargeback hit the
 * capture after release, or the hold was refunded after work was submitted. Released without any
 * dispute = 0. Milestones still in progress are excluded.
 */
export function labelledOutcomes() {
  const rows: { milestoneId: string; features: Record<string, number>; predicted: number; label: 0 | 1 }[] = [];
  for (const e of db.listEscrows()) {
    const events = db.listEvents(e.id);
    for (const m of db.listMilestones(e.id)) {
      if (!m.risk?.features) continue; // never verified, so no decision was made
      const disputed = events.some((x) => x.milestoneId === m.id && (x.type === "DISPUTE_OPENED" || x.type === "PAYPAL_DISPUTE_OPENED"));
      let label: 0 | 1 | null = null;
      if (disputed || (m.status === "REFUNDED" && m.submittedAt)) label = 1;
      else if (m.status === "RELEASED") label = 0;
      if (label === null) continue;
      rows.push({ milestoneId: m.id, features: m.risk.features, predicted: m.risk.score, label });
    }
  }
  return rows;
}

export function exportOutcomesCsv() {
  const names = featureNames();
  const lines = [["milestone_id", ...names, "predicted_risk", "label"].join(",")];
  for (const r of labelledOutcomes()) lines.push([r.milestoneId, ...names.map((n) => r.features[n] ?? ""), r.predicted, r.label].join(","));
  return lines.join("\n") + "\n";
}

/** Predicted vs actual, in risk bands — the honest way to see whether the model is any good yet. */
export function calibrationReport() {
  const rows = labelledOutcomes();
  const bands = [[0, 0.2], [0.2, 0.4], [0.4, 1.01]] as const;
  const byBand = bands.map(([lo, hi]) => {
    const inBand = rows.filter((r) => r.predicted >= lo && r.predicted < hi);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    return {
      band: `${Math.round(lo * 100)}–${Math.min(100, Math.round(hi * 100))}%`,
      count: inBand.length,
      predictedAvg: avg(inBand.map((r) => r.predicted)),
      actualRate: avg(inBand.map((r) => r.label)),
    };
  });
  const brier = rows.length ? rows.reduce((s, r) => s + (r.predicted - r.label) ** 2, 0) / rows.length : null;
  return {
    outcomes: rows.length,
    brierScore: brier,
    bands: byBand,
    note: rows.length < 200
      ? `Only ${rows.length} real outcomes so far. The model is still the synthetic-data v1; retrain with ml/train.py --real once there are a few hundred.`
      : "Enough data to retrain: python3 ml/train.py --real outcomes.csv",
  };
}
