# Devpost submission text (copy into the form)

**Name:** ProofPay

**Tagline:** Pay on proof, not on promises. PayPal escrow that releases money the moment work is verified — and leaves the freelancer with proof anyone can check.

## Inspiration

In a widely cited Freelancers Union survey of 5,358 freelancers, half had trouble collecting payment in a
single year, and those who went unpaid lost about $5,968 on average — roughly 13% of their income. Clients
carry the mirror-image risk. The pain is worst across borders: a developer in India billing a client in the US
has almost no recourse either way.

The standard answer is a marketplace that holds the money, but that bundles escrow with the marketplace's fees
and rules, and the freelancer's reputation stays locked inside it. Meanwhile AI agents are starting to buy
services, and nobody wants an agent that pays before the work exists. We wanted "money moves only when the
work is real" to be enforced by software — and for every payment to leave behind proof the freelancer keeps.

<!-- IMPACT EVIDENCE: replace this comment with what real testers told you, e.g.
"We asked N freelancers and clients to try the sandbox flow. X said they'd use it for their next client."
Use only real responses, quoted with permission. Delete this comment if you have none. -->

## What it does

1. **Agree.** Paste a scope of work. Claude turns it into milestones with amounts, deadlines and
   machine-checkable acceptance criteria (PR merged, URL live, page contains text, or AI-reviewed).
2. **Hold.** The client approves a PayPal order with intent AUTHORIZE. Funds are reserved, not charged.
3. **Prove.** The freelancer submits a GitHub PR, a live URL or a document.
4. **Check.** ProofPay verifies each criterion: GitHub API for merged PRs and touched paths, live HTTP checks
   with SSRF protection, and Claude as a strict judge for subjective work, hardened against prompt injection.
5. **Score.** An explainable ML model estimates the risk of releasing (dispute or non-delivery) and shows
   the top factors.
6. **Pay or hold.** If every check passes with high confidence and the risk is low, ProofPay captures the
   authorization and pays the freelancer with PayPal Payouts. Otherwise the money waits for the client.
   Cancelling voids the hold, so the client is never charged.
7. **Dispute.** Freeze a milestone; Claude writes a neutral evidence brief for a human reviewer.

8. **Prove it anywhere.** Every released milestone gets an Ed25519-signed attestation (a standard JWS). The
   public key is published, so anyone can verify it without trusting ProofPay — in the browser, with any JOSE
   library, or as PayPal dispute evidence. The freelancer shares their whole record as one link; it names no
   one, and a viewer can confirm "is this you?" by typing an email that's hashed and compared in their browser.
9. **Merge to pay.** Freelancers can submit a pull request before it's merged. When the maintainer merges it,
   GitHub's webhook triggers verification and PayPal captures the hold.
10. **Pay at the right time.** The ML risk score sets when the freelancer's payout goes out: instantly for low
   risk, after two to seven days otherwise. A PayPal dispute opened in that window pauses the payout.
11. **Defend.** If the buyer later disputes the payment with PayPal, ProofPay matches the dispute to the
   milestone and answers it through PayPal's Disputes API with the verification record and a signed,
   public delivery receipt.

Escrow has to protect both sides, so the rules are symmetric: once the freelancer submits work, the client
can't quietly cancel — they request changes or open a dispute. The client can cancel only before funding or
after a missed deadline, and the freelancer can always give the money back.

**What's different from existing escrow and bounty tools:** marketplaces hold money but keep the reputation;
bounty platforms already pay on merge (Algora: 11% fee, 3–8 day payouts) but only for code. ProofPay works for any
deliverable on PayPal's rails, takes 2%, pays low-risk work instantly, prices payout timing with ML, and gives the
freelancer cryptographic proof they own.

Everything is also available to AI agents through an MCP server. Agents get their own **agent keys**, so the
server knows it's talking to an agent even if the agent calls the REST API directly. An agent can create the
escrow, request funding and submit work. But a person approves every PayPal hold, and the server refuses any
attempt by an agent to override a held payment, refund or resolve a dispute. When an agent creates an escrow it
never sees the person's key: the person gets their dashboard link by approving the hold with their own PayPal login.
`npm run demo:agents` runs a whole job between a buyer agent and a seller agent, each with its own key.

## How we built it

- **PayPal:** Orders v2 (intent AUTHORIZE), Payments v2 (authorize, capture, void, reauthorize after the
  3-day honor period), Payouts v1 for the freelancer's share, the Disputes API (get dispute, provide evidence),
  webhook signature verification, and `PayPal-Request-Id` idempotency on every write. ProofPay respects the
  29-day authorization limit: it refuses to fund work due later and warns before a hold expires.
- **AI:** Claude with forced tool calls for structured output (plan extraction, deliverable verdicts,
  dispute briefs). Every AI path has a deterministic fallback whose confidence is capped so a person confirms.
