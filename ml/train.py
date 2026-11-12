"""
Trains ProofPay's release-risk model: P(milestone ends in dispute / non-delivery | features at release time).

Cold-start note (be honest in the pitch): there is no public dataset of escrow outcomes, so v1 is trained on a
SYNTHETIC dataset whose generative process encodes published freelance-platform patterns (first-time pairs and
subjective deliverables dispute more; repeated resubmissions and rushed submissions are red flags). The service
logs every real outcome (see /api/ml/export), so the same script retrains on real data once it exists.

We ship logistic regression (not the stronger GBM) on purpose: every money-moving decision must be explainable,
and per-feature contributions (coef * standardized value) are shown to users as the "why" behind a hold.

Run:  python3 ml/train.py                       -> synthetic prior, writes src/ml/model.json
      python3 ml/train.py --real outcomes.csv   -> blends real outcomes from GET /api/ml/export
"""
import json, math, os, sys
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import train_test_split
from sklearn.metrics import roc_auc_score, brier_score_loss

FEATURES = [
    ("log_amount_usd", "Milestone size"),
    ("days_to_deadline", "Time left before deadline"),
    ("log_freelancer_completed", "Freelancer's completed milestones"),
    ("freelancer_dispute_rate", "Freelancer's dispute rate"),
    ("first_engagement", "First job between these parties"),
    ("resubmissions", "Number of resubmissions"),
    ("verifier_confidence", "Verifier confidence"),
    ("criteria_pass_ratio", "Share of criteria passed"),
    ("log_hours_fund_to_submit", "Time from funding to submission"),
    ("subjective_criteria_ratio", "Share of subjective (AI-judged) criteria"),
    ("late_submission", "Submitted after due date"),
]

def synth(n, rng):
    amount = np.exp(rng.normal(5.6, 1.0, n))                      # ~$270 median, long tail
    days = np.clip(rng.gamma(2.0, 6.0, n), 0, 90)
    completed = rng.negative_binomial(1, 0.15, n)                  # many newcomers
    disputes = rng.binomial(completed + 1, 0.06)
    dispute_rate = disputes / (completed + disputes + 1)
    first = (rng.random(n) < 0.55).astype(float)
    resub = rng.poisson(0.5, n)
    subjective = rng.choice([0, 0.25, 0.5, 1.0], n, p=[0.35, 0.2, 0.25, 0.2])
    conf = np.clip(rng.beta(8, 2, n) - 0.25 * subjective * rng.random(n), 0.05, 1)
    pass_ratio = np.clip(rng.beta(6, 1.2, n), 0, 1)
    hours = np.exp(rng.normal(3.5, 1.3, n))
    late = (rng.random(n) < 0.18).astype(float)

    logit = (
        -2.4
        + 0.35 * (np.log1p(amount) - 5.6)
        - 0.012 * days
        - 0.45 * np.log1p(completed)
        + 4.0 * dispute_rate
        + 0.55 * first
        + 0.42 * resub
        - 2.6 * (conf - 0.75)
        - 3.2 * (pass_ratio - 0.85)
        - 0.22 * (np.log1p(hours) - 3.5)
        + 1.1 * subjective
        + 0.6 * late
        + 0.5 * first * subjective                                    # interaction: new pair + vague deliverable
        + rng.normal(0, 0.35, n)                                      # unobserved factors
    )
    y = (rng.random(n) < 1 / (1 + np.exp(-logit))).astype(int)
    X = np.column_stack([np.log1p(amount), days, np.log1p(completed), dispute_rate, first, resub,
                         conf, pass_ratio, np.log1p(hours), subjective, late])
    return X, y

def load_real(path):
    """Rows exported from GET /api/ml/export (features logged at decision time + label)."""
    import csv
    names = [f for f, _ in FEATURES]
    X, y = [], []
    with open(path) as fh:
        for row in csv.DictReader(fh):
            try:
                X.append([float(row[n]) for n in names])
                y.append(int(row["label"]))
            except (KeyError, ValueError):
                continue
    return np.array(X), np.array(y)

def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--real", help="CSV from /api/ml/export; real outcomes are blended with the synthetic prior")
    ap.add_argument("--real-weight", type=float, default=20.0,
                    help="how much one real outcome counts relative to one synthetic row (default 20)")
    args = ap.parse_args()

    rng = np.random.default_rng(42)
    X, y = synth(40_000, rng)
    w = np.ones(len(y))
    source = "synthetic-v1 (see ml/train.py)"
    if args.real:
        Xr, yr = load_real(args.real)
        if len(yr) == 0:
            print("no usable rows in", args.real); return 1
        # Real data starts as a strong correction to the prior and takes over as it grows.
        X = np.vstack([X, Xr]); y = np.concatenate([y, yr]); w = np.concatenate([w, np.full(len(yr), args.real_weight)])
        source = f"synthetic-v1 + {len(yr)} real outcomes (weight {args.real_weight})"
        print(f"blending {len(yr)} real outcomes ({yr.mean():.0%} bad)")
    Xtr, Xte, ytr, yte, wtr, _ = train_test_split(X, y, w, test_size=0.25, random_state=7, stratify=y)
    scaler = StandardScaler().fit(Xtr)
    lr = LogisticRegression(C=1.0, max_iter=2000).fit(scaler.transform(Xtr), ytr, sample_weight=wtr)
    p = lr.predict_proba(scaler.transform(Xte))[:, 1]
    gbm = GradientBoostingClassifier(random_state=0).fit(Xtr, ytr, sample_weight=wtr)
    pg = gbm.predict_proba(Xte)[:, 1]

    metrics = {
        "positive_rate": round(float(y.mean()), 4),
        "logreg_auc": round(float(roc_auc_score(yte, p)), 4),
        "logreg_brier": round(float(brier_score_loss(yte, p)), 4),
        "gbm_auc_baseline": round(float(roc_auc_score(yte, pg)), 4),
        "n_train": int(len(ytr)), "n_test": int(len(yte)),
    }
    model = {
        "version": "risk-lr-1.1.0" if args.real else "risk-lr-1.0.0",
        "trained_on": source,
        "features": [f for f, _ in FEATURES],
        "labels": {f: l for f, l in FEATURES},
        "mean": scaler.mean_.round(6).tolist(),
        "scale": scaler.scale_.round(6).tolist(),
        "coef": lr.coef_[0].round(6).tolist(),
        "intercept": round(float(lr.intercept_[0]), 6),
        "metrics": metrics,
    }
    out = os.path.join(os.path.dirname(__file__), "..", "src", "ml", "model.json")
    with open(out, "w") as f:
        json.dump(model, f, indent=2)
    print(json.dumps(metrics, indent=2))
    for (name, _), c in sorted(zip(FEATURES, lr.coef_[0]), key=lambda t: -abs(t[1])):
        print(f"  {name:28s} {c:+.3f}")
    print("wrote", os.path.normpath(out))

if __name__ == "__main__":
    sys.exit(main())
