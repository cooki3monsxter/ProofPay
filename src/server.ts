import { buildApp } from "./app.js";
import { aiMode, config, paypalMode } from "./config.js";
import { openDb } from "./db.js";
import { getAdminKey } from "./auth.js";
import { processDuePayouts, sweepHolds } from "./services/escrow.js";

openDb();
getAdminKey(); // generates and prints a reviewer key on first start if ADMIN_KEY isn't set
buildApp().listen(config.port, () => {
  console.log(`ProofPay listening on ${config.publicBaseUrl}`);
  console.log(`  PayPal: ${paypalMode()}   AI: ${aiMode()}   MCP: ${config.publicBaseUrl}/mcp`);
  if (paypalMode() === "demo") console.log("  (set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET to use the real PayPal sandbox)");
  if (!process.env.ATTESTATION_PRIVATE_KEY)
    console.log("  Proof-of-delivery signing key is stored in the database. If the database can be reset (e.g. Render free tier),\n  set ATTESTATION_PRIVATE_KEY (npm run keygen) so earlier proofs stay verifiable.");
});

// Warn before PayPal holds expire (29 days) and un-fund milestones whose hold has lapsed.

// Send risk-delayed payouts once they're due.
const sweep = async () => {
  try {
    const r = sweepHolds();
    if (r.expired || r.expiring) console.log(`[holds] ${r.expiring} expiring soon, ${r.expired} expired`);
    const p = await processDuePayouts();
    if (p.sent) console.log(`[payouts] sent ${p.sent} scheduled payout(s)`);
  } catch (e) { console.error("[sweep]", e); }
};
void sweep();
setInterval(sweep, 5 * 60 * 1000).unref();
