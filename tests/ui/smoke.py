"""
Browser smoke test of every screen and role.

  pip install playwright && python -m playwright install chromium   # once
  ADMIN_KEY=<your key> npm run dev                                   # in another terminal
  BASE_URL=http://localhost:8080 ADMIN_KEY=<your key> npm run test:ui

Needs the PayPal simulator (no PayPal keys set). Uses CHROME_PATH if set, otherwise Playwright's Chromium.
"""
import asyncio, os, re, sys
from playwright.async_api import async_playwright
B = os.environ.get("BASE_URL", "http://localhost:8080").rstrip("/")
ADMIN = os.environ.get("ADMIN_KEY", "")
if not ADMIN:
    sys.exit("Set ADMIN_KEY to the server's reviewer key.")
results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))

async def desk_rows(page):
    # unique rendered rows (pinned and centre containers both render each row)
    return len(set(await page.eval_on_selector_all("#desk-grid .ag-row[row-index]", "els => els.map(e => e.getAttribute('row-index'))")))

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=os.environ.get("CHROME_PATH") or None, args=["--no-sandbox"])
        errs = []
        def watch(page, tag):
            page.on("pageerror", lambda e: errs.append(f"{tag} PAGEERROR {e}"))
            page.on("console", lambda m: errs.append(f"{tag} CONSOLE {m.text}") if m.type == "error" and "ERR_TUNNEL" not in m.text and "fonts.g" not in m.text and "Failed to load resource" not in m.text else None)
            page.on("response", lambda r: errs.append(f"{tag} {r.status} {r.url}") if r.status >= 500 or (r.status == 404 and "fonts" not in r.url) else None)
        ctx = await b.new_context(viewport={"width": 1360, "height": 950}, permissions=["clipboard-read", "clipboard-write"])
        pg = await ctx.new_page(); watch(pg, "client")
        async def accept_dialog(text):
            await pg.fill("#ask-text", text); await pg.click("#ask-ok"); await pg.wait_for_timeout(1200)

        # home + new escrow
        await pg.goto(B + "/#/"); await pg.wait_for_timeout(700)
        check("home renders", "Pay for work only when the work is real" in await pg.inner_text("#main"))
        await pg.click("#try-sample"); await pg.wait_for_timeout(400)
        await pg.click("#draft-btn"); await pg.wait_for_timeout(900)
        check("plan drafted (3 milestones)", await pg.locator(".draft-ms").count() == 3)
        await pg.click('[data-add="0"]'); await pg.wait_for_timeout(300)
        check("add criterion", await pg.locator('.draft-ms[data-i="0"] .crit-row').count() == 2)
        await pg.click('.draft-ms[data-i="0"] [data-del="1"]'); await pg.wait_for_timeout(300)
        check("remove criterion", await pg.locator('.draft-ms[data-i="0"] .crit-row').count() == 1)
        await pg.click("#create-btn"); await pg.wait_for_timeout(1500)
        check("escrow created + share link", await pg.locator(".share input").count() == 1)
        flink = await pg.input_value(".share input")
        escrow_id = re.search(r"escrow/(esc_\w+)", pg.url).group(1)

        # fund M1, M2, M3
        for i in range(3):
            btn = (await pg.query_selector_all('[data-act="fund"]'))[0]
            await btn.click(); await pg.wait_for_timeout(900)
            await pg.click("button"); await pg.wait_for_timeout(1300)
        txt = await pg.inner_text("#main")
        flat = re.sub(r"\s+", "", txt)
        check("all 3 milestones held at PayPal", "HeldatPayPal$800.00" in flat and "Notfundedyet$0.00" in flat)
        check("no cancel before deadline (freelancer protected)", "Deadline missed" not in txt)

        # freelancer in separate browser via link
        ctx2 = await b.new_context(viewport={"width": 1360, "height": 950}, permissions=["clipboard-read", "clipboard-write"])
        fp = await ctx2.new_page(); watch(fp, "freelancer")
        await fp.goto(flink); await fp.wait_for_timeout(1500)
        check("freelancer link opens as freelancer", await fp.get_attribute('.role button[aria-checked="true"]', "data-role") == "freelancer")
        forms = await fp.query_selector_all(".proof")
        check("freelancer sees 3 proof forms", len(forms) == 3, str(len(forms)))
        # M3: document → held for review
        await fp.fill('article.ms >> nth=2 >> textarea[name="text"]', "Handover guide. Deployment steps: npm run build then deploy on Render. Environment variables: PAYPAL_CLIENT_ID, DB_PATH. Rollback: redeploy the previous release.")
        await fp.click("article.ms >> nth=2 >> .proof button"); await fp.wait_for_timeout(1600)
        check("document held for client decision", "Needs client decision" in await fp.inner_text("#main"))
        # M2: URL that will fail (private address blocked) → changes requested
        await fp.fill('article.ms >> nth=1 >> input[name="url"]', "http://127.0.0.1:9/")
        await fp.click("article.ms >> nth=1 >> .proof button"); await fp.wait_for_timeout(1600)
        t = await fp.inner_text("#main")
        check("blocked private URL → changes requested", "Changes requested" in t and "private network" in t)

        # client: request changes on M3, then freelancer resubmits, client releases
        await pg.reload(); await pg.wait_for_timeout(1500)
        await pg.click('article.ms >> nth=2 >> [data-act="changes"]'); await pg.wait_for_timeout(300)
        await accept_dialog("Please add a section on backups")
        check("request changes", "Changes requested by client" in await pg.inner_text("#main"))
        await fp.reload(); await fp.wait_for_timeout(1500)
        await fp.fill('article.ms >> nth=2 >> textarea[name="text"]', "Handover guide v2. Deployment steps: npm run build, deploy on Render. Environment variables: PAYPAL_CLIENT_ID, DB_PATH. Rollback: redeploy previous release. Backups: nightly.")
        await fp.click("article.ms >> nth=2 >> .proof button"); await fp.wait_for_timeout(1600)
        await pg.reload(); await pg.wait_for_timeout(1500)
        await pg.click('article.ms >> nth=2 >> [data-act="release"]'); await pg.wait_for_timeout(1700)
        t = await pg.inner_text("#main")
        check("client release → captured, payout scheduled or paid", "Payout scheduled" in t or "Paid to freelancer" in t)
        check("signed proof link shown", await pg.locator(".proof-btn").count() >= 1)
        if await pg.locator('[data-act="retry-payout"]').count():
            await pg.click('[data-act="retry-payout"]'); await pg.wait_for_timeout(1500)
            check("pay now sends the payout", "Paid to freelancer" in await pg.inner_text("#main"))

        # chargeback simulation + receipt
        await pg.click('[data-act="simulate-dispute"]'); await pg.wait_for_timeout(1500)
        check("PayPal chargeback answered", "PayPal dispute" in await pg.inner_text("#main"))
        rhref = await pg.get_attribute('a:has-text("Open delivery receipt")', "href")
        rp = await b.new_page(); watch(rp, "receipt")
        await rp.goto(rhref); await rp.wait_for_timeout(800)
        body = await rp.inner_text("body")
        check("receipt page, no emails", "Agreed criteria" in body and "@" not in body)

        # M1: dispute by client, reviewer resolves refund
        await pg.click('article.ms >> nth=0 >> [data-act="dispute"]'); await pg.wait_for_timeout(300)
        await accept_dialog("Freelancer has gone quiet on milestone 1")
        check("dispute opened with brief", "Dispute brief" in await pg.inner_text("#main"))

        # freelancer track record
        await fp.reload(); await fp.wait_for_timeout(1500)
        await fp.click("#share-record"); await fp.wait_for_timeout(700)
        link = await fp.evaluate("navigator.clipboard.readText()")
        vctx = await b.new_context(viewport={"width": 1100, "height": 950})
        v = await vctx.new_page(); watch(v, "verify")
        await v.goto(link); await v.wait_for_timeout(2500)
        out = await v.inner_text("#out")
        check("verify page: signatures checked in browser", "in your browser" in out)
        check("verify page shows disputed status", "PayPal dispute open" in out)
        await v.fill("#who", "dipesh.dev@example.com"); await v.click("#who-go"); await v.wait_for_timeout(400)
        check("identity check matches", "Yes" in await v.inner_text("#who-out"))
        await v.goto(B + "/verify"); await v.wait_for_timeout(800)
        check("verify page empty state shows paste box", await v.locator("#paste:not([hidden])").count() == 1)

        # tabs: timeline, ledger, agent
        await pg.click('a[href$="/timeline"]'); await pg.wait_for_timeout(5000)
        check("Bryntum timeline renders 3 rows", await pg.locator(".b-grid-row").count() >= 3)
        await pg.click('a[href$="/ledger"]'); await pg.wait_for_timeout(1500)
        check("AG Grid ledger has rows", await pg.locator("#ledger-grid .ag-row").count() >= 10)
        await pg.click('a[href$="/agent"]'); await pg.wait_for_timeout(600)
        await pg.click("#mint"); await pg.wait_for_timeout(800)
        check("agent key minted", "ppca_" in await pg.inner_text("#minted"))

        # reviewer: key prompt, desk, resolve dispute
        await pg.click('[data-role="reviewer"]'); await pg.wait_for_timeout(800)
        await pg.fill("#admin-key", ADMIN); await pg.click("#admin-form button"); await pg.wait_for_timeout(1300)
        check("reviewer opens escrow with admin key", "Where the money is" in await pg.inner_text("#main"))
        await pg.click('a[href$="/milestones"]'); await pg.wait_for_timeout(1200)
        await pg.click('[data-act="resolve-refund"]'); await pg.wait_for_timeout(300)
        await accept_dialog("No delivery after the deadline")
        check("reviewer resolves dispute (refund)", "Refunded by reviewer" in await pg.inner_text("#main"))
        await pg.click('a[href="#/desk"]'); await pg.wait_for_timeout(1500)
        await pg.uncheck("#desk-open"); await pg.wait_for_timeout(500)
        n_all = await desk_rows(pg)
        check("risk desk lists every milestone", n_all >= 3, f"{n_all} rows")
        await pg.fill("#desk-q", "Handover"); await pg.wait_for_timeout(500)
        n_f = await desk_rows(pg)
        check("risk desk search filters", 1 <= n_f < n_all, f"{n_f} of {n_all}")

        # cancel an unfunded milestone in a fresh escrow
        await pg.click('[data-role="client"]'); await pg.goto(B + "/#/new"); await pg.wait_for_timeout(500)
        await pg.fill("#scope", "Logo work\nMilestone 1: Logo - $90, due in 4 days. Acceptance: three logo concepts with colour notes")
        for sel, val in [("#cn", "Asha"), ("#ce", "asha@x.example"), ("#fe", "riya@x.example"), ("#fn", "Riya")]: await pg.fill(sel, val)
        await pg.click("#draft-btn"); await pg.wait_for_timeout(900); await pg.click("#create-btn"); await pg.wait_for_timeout(1300)
        await pg.click('[data-act="refund"]'); await pg.wait_for_timeout(300)
        await accept_dialog("Not needed any more")
        check("cancel unfunded milestone", "Returned to client" in await pg.inner_text("#main"))

        # phone width + dark mode
        for name, url in [("home", B + "/#/"), ("escrow", B + f"/#/escrow/{escrow_id}"), ("verify", link)]:
            mctx = await b.new_context(viewport={"width": 390, "height": 844}, color_scheme="dark")
            m = await mctx.new_page(); watch(m, f"mobile-{name}")
            await m.goto(url); await m.wait_for_timeout(1500)
            sw = await m.evaluate("document.documentElement.scrollWidth")
            check(f"phone width, dark mode: {name} (no sideways scroll)", sw <= 392, f"scrollWidth {sw}")
            await mctx.close()

        await b.close()
        for n, ok, d in results: print(("PASS " if ok else "FAIL ") + n + (f"  [{d}]" if d and not ok else ""))
        print(f"\n{sum(ok for _, ok, _ in results)}/{len(results)} UI checks passed")
        print("page errors / failed requests:", errs if errs else "none")
        if errs or not all(ok for _, ok, _ in results): sys.exit(1)
asyncio.run(main())
