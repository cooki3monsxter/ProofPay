import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Milestone, RiskAssessment, Verdict } from "../types.js";

type Model = {
  version: string; features: string[]; labels: Record<string, string>;
  mean: number[]; scale: number[]; coef: number[]; intercept: number; metrics: Record<string, number>;
};

const here = dirname(fileURLToPath(import.meta.url));
// model.json lives in src/ml; after `tsc` we also look one level up so dist/ can find it
const candidates = [join(here, "model.json"), join(here, "..", "..", "src", "ml", "model.json")];
const model: Model = JSON.parse(readFileSync(candidates.find((p) => { try { readFileSync(p); return true; } catch { return false; } })!, "utf8"));

// Rough FX for feature scaling only (never used for money movement).
const TO_USD: Record<string, number> = { USD: 1, EUR: 1.08, GBP: 1.27, INR: 0.012, AUD: 0.66, CAD: 0.73 };

export interface RiskInputs {
  milestone: Milestone;
  currency: string;
  verdict: Verdict | null;
  freelancerCompleted: number;
  freelancerDisputes: number;
  firstEngagement: boolean;
}

export function featurize(i: RiskInputs): number[] {
  const m = i.milestone;
  const usd = m.amount * (TO_USD[i.currency] ?? 1);
  const now = Date.now();
  const due = m.dueDate ? Date.parse(m.dueDate) : NaN;
  const daysLeft = Number.isFinite(due) ? Math.max(0, (due - now) / 86_400_000) : 14;
  const funded = m.fundedAt ? Date.parse(m.fundedAt) : now;
  const submitted = m.submittedAt ? Date.parse(m.submittedAt) : now;
  const hours = Math.max(0, (submitted - funded) / 3_600_000);
  const v = i.verdict;
  const passRatio = v && v.results.length ? v.results.filter((r) => r.passed).length / v.results.length : 0;
  const subjective = m.criteria.length ? m.criteria.filter((c) => c.type === "ai_judgment").length / m.criteria.length : 0;
  const total = i.freelancerCompleted + i.freelancerDisputes;
  return [
    Math.log1p(usd),
    Math.min(90, daysLeft),
    Math.log1p(i.freelancerCompleted),
    i.freelancerDisputes / (total + 1),
    i.firstEngagement ? 1 : 0,
    m.resubmissions,
    v?.confidence ?? 0.5,
    passRatio,
    Math.log1p(hours),
    subjective,
    Number.isFinite(due) && submitted > due ? 1 : 0,
  ];
}

export function scoreRisk(i: RiskInputs): RiskAssessment {
  const x = featurize(i);
  const contrib = x.map((v, k) => model.coef[k] * ((v - model.mean[k]) / model.scale[k]));
  const z = model.intercept + contrib.reduce((a, b) => a + b, 0);
  const score = 1 / (1 + Math.exp(-z));
  const reasons = contrib
    .map((impact, k) => ({ feature: model.features[k], impact: Number(impact.toFixed(3)), label: model.labels[model.features[k]] }))
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .slice(0, 4);
  return {
    score: Number(score.toFixed(4)),
    band: score < 0.2 ? "low" : score < 0.4 ? "medium" : "high",
    reasons,
    modelVersion: model.version,
    features: Object.fromEntries(model.features.map((f, k) => [f, Number(x[k].toFixed(4))])),
  };
}

export const featureNames = () => [...model.features];
export const modelInfo = () => ({ version: model.version, features: model.labels, metrics: model.metrics });
