# From hackathon build to production

ProofPay runs end to end on PayPal's sandbox today. This page lists what a real launch needs, which
parts are already built, and the exact PayPal products for the rest.

## 1. Money flow: PayPal's marketplace product instead of capture-then-payout

**Today:** the client's PayPal order is authorized (held), captured into the platform's PayPal account
on release, and the freelancer's share is sent with Payouts. This works with any PayPal business
account, which is why the hackathon build uses it.

**The catch:** for a moment the platform holds customer money, which in most countries means
money-transmitter or escrow licensing.

**Production path — PayPal Multiparty with delayed disbursement.** The money goes straight to the
freelancer's PayPal account but is held by PayPal until the platform releases it, and the platform fee
is split out automatically. It needs approved-partner status, and freelancers onboarded with the
`DELAY_FUNDS_DISBURSEMENT` (and `PARTNER_FEE`) features, so it isn't available to hackathon entrants.

Order (intent `CAPTURE`), sent with `PayPal-Auth-Assertion` and `PayPal-Partner-Attribution-Id` headers:

```json
{
  "intent": "CAPTURE",
  "purchase_units": [{
    "amount": { "currency_code": "USD", "value": "400.00" },
    "payee": { "email_address": "freelancer@example.com" },
    "payment_instruction": {
      "disbursement_mode": "DELAYED",
      "platform_fees": [{ "amount": { "currency_code": "USD", "value": "8.00" } }]
    }
  }]
}
```

Release after verification:

```
POST /v1/payments/referenced-payouts-items
{ "reference_id": "<capture id>", "reference_type": "TRANSACTION_ID" }
```

**Trade-offs to design for:**
- The client is charged at funding (capture), not at release, so a cancellation becomes a refund
  instead of a void.
- PayPal releases delayed funds automatically after 28 days, so the same "fund close to the start"
  rule ProofPay already enforces for 29-day authorizations still applies.

The `PayPalGateway` interface (`src/paypal/gateway.ts`) is the seam: a `MultipartyGateway` implements
fund / release / refund with these calls, and the escrow state machine doesn't change.

## 2. Chargebacks after release — built

A buyer can still dispute a captured payment with PayPal. ProofPay:
- subscribes to `CUSTOMER.DISPUTE.*` webhooks;
- matches the dispute to the milestone through the capture id;
- sends the verification record to PayPal with the Disputes API (`provide-evidence`,
  `PROOF_OF_FULFILLMENT`), including a link to a signed public delivery receipt.

Also built: **risk-priced payout timing.** After capture, the freelancer's payout waits according to the ML
risk band (instant / 48 hours / 7 days, configurable), a client's approval lowers the band by one, and a PayPal
dispute opened in that window pauses the payout until a reviewer settles it.

What production adds:
- **Tuning the delays on real dispute data** (PayPal's dispute window is much longer than 7 days; the delay covers
  the period when most service disputes arrive, not all of them).
- **A human workflow for disputes PayPal escalates to a claim.**

## 3. Identity and access — built, with known limits

- Per-escrow, per-role secret keys (only hashes are stored).
- Agent keys that carry restrictions.
- An admin key for reviewers.
- For agent-created escrows, the client's key is handed over when the person approves the PayPal hold.

What production adds:
- **Real accounts** (email or passkey login) so a person can see all their escrows on any device.
- **KYC for freelancers.** PayPal does this for the PayPal account itself; the platform links a ProofPay
  account to it with Log in with PayPal.
- **Key rotation and revocation.**

Residual risk to know about: on agent-created escrows, an agent watching the PayPal return URL could, in
theory, claim the client key before the person's browser does. Binding the claim to the approving
browser (a cookie set before redirecting to PayPal) closes this.

## 4. Scale and reliability

- **Locking:** one money operation per milestone at a time, using an in-process lock plus PayPal idempotency
  keys. Running more than one instance needs a database row lock (`SELECT … FOR UPDATE` on Postgres) or an
  advisory lock instead.
- **Database:** SQLite is fine for a single instance with a persistent disk. Use Postgres for anything larger.
- **The hold-expiry sweep** runs every 15 minutes in-process. With several instances, run it as a
  scheduled job.
- **Webhooks:** retries are safe because handlers are idempotent; add a dead-letter log for failures.

## 5. Verification coverage

| Deliverable | Built | Next |
|---|---|---|
| Code | PR merged, files touched, CI checks green | Coverage thresholds, specific test names |
| Websites / APIs | URL live, page contains text (SSRF-safe) | Lighthouse score, API contract tests |
| Documents | AI review with injection defences | PDF / DOCX parsing |
| Design | AI review of a description | Figma API (frames exist, last edited), image review |
| Physical services | — | Photo evidence + client confirmation; these stay human-approved |

## 6. The risk model

v1 is trained on synthetic data (documented in `ml/train.py`). Every decision logs its feature vector,
so once real milestones settle:

```bash
curl -H "Authorization: Bearer $ADMIN_KEY" https://<host>/api/ml/export > outcomes.csv
python3 ml/train.py --real outcomes.csv     # blends real outcomes with the synthetic prior
curl -H "Authorization: Bearer $ADMIN_KEY" https://<host>/api/ml/calibration  # predicted vs actual
```

Don't let the model make stricter decisions than the deterministic checks until calibration on a few
hundred real outcomes looks good.

## 7. Currencies and India

PayPal limits INR and how India-registered accounts receive money. Cross-border pairs (an Indian
freelancer and a US client, say) should transact in USD; the freelancer's PayPal account handles
conversion and withdrawal under PayPal India's rules. Check PayPal India's current terms before
promising anything specific.

## 8. Portable proof of delivery

Built: Ed25519 attestations (compact JWS, `alg: EdDSA`) with a public JWKS, browser-side verification, salted
email hashes, a shareable track record, and a live status endpoint (disputed / revoked).

What production adds:
- **Key rotation:** publish old and new keys together in the JWKS for a transition period; `kid` already
  identifies the signing key. Keep the signing key in a KMS rather than an environment variable.
- **Standards:** issue the same claims as a W3C Verifiable Credential so they work with existing wallets.
- **Revocation list:** today status is looked up per attestation; a signed status list scales better.
