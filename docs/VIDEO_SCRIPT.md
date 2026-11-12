# Demo video script — target 2:55 (hard limit: under 3:00)

Record at 1440×900 or larger, browser zoom 110%. Use the **real PayPal sandbox and Claude** (set keys), so judges
see real PayPal pages. No music unless it's royalty-free and licensed. Upload to YouTube as **Public**.

Before recording:
- Pre-create one completed escrow so the sidebar and risk desk aren't empty.
- Prepare a pull request in your own repo that is **open, not merged** (for the merge-to-pay beat), with the
  GitHub webhook pointing at your Render URL.
- Have a second browser window (or incognito) ready for "the next client" in the proof beat.

| Time | Screen | Voice-over |
|---|---|---|
| 0:00–0:15 | Home page | "Half of freelancers have trouble getting paid in a single year. Clients get burned too. And now AI agents are buying work. ProofPay has one rule: money moves only when the work is real." |
| 0:15–0:30 | New escrow → paste scope → Draft milestones | "Asha hires a developer. She pastes the scope; Claude turns it into milestones a machine can check — a merged pull request, a live page, a reviewed document." |
| 0:30–0:45 | Create → Fund → **real PayPal sandbox approval** → back | "She funds milestone one. It's a PayPal authorization: the money is held, not charged." |
| 0:45–1:05 | Freelancer submits the **open** PR → "Waiting for merge" → switch to GitHub, click **Merge** → back: paid | "The developer submits his pull request before it's even merged. Asha merges it on GitHub — and that's the release button. ProofPay re-checks GitHub, PayPal captures, Payouts pays him." |
| 1:05–1:20 | Client view of a delivered milestone: only **Release / Request changes / Open dispute** — no cancel. Optional: Postman call to `/refund` returning `FREELANCER_PROTECTED` | "Escrow has to protect both sides. Once work is delivered, the client can't quietly cancel — even through the API. If the freelancer misses the deadline, the client gets the hold back and is never charged." |
| 1:20–1:35 | Milestone with a document → held → risk panel → client releases → "Payout scheduled" | "Subjective work is different. The ML model holds it for Asha, and even after she approves, it prices the payout: a first job between strangers is paid in two days, so a late PayPal dispute can't leave anyone out of pocket." |
| 1:35–2:00 | Freelancer view → **Copy track record link** → open in the second browser → verified count → type email → ✓ | "Here's what's new. Every payment ProofPay releases leaves a signed proof of delivery — and it belongs to the freelancer. His next client opens one link and checks it against a public key, without trusting us. It doesn't even show his email until he says who he is." |
| 2:00–2:25 | Terminal: `npm run demo:agents` | "And it works between agents. A buyer agent hires, a seller agent delivers. Neither can approve a PayPal payment, and when the buyer agent tries to push a held payment through, ProofPay refuses. The rules live in the server and the keys — not the prompt." |
| 2:25–2:38 | Released milestone → Simulate PayPal chargeback → evidence sent; Timeline tab (Bryntum) | "If a buyer disputes with PayPal later, ProofPay answers with the signed record. And the timeline shows every deadline against its 29-day PayPal hold." |
| 2:38–2:48 | Reviewer risk desk (AG Grid) → APIMatic portal | "Reviewers see every escrow by risk, and APIMatic turns the API into SDKs and a developer portal so any marketplace can add pay-on-proof." |
| 2:48–2:55 | Home page | "ProofPay. Pay on proof, not on promises. Built on PayPal." |

Tips: cut every loading wait. Say "PayPal" each time money moves. The proof beat (1:35–2:00) is the most
original part — don't rush it.