- **ML:** a logistic-regression release-risk model (scikit-learn), exported to JSON and scored natively in the
  API with per-feature explanations. Chosen over gradient boosting because money decisions must be explainable,
  at equal accuracy (AUC 0.785 vs 0.780). The score decides both whether to auto-release and when to pay out.
- **Cryptography:** Ed25519 attestations as compact JWS with a public JWKS; browser-side verification with
  WebCrypto; salted email hashes so records are shareable without exposing anyone.
- **GitHub:** signed repository webhooks (pull requests, check suites) re-trigger verification; checks read
  merge state and CI results from the GitHub API.
- **APIMatic:** ProofPay's API is one OpenAPI 3 spec; APIMatic generates SDKs (Java, TypeScript, Python), a
  developer portal and a context plugin from it. A test fails if the spec and the server drift.
- **MCP:** a Streamable HTTP endpoint on the server and a stdio server for Claude Desktop and Cursor.
- **AG Grid:** a reviewers' risk desk across every escrow (risk bars, days left on each PayPal hold, dispute
  highlighting, quick search, CSV) and the audit ledger of every money movement.
- **Bryntum Gantt:** a timeline of each milestone's working time against its 29-day PayPal hold window, so a
  client can see whether the money will still be held when the work is due.
- **Render:** a one-click Blueprint on the Free plan, with a health check and a generated reviewer key.
- **Postman & Zapier:** a Postman collection generated from the spec, and signed event webhooks for Zapier.
- **Security:** per-escrow, per-role access keys stored as hashes; SSRF-safe URL checks; evidence fenced as
  untrusted in every prompt; one money operation per milestone at a time.
- Stack: TypeScript, Express, Zod, SQLite (`node:sqlite`), vanilla JS front end. 34 automated tests plus
  10 live LLM evals covering prompt injection, partial deliverables and dispute-brief neutrality.

## Challenges we ran into

- Designing a state machine where money can never be captured twice, captured after a void, or released by
  the wrong party — and making webhooks and browser redirects idempotent when they race.
- Making AI verification trustworthy enough to move money: confidence thresholds, structured output, treating
  evidence as untrusted input, and always routing uncertainty to a person.
- No public data on escrow outcomes. We trained v1 on a documented synthetic process and built outcome
  logging so the model can be retrained on real data.
- Making proof portable without making people public: attestations carry hashes, not emails, and identity is
  confirmed only when the freelancer chooses to tell a verifier their email.

## Accomplishments we're proud of

- A complete loop from a plain-language scope to a real PayPal capture and payout, in one flow.
- Guardrails for agentic payments that live in the server, not in a prompt.
- Proof that outlives the platform: a freelancer's record stays verifiable with nothing but a public key.
- Every automated decision is explained: which criteria passed, how confident the verifier was, and
  which factors drove the risk score.

## What we learned

Authorizations are the right primitive for escrow-style flows: they make "held, not charged" real for the
client, and void gives a clean cancel. And for AI that touches money, the design question isn't "can the model
decide?" but "when must it hand off to a person?"

## What's next

Moving the money flow to PayPal Multiparty with delayed disbursement, so funds sit in the freelancer's own PayPal
account until release (it needs approved-partner status; the design is in docs/PRODUCTION.md). After that:
user accounts with Log in with PayPal, attestations in the W3C Verifiable Credentials format so they plug into
existing wallets, more verifiers (Figma, app store builds), and retraining the risk model on real outcomes — the
export and retraining pipeline is already built.

## Built with

paypal-orders-api, paypal-payouts-api, paypal-disputes-api, paypal-webhooks, claude, anthropic, scikit-learn, ed25519, jws, webcrypto, apimatic,
ag-grid, bryntum, render, postman, zapier, model-context-protocol, typescript, node.js, express, sqlite, github-api

## Testing instructions (paste into the "testing" field)

- Hosted demo: `<your Render URL>` (PayPal sandbox). It runs on Render's free plan: the first visit can take about
  a minute to wake the server, and data resets when the server restarts — creating a new escrow takes 30 seconds.
- Local: `npm install && npm run dev`, then open http://localhost:8080. No keys needed — the PayPal simulator
  and rules fallback are used. Add sandbox keys from `.env.example` to use the real PayPal sandbox.
- Sandbox buyer login for approving holds: `<sandbox personal account email>` / `<password>`.
- Reviewer key for resolving disputes on the hosted demo: `<ADMIN_KEY>`.
- In simulator mode, a released milestone has a **Simulate a PayPal chargeback** button that shows the
  dispute defence end to end.
- Two agents running a whole job: `npm run demo:agents` (with the server running).
- Check a proof of delivery: open any released milestone's **Signed proof of delivery** link, or `/verify`.
- Tests: `npm test`.
