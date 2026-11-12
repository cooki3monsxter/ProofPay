import { test } from "node:test";
import assert from "node:assert/strict";

// A copied .env.example with blank lines must behave like "not set", not like 0.
process.env.PORT = "";
process.env.AUTO_RELEASE_MAX_RISK = "   ";
process.env.PAYOUT_DELAY_MEDIUM_HOURS = "";
process.env.PUBLIC_BASE_URL = "";
delete process.env.RENDER_EXTERNAL_URL;
const { config } = await import("../src/config.js");

test("blank .env values fall back to defaults", () => {
  assert.equal(config.port, 8080);
  assert.equal(config.policy.autoReleaseMaxRisk, 0.35);
  assert.equal(config.payoutDelay.mediumHours, 48);
  assert.equal(config.publicBaseUrl, "http://localhost:8080", "PayPal return URLs must never be relative");
});
