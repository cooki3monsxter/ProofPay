# Submission checklist — deadline Nov 12, 2026, 12:00 PM PT (Nov 13, 12:30 AM IST)

Aim to submit by **Nov 12, 9:00 PM IST** to leave buffer.

## Nov 7 — make it real
- [ ] Create PayPal sandbox app (Merchant), enable Payouts, put keys in `.env`
- [ ] Run the full flow against the sandbox: fund → approve with sandbox personal account → submit → capture → payout
- [ ] Add `ANTHROPIC_API_KEY`, re-run the sample scope, check plan quality
- [ ] Push to a **public** GitHub repo; confirm the MIT license shows in the About section

## Nov 8 — deploy
- [ ] Render Blueprint deploy (Free plan only); set env vars including `GITHUB_TOKEN` and `ATTESTATION_PRIVATE_KEY`;
      open the hosted URL and run the flow
- [ ] Free uptime monitor (e.g. UptimeRobot, 5 min) on `<render url>/api/health` so the demo doesn't sleep and lose data
- [ ] Configure the PayPal webhook to `<render url>/api/webhooks/paypal` (include `CUSTOMER.DISPUTE.*`), set `PAYPAL_WEBHOOK_ID`
- [ ] Copy the generated `ADMIN_KEY` from Render for the reviewer view and the Devpost testing notes
- [ ] Open a dispute from the sandbox buyer account on a released milestone; confirm evidence was sent (Ledger: DISPUTE_EVIDENCE_SENT)
- [ ] Connect Claude Desktop to the MCP server and run the bakery prompt; check the client link arrives after approving the hold

- [ ] `npm run keygen` → set `ATTESTATION_PRIVATE_KEY` on Render so proofs stay verifiable across redeploys
- [ ] GitHub webhook on a test repo → `<render url>/api/webhooks/github` (Pull requests, Check suites, Check runs),
      set `GITHUB_WEBHOOK_SECRET`; submit an open PR as proof, merge it, check the milestone releases
- [ ] Run `npm run demo:agents -- --url <render url>` once against the hosted app

## Nov 8–10 — real users (Potential Impact)
- [ ] Run 5–10 short sessions with `docs/USER_TESTING.md`
- [ ] Put the real results (with permission) where the `IMPACT EVIDENCE` comment is in `docs/DEVPOST.md`

## Nov 9 — APIMatic
- [ ] `npx @apimatic/cli auth login`
- [ ] `npm run apimatic:validate`, generate the Java and TypeScript SDKs, generate the portal
- [ ] Try the MCP Server Generator in the APIMatic dashboard with the same spec
- [ ] Take screenshots for the video and README

## Nov 10 — polish
- [ ] Prepare a real merged PR in your own repo to use in the video
- [ ] Pre-seed one completed escrow on the hosted app
- [ ] Re-read the README as a judge: can they run it in two minutes?

## Nov 11 — video
- [ ] Record following `docs/VIDEO_SCRIPT.md`, keep it under 3:00
- [ ] Upload to YouTube as Public

## Nov 12 — submit
- [ ] Devpost: text from `docs/DEVPOST.md`, repo URL, video URL, hosted URL, testing instructions with sandbox buyer login
- [ ] Make sure every sponsor tool is named in the description and visible in the video: APIMatic (portal/SDK),
      AG Grid (risk desk), Bryntum (timeline), Render (hosted URL). Each one makes you eligible for its prize.
- [ ] If the form asks which prizes to consider, tick all that apply: Grand, Most Creative, Most Impactful, Best Demo,
      Best Use of PayPal + AI, Best Use of Agentic Commerce, AG Grid, APIMatic, Bryntum, Render
- [ ] Submit (not just save as draft) and confirm the submission email
