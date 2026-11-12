// Central configuration. Every external integration has a safe "demo" fallback so the
// app always runs end-to-end, and switches to the real service as soon as keys are present.

// An empty value (e.g. "PORT=" left blank in .env) means "use the default", never 0 or "".
const env = (k: string, d = "") => process.env[k]?.trim() || d;

export const config = {
  port: Number(env("PORT", "8080")),
  // Render sets RENDER_EXTERNAL_URL automatically, so redirects work without extra config there.
  publicBaseUrl: env("PUBLIC_BASE_URL", env("RENDER_EXTERNAL_URL", `http://localhost:${env("PORT", "8080")}`)).replace(/\/$/, ""),
  dbPath: env("DB_PATH", "./data/proofpay.db"),

  paypal: {
    clientId: env("PAYPAL_CLIENT_ID"),
    clientSecret: env("PAYPAL_CLIENT_SECRET"),
    baseUrl: env("PAYPAL_BASE_URL", "https://api-m.sandbox.paypal.com"),
    webhookId: env("PAYPAL_WEBHOOK_ID"),
    // Platform fee kept by ProofPay when a milestone is released (percentage).
    platformFeePct: Number(env("PLATFORM_FEE_PCT", "2")),
    // When a buyer opens a PayPal dispute on a released milestone, send the verification record
    // to PayPal as evidence automatically.
    autoDisputeEvidence: env("AUTO_DISPUTE_EVIDENCE", "true") !== "false",
  },

  ai: {
    anthropicKey: env("ANTHROPIC_API_KEY"),
    model: env("ANTHROPIC_MODEL", "claude-sonnet-5-5"),
    // Deliberately not ANTHROPIC_BASE_URL: tools like Claude Code set that for themselves.
    apiUrl: env("PROOFPAY_ANTHROPIC_URL", "https://api.anthropic.com"),
  },


  /** Platform reviewer key. Generated and stored on first start if not set. */
  adminKey: env("ADMIN_KEY"),

  /**
   * Risk-priced payout timing. After capture, the freelancer's payout waits according to the ML
   * risk band, so the platform isn't out of pocket if a buyer disputes the payment with PayPal.
   * A client's explicit approval lowers the band by one.
   */
  payoutDelay: {
    mediumHours: Number(env("PAYOUT_DELAY_MEDIUM_HOURS", "48")),
    highHours: Number(env("PAYOUT_DELAY_HIGH_HOURS", "168")),
  },

  github: { token: env("GITHUB_TOKEN"), webhookSecret: env("GITHUB_WEBHOOK_SECRET") },

  policy: {
    // ML risk at or above this needs a human before money moves.
    autoReleaseMaxRisk: Number(env("AUTO_RELEASE_MAX_RISK", "0.35")),
    // Verifier confidence below this needs a human.
    minVerifierConfidence: Number(env("MIN_VERIFIER_CONFIDENCE", "0.7")),
  },
};

export const paypalMode = () =>
  config.paypal.clientId && config.paypal.clientSecret ? "sandbox" : "demo";
export const aiMode = () => (config.ai.anthropicKey ? "claude" : "heuristic");
