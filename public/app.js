// ProofPay dashboard — dependency-free, hash-routed. AG Grid powers the ledger.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n, c) => `${c === "USD" ? "$" : c === "INR" ? "₹" : c === "EUR" ? "€" : c === "GBP" ? "£" : c + " "}${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ago = (iso) => {
  if (!iso) return "";
  const d = (Date.now() - Date.parse(iso)) / 1000;
  return d < 60 ? "just now" : d < 3600 ? `${Math.floor(d / 60)} min ago` : d < 86400 ? `${Math.floor(d / 3600)} h ago` : new Date(iso).toLocaleDateString();
};

const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
// Access keys this browser holds: { [escrowId]: { client?, freelancer? } }. Keys never leave the browser
// except as the Authorization header to this server.
const keys = {
  all: () => store.get("pp-keys", {}),
  for: (escrowId, role) => (role === "reviewer" ? store.get("pp-admin", null) : keys.all()[escrowId]?.[role] ?? null),
  save(escrowId, role, key) { const a = keys.all(); a[escrowId] = { ...(a[escrowId] || {}), [role]: key }; store.set("pp-keys", a); },
  any: (escrowId) => { const k = keys.all()[escrowId] || {}; return k.client || k.freelancer || store.get("pp-admin", null); },
};

const state = {
  role: store.get("pp-role", "client"),
  health: null,
  draft: null,
  tab: "milestones",
  pollTimer: null,
  lastJson: "",
  grid: null,
  busy: new Set(),
};

// ------------------------------------------------------------------ api
/** escrowId selects which stored key to send (for the current role). */
async function api(method, path, body, escrowId, keyOverride) {
  const headers = { "content-type": "application/json" };
  const key = keyOverride ?? (escrowId ? keys.for(escrowId, state.role) : null);
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.message || `Request failed (${res.status})`), { code: j.error, status: res.status });
  return j;
}

function toast(msg, kind = "") {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = msg;
  $("#toasts").append(t);
  setTimeout(() => t.remove(), kind === "error" ? 7000 : 4000);
}

function ask(title, help, cta) {
  const d = $("#ask");
  $("#ask-title").textContent = title;
  $("#ask-help").textContent = help;
  $("#ask-ok").textContent = cta;
  $("#ask-text").value = "";
  d.showModal();
  return new Promise((resolve) => {
    d.addEventListener("close", () => resolve(d.returnValue === "ok" ? $("#ask-text").value.trim() : null), { once: true });
  });
}

// ------------------------------------------------------------------ chrome
async function loadHealth() {
  try {
    state.health = await api("GET", "/api/health");
    const h = state.health;
    $("#modes").innerHTML = `
      <span class="chip ${h.paypal === "sandbox" ? "live" : "sim"}" title="${h.paypal === "sandbox" ? "Real PayPal sandbox API calls" : "No PayPal keys set — using the built-in simulator"}">PayPal ${h.paypal === "sandbox" ? "sandbox" : "simulator"}</span>
      <span class="chip ${h.ai === "claude" ? "live" : "sim"}" title="${h.ai === "claude" ? "Claude extracts milestones and judges deliverables" : "No ANTHROPIC_API_KEY — deterministic fallback"}">AI: ${h.ai === "claude" ? "Claude" : "rules fallback"}</span>
      <span class="chip" title="Release-risk model">${esc(h.model)}</span>`;
  } catch { /* offline */ }
}

function setRole(role) {
  state.role = role;
  store.set("pp-role", role);
  document.querySelectorAll(".role button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.role === role)));
  route();
}
document.querySelectorAll(".role button").forEach((b) => b.addEventListener("click", () => setRole(b.dataset.role)));

async function renderList(activeId) {
  let list;
  if (state.role === "reviewer" && keys.for(null, "reviewer")) {
    list = await api("GET", "/api/escrows", undefined, null, keys.for(null, "reviewer")).catch(() => []);
  } else {
    // only the escrows this browser has keys for
    const ids = Object.keys(keys.all());
    list = (await Promise.all(ids.map((id) => api("GET", `/api/escrows/${id}`, undefined, null, keys.any(id)).catch(() => null))))
      .filter(Boolean)
      .map((e) => ({ ...e, needsReview: e.milestones.filter((m) => m.status === "NEEDS_REVIEW" || m.status === "DISPUTED").length }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  const deskLink = state.role === "reviewer" && keys.for(null, "reviewer")
    ? `<a class="escrow-link desk-link" href="#/desk" ${location.hash.startsWith("#/desk") ? 'aria-current="page"' : ""}><div class="t"><span>Risk desk</span></div><div class="p">Every milestone, sorted by risk</div></a>` : "";
  $("#escrow-list").innerHTML = deskLink + (list.length
    ? list.map((e) => {
        const t = e.totals.total || 1;
        return `<a class="escrow-link" href="#/escrow/${e.id}" ${e.id === activeId ? 'aria-current="page"' : ""}>
          <div class="t"><span>${esc(e.title)}</span>${e.needsReview ? '<i class="dot" title="Needs a decision"></i>' : ""}</div>
          <div class="p">${esc(e.clientName)} → ${esc(e.freelancerName)}${e.createdBy === "agent" ? " · via agent" : ""}</div>
          <div class="bar" style="height:6px"><i class="released" style="width:${(e.totals.released / t) * 100}%"></i><i class="held" style="width:${(e.totals.held / t) * 100}%"></i><i class="refunded" style="width:${(e.totals.refunded / t) * 100}%"></i></div>
        </a>`;
      }).join("")
    : `<p class="muted small" style="padding:4px 4px">No escrows yet.</p>`);
}

// ------------------------------------------------------------------ router
async function route() {
  clearInterval(state.pollTimer);
  state.lastJson = "";
  const [path, query] = location.hash.slice(1).split("?");
  const params = new URLSearchParams(query || "");
  const linkKey = params.get("key");
  const linkEscrow = (path || "").split("/").filter(Boolean)[1];
  if (linkKey && linkEscrow) {
    // Opened a share link: learn which role this key has, keep it, and switch to that view.
    try {
      const e = await api("GET", `/api/escrows/${linkEscrow}`, undefined, null, linkKey);
      if (e.you.role === "reviewer") store.set("pp-admin", linkKey); else keys.save(linkEscrow, e.you.role, linkKey);
      state.role = e.you.role; store.set("pp-role", state.role);
      document.querySelectorAll(".role button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.role === state.role)));
      if (!params.get("funded")) toast(`Opened as the ${e.you.role}.`);
    } catch (err) { toast(`That link doesn't work: ${err.message}`, "error"); }
  }
  if (params.get("funded")) toast("Funds are now held. The client has not been charged yet.");
  if (params.get("cancelled")) toast("PayPal approval was cancelled. Nothing was held.");
  if (params.get("error")) toast(params.get("error"), "error");
  if (params.toString()) history.replaceState(null, "", `#${path}`);

  const parts = (path || "/").split("/").filter(Boolean);
  if (parts[0] === "new") return renderNew();
  if (parts[0] === "desk") return renderDesk();
  if (parts[0] === "escrow" && parts[1]) {
    state.tab = parts[2] || "milestones";
    return renderEscrow(parts[1]);
  }
  return renderHome();
}
window.addEventListener("hashchange", route);

// ------------------------------------------------------------------ home
const SAMPLE = `Checkout redesign for Chai & Co online store
Milestone 1: Checkout UI pull request - $400, due in 7 days. Code delivered as a GitHub PR merged to main.
Milestone 2: Deploy to production - $250, due in 10 days. Site is live and the page shows "Checkout"
Milestone 3: Handover doc - $150, due in 14 days. Acceptance: a written guide covering deployment steps, environment variables and rollback.`;

function renderHome() {
  renderList();
  $("#main").innerHTML = `
    <section class="hero">
      <h1>Pay for work only when the work is real.</h1>
      <p>ProofPay holds the client's money in PayPal, checks each delivery against the agreed criteria, and pays the freelancer the moment it passes. People and AI agents use the same rules.</p>
      <div class="row-end" style="justify-content:flex-start">
        <a class="btn btn-primary" href="#/new">Start an escrow</a>
        <a class="btn" href="#/new" id="try-sample">Try a sample scope</a>
      </div>
      <div class="how">
        <div><b>Agree</b><span>Paste the scope. AI turns it into milestones with checkable criteria.</span></div>
        <div><b>Hold</b><span>The client approves a PayPal authorization. Money is reserved, not charged.</span></div>
        <div><b>Prove</b><span>The freelancer submits a PR, a live URL or a document. Checks run instantly.</span></div>
        <div><b>Pay</b><span>Passed with low risk? Captured and paid out. Anything unclear waits for a person.</span></div>
      </div>
    </section>`;
  $("#try-sample").addEventListener("click", () => { state.draft = { sample: true }; });
}

// ------------------------------------------------------------------ new escrow
function renderNew() {
  renderList();
  const sample = state.draft?.sample;
  state.draft = null;
  $("#main").innerHTML = `
    <h1 style="margin-bottom:20px">New escrow</h1>
    <form class="panel stack" id="scope-form">
      <div>
        <h2>Scope of work</h2>
        <p class="muted small" style="margin-top:4px">Paste what was agreed. Mention amounts, deadlines and how you'll know each part is done.</p>
      </div>
      <textarea id="scope" rows="8" required minlength="20" placeholder="e.g. Milestone 1: Landing page - $300, due in 7 days. Live at a public URL.">${sample ? esc(SAMPLE) : ""}</textarea>
      <div class="grid-4">
        <div><label for="cn">Client name</label><input id="cn" required value="${sample ? "Asha Verma" : ""}"></div>
        <div><label for="ce">Client email</label><input id="ce" type="email" required value="${sample ? "asha@chaico.example" : ""}"></div>
        <div><label for="fe">Freelancer PayPal email</label><input id="fe" type="email" required value="${sample ? "dipesh.dev@example.com" : ""}"></div>
        <div><label for="cur">Currency</label><select id="cur">${["USD", "EUR", "GBP", "AUD", "CAD"].map((c) => `<option>${c}</option>`).join("")}</select></div>
      </div>
      <div><label for="fn">Freelancer name</label><input id="fn" required value="${sample ? "Dipesh" : ""}" style="max-width:320px"></div>
      <div class="row-end"><button class="btn btn-primary" id="draft-btn">Draft milestones</button></div>
    </form>
    <div id="draft"></div>`;

  $("#scope-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = $("#draft-btn");
    btn.disabled = true; btn.textContent = "Drafting…";
    try {
      const plan = await api("POST", "/api/plans/draft", { scopeText: $("#scope").value, currency: $("#cur").value });
      state.plan = plan;
      renderDraft();
    } catch (e) { toast(e.message, "error"); }
    btn.disabled = false; btn.textContent = "Draft milestones";
  });
}

const CTYPES = { github_pr_merged: "GitHub PR merged", github_checks_passed: "CI checks pass", url_live: "URL is live", url_contains: "Page contains text", ai_judgment: "AI review" };

function renderDraft() {
  const p = state.plan;
  const sum = p.milestones.reduce((s, m) => s + Number(m.amount || 0), 0);
  $("#draft").innerHTML = `
    <section class="panel stack">
      <div class="sum-line"><h2>Review the plan</h2><span>${money(sum, p.currency)}</span></div>
      <p class="muted small">Drafted by ${p.engine === "claude" ? "Claude" : "the rules parser"}. Edit anything before creating — these criteria decide when money moves.</p>
      ${p.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join("")}
      <div><label for="ptitle">Escrow title</label><input id="ptitle" value="${esc(p.title)}"></div>
      ${p.milestones.map((m, i) => `
        <div class="draft-ms" data-i="${i}">
          <div class="grid-4" style="grid-template-columns:3fr 1fr 1fr">
            <div><label>Milestone ${i + 1}</label><input data-f="title" value="${esc(m.title)}"></div>
            <div><label>Amount</label><input data-f="amount" type="number" min="1" step="0.01" value="${m.amount}"></div>
            <div><label>Due in days</label><input data-f="dueInDays" type="number" min="0" value="${m.dueInDays ?? ""}"></div>
          </div>
          <label>Acceptance criteria</label>
          ${m.criteria.map((c, k) => `
            <div class="crit-row" data-k="${k}">
              <select data-c="type">${Object.entries(CTYPES).map(([v, l]) => `<option value="${v}" ${v === c.type ? "selected" : ""}>${l}</option>`).join("")}</select>
              <input data-c="description" value="${esc(c.description)}" aria-label="Criterion">
              <input data-c="param" value="${esc(c.params?.text ?? c.params?.pathPrefix ?? "")}" placeholder="${c.type === "url_contains" ? "Required text" : c.type === "github_pr_merged" ? "Path prefix (optional)" : "—"}" aria-label="Parameter">
              <button type="button" class="btn btn-quiet" data-del="${k}" aria-label="Remove criterion">×</button>
            </div>`).join("")}
          <div><button type="button" class="btn btn-quiet" data-add="${i}">Add criterion</button></div>
        </div>`).join("")}
      <div class="row-end"><button class="btn btn-primary" id="create-btn">Create escrow</button></div>
    </section>`;

  const sync = () => {
    p.title = $("#ptitle").value;
    document.querySelectorAll(".draft-ms").forEach((el) => {
      const m = p.milestones[+el.dataset.i];
      m.title = $('[data-f="title"]', el).value;
      m.amount = Number($('[data-f="amount"]', el).value);
      const d = $('[data-f="dueInDays"]', el).value;
      m.dueInDays = d === "" ? null : Number(d);
      el.querySelectorAll(".crit-row").forEach((row) => {
        const c = m.criteria[+row.dataset.k];
        c.type = $('[data-c="type"]', row).value;
        c.description = $('[data-c="description"]', row).value;
        const prm = $('[data-c="param"]', row).value.trim();
        c.params = c.type === "url_contains" ? { text: prm } : c.type === "github_pr_merged" && prm ? { pathPrefix: prm } : undefined;
      });
    });
  };
  $("#draft").addEventListener("change", (e) => { sync(); if (e.target.dataset.c === "type" || e.target.dataset.f === "amount") renderDraft(); });
  $("#draft").addEventListener("click", (e) => {
    const t = e.target;
    if (t.dataset.add != null) { sync(); p.milestones[+t.dataset.add].criteria.push({ type: "ai_judgment", description: "" }); renderDraft(); }
    if (t.dataset.del != null) {
      sync();
      const m = p.milestones[+t.closest(".draft-ms").dataset.i];
      if (m.criteria.length > 1) { m.criteria.splice(+t.dataset.del, 1); renderDraft(); } else toast("Each milestone needs at least one criterion.", "error");
    }
  });
  $("#create-btn").addEventListener("click", async () => {
    sync();
    const btn = $("#create-btn");
    btn.disabled = true;
    try {
      const r = await api("POST", "/api/escrows", {
        title: p.title, currency: p.currency, scopeText: $("#scope").value,
        client: { name: $("#cn").value, email: $("#ce").value },
        freelancer: { name: $("#fn").value, email: $("#fe").value },
        milestones: p.milestones,
      });
      keys.save(r.escrow.id, "client", r.access.clientKey);
      keys.save(r.escrow.id, "freelancer", r.access.freelancerKey); // demo convenience: lets you switch to the freelancer view
      store.set(`pp-share-${r.escrow.id}`, r.access.freelancerLink);
      if (state.role !== "client") setRole("client");
      toast("Escrow created. Send the freelancer their link, then fund the first milestone.");
      location.hash = `#/escrow/${r.escrow.id}`;
    } catch (err) { toast(err.message, "error"); btn.disabled = false; }
  });
}

// ------------------------------------------------------------------ escrow
const ROLE_NAME = { client: "client", freelancer: "freelancer", reviewer: "reviewer" };

function renderNoAccess(id) {
  renderList(id);
  clearInterval(state.pollTimer);
  const reviewer = state.role === "reviewer";
  $("#main").innerHTML = `<div class="panel stack">
    <h2>${reviewer ? "Enter the reviewer key" : `You don't have the ${ROLE_NAME[state.role]} link for this escrow`}</h2>
    <p class="muted">${reviewer
      ? "Reviewers resolve disputes across all escrows. The key is in the server's ADMIN_KEY setting, or printed in the server log on first start."
      : `Each party opens an escrow with their own private link. Ask the ${state.role === "client" ? "person who created the escrow" : "client"} for yours, or switch the view above.`}</p>
    ${reviewer ? `<form id="admin-form" class="row-end" style="justify-content:flex-start"><input id="admin-key" type="password" autocomplete="off" placeholder="ppadmin_…" style="max-width:360px"><button class="btn btn-primary">Use key</button></form>` : ""}
  </div>`;
  $("#admin-form")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    store.set("pp-admin", $("#admin-key").value.trim());
    renderEscrow(id);
  });
}

async function renderEscrow(id, quiet = false) {
  let e;
  if (!keys.for(id, state.role)) return renderNoAccess(id);
  try { e = await api("GET", `/api/escrows/${id}`, undefined, id); }
  catch (err) {
    if (err.status === 401 || err.status === 403) { if (state.role === "reviewer") store.set("pp-admin", null); return renderNoAccess(id); }
    $("#main").innerHTML = `<div class="panel"><h2>Escrow not found</h2><p>${esc(err.message)}</p><a class="btn" href="#/">Back</a></div>`; return;
  }
  const json = JSON.stringify(e);
  if (quiet && json === state.lastJson) return;
  state.lastJson = json;
  renderList(id);

  // preserve in-progress proof forms across live refresh
  const keep = {};
  document.querySelectorAll(".proof [data-k]").forEach((i) => (keep[i.dataset.k] = i.value));

  const t = e.totals.total || 1;
  const unfunded = Math.max(0, e.totals.total - e.totals.held - e.totals.released - e.totals.refunded);
  $("#main").innerHTML = `
    <div class="escrow-head">
      <div>
        <h1>${esc(e.title)}</h1>
        <p class="parties"><b>${esc(e.clientName)}</b> pays <b>${esc(e.freelancerName)}</b> <span class="muted">· created ${ago(e.createdAt)}${e.createdBy === "agent" ? " by an AI agent" : ""}</span></p>
      </div>
      <span class="pill s-${e.status === "COMPLETED" ? "RELEASED" : e.status === "CANCELLED" ? "REFUNDED" : "FUNDED"}">${e.status.toLowerCase()}</span>
    </div>
    ${state.role === "client" && store.get(`pp-share-${e.id}`, null) && e.status === "ACTIVE" ? `
    <section class="share">
      <div><b>Send the freelancer their link.</b> <span class="muted small">It's their private access to submit work. Anyone with it can act as the freelancer.</span></div>
      <div class="share-row"><input readonly value="${esc(store.get(`pp-share-${e.id}`, ""))}" aria-label="Freelancer link"><button class="btn" data-copy="${esc(store.get(`pp-share-${e.id}`, ""))}">Copy link</button></div>
    </section>` : ""}
    ${state.role === "freelancer" && e.milestones.some((m) => m.attestation) ? `
    <section class="share track">
      <div><b>Your verified track record.</b> <span class="muted small">Every payment ProofPay releases leaves a signed proof of delivery that belongs to you. Share it with your next client — they can check it without trusting ProofPay, and it doesn't show your email.</span></div>
      <div class="share-row"><button class="btn btn-primary" id="share-record">Copy track record link</button><a class="btn" id="open-record" target="_blank" rel="noopener" href="#">Open it</a></div>
    </section>` : ""}
    <section class="money" aria-label="Where the money is">
      <div class="money-title"><span class="muted">Where the money is</span><span class="money-total">${money(e.totals.total, e.currency)}</span></div>
      <div class="bar"><i class="released" style="width:${(e.totals.released / t) * 100}%"></i><i class="held" style="width:${(e.totals.held / t) * 100}%"></i><i class="refunded" style="width:${(e.totals.refunded / t) * 100}%"></i></div>
      <div class="legend">
        <span><i class="sw" style="background:var(--green)"></i>Paid to freelancer<b>${money(e.totals.released, e.currency)}</b></span>
        <span><i class="sw" style="background:var(--amber)"></i>Held at PayPal<b>${money(e.totals.held, e.currency)}</b></span>
        <span><i class="sw" style="background:var(--rule-strong)"></i>Not funded yet<b>${money(unfunded, e.currency)}</b></span>
        <span><i class="sw" style="background:var(--slate);opacity:.55"></i>Returned or cancelled<b>${money(e.totals.refunded, e.currency)}</b></span>
      </div>
    </section>
    <nav class="tabs">
      ${[["milestones", "Milestones"], ["timeline", "Timeline"], ["ledger", "Ledger"], ["agent", "Connect an agent"]].map(([k, l]) => `<a href="#/escrow/${e.id}/${k}" ${state.tab === k ? 'aria-current="page"' : ""}>${l}</a>`).join("")}
    </nav>
    <div id="tab"></div>`;

  if (state.tab === "ledger") renderLedger(e);
  else if (state.tab === "timeline") renderTimeline(e);
  else if (state.tab === "agent") renderAgent(e);
  else {
    $("#tab").innerHTML = e.milestones.map((m) => milestoneHtml(e, m)).join("");
    document.querySelectorAll(".proof [data-k]").forEach((i) => { if (keep[i.dataset.k] != null) i.value = keep[i.dataset.k]; });
  }

  // live refresh: agents and webhooks change state while you watch
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => { if (!document.hidden && state.tab !== "agent" && state.tab !== "timeline" && !state.busy.size) renderEscrow(id, true); }, 3000);
}

function trackStops(m) {
  const funded = !["DRAFT", "AWAITING_APPROVAL", "REFUNDED"].includes(m.status) || (m.status === "REFUNDED" && m.authorizationId);
  const proof = !!m.submittedAt;
  const checked = !!m.lastVerdict;
  const paid = m.status === "RELEASED";
  const s = (label, done, now, cls = "") => `<div class="stop ${done ? "done" : ""} ${now ? "now" : ""} ${cls}">${label}</div>`;
  if (m.status === "REFUNDED") return s(m.authorizationId ? "Hold placed" : "Not funded", !!m.authorizationId, false) + s("Proof", proof, false) + s("Checked", checked, false) + s("Returned to client", false, true, "bad");
  return (
    s(m.status === "AWAITING_APPROVAL" ? "Awaiting client approval" : "Held at PayPal", funded, m.status === "AWAITING_APPROVAL" || m.status === "FUNDED") +
    s(m.status === "CHANGES_REQUESTED" ? "Changes requested" : "Proof submitted", proof, m.status === "SUBMITTED" || m.status === "CHANGES_REQUESTED", m.status === "CHANGES_REQUESTED" ? "bad" : "") +
    s(m.status === "DISPUTED" ? "In dispute" : m.status === "NEEDS_REVIEW" ? "Waiting for a person" : "Checked", checked, m.status === "NEEDS_REVIEW" || m.status === "DISPUTED", m.status === "DISPUTED" ? "bad" : "") +
    s(paid && !m.payoutBatchId ? (m.payoutPaused ? "Payout paused" : "Payout scheduled") : "Paid to freelancer", paid, paid, paid ? (m.payoutBatchId ? "paid" : m.payoutPaused ? "bad" : "") : "")
  );
}

const isWaitingForMerge = (m) => {
  const failed = (m.lastVerdict?.results ?? []).filter((r) => !r.passed);
  return m.status === "CHANGES_REQUESTED" && failed.length > 0 && failed.every((r) => r.pending);
};
const statusLabel = (m) => (isWaitingForMerge(m) ? "Waiting for merge" : m.status === "RELEASED" && !m.payoutBatchId
  ? (m.payoutPaused ? "Captured — payout paused" : "Captured — payout scheduled") : STATUS_LABEL[m.status]);

const STATUS_LABEL = {
  DRAFT: "Not funded", AWAITING_APPROVAL: "Awaiting PayPal approval", FUNDED: "Funded — work in progress",
  SUBMITTED: "Checking proof", NEEDS_REVIEW: "Needs client decision", CHANGES_REQUESTED: "Changes requested",
  RELEASED: "Paid", DISPUTED: "In dispute", REFUNDED: "Returned to client",
};

function milestoneHtml(e, m) {
  const results = Object.fromEntries((m.lastVerdict?.results ?? []).map((r) => [r.criterionId, r]));
  const r = m.risk;
  const riskColor = !r ? "var(--rule)" : r.band === "low" ? "var(--green)" : r.band === "medium" ? "var(--amber)" : "var(--red)";
  return `
  <article class="ms" id="${m.id}">
    <div class="ms-top">
      <div class="seq" aria-hidden="true">${m.seq}</div>
      <div>
        <h3>${esc(m.title)}</h3>
        <div class="ms-meta">${m.dueDate ? `Due ${new Date(m.dueDate).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : "No deadline"}${m.resubmissions ? ` · ${m.resubmissions} resubmission${m.resubmissions > 1 ? "s" : ""}` : ""}</div>
        <span class="pill s-${isWaitingForMerge(m) ? "SUBMITTED" : m.status}">${statusLabel(m)}</span>
      </div>
      <div class="ms-amount">${money(m.amount, e.currency)}</div>
    </div>
    <div class="track" aria-label="Payment progress">${trackStops(m)}</div>
    <div class="ms-body">
      <div>
        <span class="muted small">Acceptance criteria</span>
        <ul class="criteria">
          ${m.criteria.map((c) => {
            const res = results[c.id];
            return `<li><span class="mark ${res ? (res.passed ? "ok" : "no") : ""}" aria-label="${res ? (res.passed ? "Passed" : "Failed") : "Not checked"}">${res ? (res.passed ? "✓" : "✕") : ""}</span>
              <div><div>${esc(c.description)}</div><div class="ctype">${CTYPES[c.type]}${c.params?.text ? `: “${esc(c.params.text)}”` : ""}${res ? ` · ${Math.round(res.confidence * 100)}% confidence` : ""}</div>
              ${res ? `<div class="cdetail">${esc(res.detail)}</div>` : ""}</div></li>`;
          }).join("")}
        </ul>
        ${m.evidence?.length ? `<div class="evidence-list"><span class="muted small">Proof submitted</span>${m.evidence.map((ev) => `<span>${ev.kind === "text" ? "Document" : ev.kind === "github_pr" ? "Pull request" : "URL"}: ${ev.kind === "text" ? esc(ev.value.slice(0, 120)) + (ev.value.length > 120 ? "…" : "") : (/^https?:\/\//i.test(ev.value) ? `<a href="${esc(ev.value)}" target="_blank" rel="noopener noreferrer">${esc(ev.value)}</a>` : esc(ev.value))}</span>`).join("")}</div>` : ""}
      </div>
      <div>
        <span class="muted small">Release risk (ML)</span>
        ${r ? `
          <div class="risk-score"><strong>${Math.round(r.score * 100)}%</strong><span class="muted small">${r.band} risk of dispute or non-delivery</span></div>
          <div class="meter"><i style="width:${Math.max(3, r.score * 100)}%;background:${riskColor}"></i></div>
          <ul class="reasons">${r.reasons.map((x) => `<li><span>${esc(x.label)}</span><span class="${x.impact > 0 ? "up" : "down"}">${x.impact > 0 ? "raises" : "lowers"}</span></li>`).join("")}</ul>`
        : `<p class="muted small" style="margin-top:6px">Scored when proof is checked. High risk holds the payment for a person to approve.</p>`}
      </div>
    </div>
    ${m.decision ? `<div class="decision"><b>Decision:</b> ${esc(m.decision)}</div>` : ""}
    ${m.holdExpiresSoon ? `<div class="decision warn-line"><b>PayPal hold expires ${esc(new Date(m.authorizationExpiresAt).toLocaleDateString())}.</b> Release, request changes or dispute before then — after that the client is no longer charged and must fund again.</div>` : ""}
    ${m.paypalDisputeId ? `<div class="decision bad-line"><b>PayPal dispute ${esc(m.paypalDisputeId)}</b> (${esc((m.paypalDisputeStatus || "").toLowerCase().replace(/_/g, " "))}). The buyer disputed this payment with PayPal after release; ProofPay answered with the verification record.</div>` : ""}
    ${m.status === "RELEASED" && !m.payoutBatchId && m.payoutDueAt && !m.payoutPaused ? `<div class="decision"><b>Payout scheduled for ${esc(new Date(m.payoutDueAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}.</b> PayPal has captured the money; the freelancer's share waits a little because of this job's release risk, so a late PayPal dispute can't leave anyone out of pocket.</div>` : ""}
    ${m.attestation || m.receiptUrl ? `<div class="ms-actions" style="padding-bottom:0">
      ${m.attestation ? `<a class="btn btn-quiet proof-btn" href="/verify#t=${esc(m.attestation)}" target="_blank" rel="noopener"><span class="seal" aria-hidden="true">✓</span>Signed proof of delivery${m.attestationStatus && m.attestationStatus !== "valid" ? ` (${esc(m.attestationStatus)})` : ""}</a>` : ""}
      ${m.receiptUrl ? `<a class="btn btn-quiet" href="${esc(m.receiptUrl)}" target="_blank" rel="noopener">Open delivery receipt</a>` : ""}
    </div>` : ""}
    ${actionsHtml(e, m)}
  </article>`;
}

function actionsHtml(e, m) {
  const role = state.role;
  const btn = (act, label, cls = "") => `<button class="btn ${cls}" data-act="${act}" data-ms="${m.id}">${label}</button>`;
  const a = [];
  let proof = "";
  if (role === "client") {
    if (m.status === "DRAFT") a.push(btn("fund", `Fund ${money(m.amount, e.currency)} with PayPal`, "btn-pay"));
    if (m.status === "AWAITING_APPROVAL") a.push(btn("fund", "Approve on PayPal", "btn-pay")); // re-issues the link if it expired
    if (m.status === "NEEDS_REVIEW") a.push(btn("release", `Release ${money(m.amount, e.currency)}`, "btn-pay"), btn("changes", "Request changes"));
    if (["FUNDED", "SUBMITTED", "NEEDS_REVIEW", "CHANGES_REQUESTED"].includes(m.status)) a.push(btn("dispute", "Open dispute", "btn-danger"));
    const pastDue = m.dueDate && Date.now() > Date.parse(m.dueDate);
    if (["DRAFT", "AWAITING_APPROVAL"].includes(m.status)) a.push(btn("refund", "Cancel milestone", "btn-quiet"));
    if (m.status === "FUNDED" && pastDue) a.push(btn("refund", "Deadline missed — cancel and release hold", "btn-quiet"));
  }
  if ((role === "client" || role === "reviewer") && m.status === "RELEASED" && !m.payoutBatchId && (role === "reviewer" || !m.payoutPaused))
    a.push(btn("retry-payout", role === "reviewer" && m.payoutPaused ? "Settle dispute and pay freelancer" : "Pay the freelancer now", "btn-pay"));
  if (role === "client" && m.status === "RELEASED" && m.captureId && !m.paypalDisputeId && state.health?.paypal === "demo")
    a.push(btn("simulate-dispute", "Simulate a PayPal chargeback", "btn-quiet"));
  if (role === "freelancer") {
    if (["FUNDED", "CHANGES_REQUESTED"].includes(m.status)) {
      const needs = new Set(m.criteria.map((c) => c.type));
      proof = `<form class="proof" data-ms="${m.id}">
        ${needs.has("github_pr_merged") || needs.has("github_checks_passed") ? `<div><label>Pull request URL</label><input data-k="${m.id}-pr" name="pr" type="url" placeholder="https://github.com/owner/repo/pull/42"></div>` : ""}
        ${needs.has("url_live") || needs.has("url_contains") ? `<div><label>Live URL</label><input data-k="${m.id}-url" name="url" type="url" placeholder="https://"></div>` : ""}
        ${needs.has("ai_judgment") ? `<div><label>Deliverable (paste text or a description with links)</label><textarea data-k="${m.id}-text" name="text" rows="4"></textarea></div>` : ""}
        <div class="row-end" style="justify-content:flex-start"><button class="btn btn-primary">Submit proof</button></div>
      </form>`;
    }
    if (["FUNDED", "SUBMITTED", "NEEDS_REVIEW", "CHANGES_REQUESTED"].includes(m.status)) a.push(btn("dispute", "Open dispute", "btn-danger"));
    if (["FUNDED", "SUBMITTED", "NEEDS_REVIEW", "CHANGES_REQUESTED"].includes(m.status)) a.push(btn("refund", "Give the money back", "btn-quiet"));
  }
  if (role === "reviewer" && m.status === "DISPUTED") a.push(btn("resolve-release", "Pay freelancer", "btn-pay"), btn("resolve-refund", "Return to client"));
  if (m.status === "NEEDS_REVIEW" || m.status === "CHANGES_REQUESTED") a.push(btn("verify", "Re-run checks", "btn-quiet"));
  if (!a.length && !proof) {
    const hint = { client: m.status === "FUNDED" ? "Waiting for the freelancer to submit proof. The hold is protected until the deadline." : "", freelancer: m.status === "DRAFT" || m.status === "AWAITING_APPROVAL" ? "Start once the client has funded this milestone." : "", reviewer: "Reviewers act on disputed milestones." }[role];
    return hint ? `<div class="ms-actions"><span class="muted small">${hint}</span></div>` : `<div style="height:6px"></div>`;
  }
  return `${proof}${a.length ? `<div class="ms-actions">${a.join("")}</div>` : ""}`;
}

$("#main").addEventListener("click", async (ev) => {
  const tr = ev.target.closest("#share-record, #open-record");
  if (tr) {
    ev.preventDefault();
    const escrowId = location.hash.split("/")[2].split("?")[0];
    try {
      const r = await api("GET", `/api/escrows/${escrowId}/track-record`, undefined, escrowId);
      const url = `${location.origin}/verify#b=${r.tokens.join("~")}`;
      if (tr.id === "open-record") window.open(url, "_blank", "noopener");
      else await navigator.clipboard.writeText(url).then(() => toast(`Copied a link to ${r.count} verified deliveries.`), () => window.open(url, "_blank", "noopener"));
    } catch (err) { toast(err.message, "error"); }
    return;
  }
  const c = ev.target.closest("[data-copy]");
  if (c) { navigator.clipboard?.writeText(c.dataset.copy).then(() => toast("Link copied."), () => toast("Couldn't copy — select the link and copy it.", "error")); return; }
  const b = ev.target.closest("[data-act]");
  if (!b) return;
  const id = b.dataset.ms;
  const act = b.dataset.act;
  const escrowId = location.hash.split("/")[2].split("?")[0];
  let body;
  if (act === "changes") { const r = await ask("Request changes", "Tell the freelancer what to fix. The money stays held.", "Send request"); if (!r) return; body = { reason: r }; }
  if (act === "dispute") { const r = await ask("Open a dispute", "Payment is frozen and an AI writes a neutral brief for a reviewer.", "Open dispute"); if (!r) return; body = { reason: r }; }
  if (act === "refund") {
    const fl = state.role === "freelancer";
    const r = await ask(fl ? "Give the money back" : "Cancel this milestone", "The PayPal hold is voided, so the client is never charged. This can't be undone.", fl ? "Return to client" : "Cancel milestone");
    if (!r) return; body = { reason: r };
  }
  if (act.startsWith("resolve")) { const r = await ask("Resolve dispute", "Add a short note for the record.", act === "resolve-release" ? "Pay freelancer" : "Return to client"); if (r == null) return; body = { outcome: act === "resolve-release" ? "release" : "refund", note: r || "Resolved" }; }
  const path = { "retry-payout": "retry-payout", fund: "fund", release: "release", changes: "request-changes", dispute: "dispute", refund: "refund", verify: "verify", "resolve-release": "resolve", "resolve-refund": "resolve" }[act];

  b.disabled = true; state.busy.add(id);
  const old = b.textContent; b.textContent = "Working…";
  try {
    const url = act === "simulate-dispute" ? `/api/demo/paypal-dispute/${id}` : `/api/milestones/${id}/${path}`;
    const r = await api("POST", url, body, escrowId);
    if (act === "fund") { location.href = r.approvalUrl; return; }
    const m = r.milestones?.find((x) => x.id === id);
    toast(act === "simulate-dispute" ? "PayPal dispute received — ProofPay sent the verification record to PayPal as evidence."
      : m?.status === "RELEASED" ? (m.payoutBatchId ? "Payment captured and sent to the freelancer." : "Payment captured. The freelancer's payout is scheduled.") : `Updated: ${statusLabel(m ?? {})}.`);
  } catch (e) { toast(e.message, "error"); b.textContent = old; b.disabled = false; }
  state.busy.delete(id);
  renderEscrow(escrowId);
});

$("#main").addEventListener("submit", async (ev) => {
  const f = ev.target.closest(".proof");
  if (!f) return;
  ev.preventDefault();
  const id = f.dataset.ms;
  const v = (n) => f.elements[n]?.value?.trim();
  const items = [
    v("pr") && { kind: "github_pr", value: v("pr") },
    v("url") && { kind: "url", value: v("url") },
    v("text") && { kind: "text", value: v("text") },
  ].filter(Boolean);
  if (!items.length) return toast("Add at least one piece of proof.", "error");
  const btn = f.querySelector("button");
  btn.disabled = true; btn.textContent = "Checking proof…"; state.busy.add(id);
  try {
    const r = await api("POST", `/api/milestones/${id}/evidence`, { items }, location.hash.split("/")[2].split("?")[0]);
    const m = r.milestones.find((x) => x.id === id);
    toast(m.status === "RELEASED" ? (m.payoutBatchId ? "All checks passed — you've been paid." : "All checks passed. Your payout is scheduled.")
      : m.status === "NEEDS_REVIEW" ? "Checks passed. Waiting for the client to approve release."
      : isWaitingForMerge(m) ? "Submitted. You'll be paid automatically when the pull request is merged."
      : "Some checks failed. See the details and resubmit.", m.status === "CHANGES_REQUESTED" && !isWaitingForMerge(m) ? "error" : "");
  } catch (e) { toast(e.message, "error"); }
  state.busy.delete(id);
  renderEscrow(location.hash.split("/")[2]);
});

// ------------------------------------------------------------------ ledger (AG Grid)
async function renderLedger(e) {
  $("#tab").innerHTML = `<p class="muted small" style="margin-bottom:12px">Every money movement and decision, with who made it. Sort, filter or export.</p>
    <div id="ledger-grid"></div>
    <div class="row-end" style="margin-top:12px"><button class="btn" id="csv">Export CSV</button></div>`;
  const events = await api("GET", `/api/events?escrowId=${e.id}`, undefined, e.id);
  const titles = Object.fromEntries(e.milestones.map((m) => [m.id, `${m.seq}. ${m.title}`]));
  // AG Grid v34+ wants modules registered explicitly; harmless if the bundle already did it.
  if (agGrid.ModuleRegistry && agGrid.AllCommunityModule && !state.gridModules) {
    agGrid.ModuleRegistry.registerModules([agGrid.AllCommunityModule]);
    state.gridModules = true;
  }
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = agGrid.themeQuartz.withParams({
    fontFamily: "Schibsted Grotesk, system-ui, sans-serif",
    accentColor: dark ? "#47c08f" : "#1f7a5a",
    backgroundColor: dark ? "#161f33" : "#ffffff",
    foregroundColor: dark ? "#e8ecf4" : "#14213d",
    headerBackgroundColor: dark ? "#0f1626" : "#f3f5f0",
    borderColor: dark ? "#26314a" : "#dfe3da",
    wrapperBorderRadius: 12,
  });
  const color = { CAPTURED: "var(--green)", PAYOUT_SENT: "var(--green)", FUNDS_HELD: "var(--amber)", HELD_FOR_REVIEW: "var(--amber)", VERIFICATION_FAILED: "var(--red)", DISPUTE_OPENED: "var(--red)", AUTHORIZATION_VOIDED: "var(--slate)" };
  state.grid = agGrid.createGrid($("#ledger-grid"), {
    theme,
    rowData: events.map((x) => ({ ...x, milestone: titles[x.milestoneId] ?? "—" })),
    columnDefs: [
      { field: "ts", headerName: "Time", width: 170, sort: "desc", valueFormatter: (p) => new Date(p.value).toLocaleString() },
      { field: "type", headerName: "Event", width: 200, filter: true, cellStyle: (p) => ({ color: color[p.value] ?? "inherit", fontWeight: 600 }) },
      { field: "milestone", headerName: "Milestone", width: 190, filter: true },
      { field: "actor", headerName: "By", width: 110, filter: true },
      { field: "amount", headerName: "Amount", width: 120, type: "rightAligned", valueFormatter: (p) => (p.value == null ? "" : money(p.value, e.currency)) },
      { field: "message", headerName: "Details", flex: 1, minWidth: 280, tooltipField: "message" },
    ],
    defaultColDef: { sortable: true, resizable: true },
    pagination: true, paginationPageSize: 20, paginationPageSizeSelector: [20, 50, 100],
  });
  $("#csv").addEventListener("click", () => state.grid.exportDataAsCsv({ fileName: `proofpay-${e.id}-ledger.csv` }));
}

// ------------------------------------------------------------------ agent tab
function renderAgent(e) {
  const base = location.origin;
  const canMint = state.role === "client" || state.role === "freelancer";
  $("#tab").innerHTML = `
    <div class="panel stack">
      <div><h2>Let an AI agent work on this escrow</h2>
      <p class="muted" style="margin-top:6px">Give your agent its own key. It acts as the ${esc(state.role)}, with limits the server enforces: it can't approve PayPal holds, release a payment that was held for review, refund, retry payouts or resolve disputes. The ledger shows everything it did.</p></div>
      ${canMint ? `<div class="row-end" style="justify-content:flex-start"><input id="agent-label" placeholder="Agent name, e.g. my coding agent" style="max-width:320px"><button class="btn btn-primary" id="mint">Create agent key</button></div>
      <div id="minted"></div>` : `<p class="muted small">Switch to Client or Freelancer to create an agent key.</p>`}
      <div><label>Remote MCP endpoint</label><pre><code>${esc(base)}/mcp</code></pre></div>
      <div><label>Claude Desktop / Cursor config (local, via stdio)</label><pre><code>${esc(JSON.stringify({ mcpServers: { proofpay: { command: "npx", args: ["tsx", "/absolute/path/to/proofpay/src/mcp/stdio.ts"], env: { PROOFPAY_URL: base } } } }, null, 2))}</code></pre></div>
      <div><label>Or let the agent start from nothing</label><pre><code>Hire riya@design.example to design three logo concepts for my bakery for $120,
due in 5 days. Use ProofPay so she's only paid when the concepts are delivered.
Then show me the link to approve the payment hold.</code></pre>
      <p class="muted small">An agent that creates an escrow never sees your client key. You get your dashboard link when you approve the PayPal hold with your own login.</p></div>
    </div>`;
  $("#mint")?.addEventListener("click", async () => {
    try {
      const r = await api("POST", `/api/escrows/${e.id}/agent-keys`, { label: $("#agent-label").value.trim() || "agent" }, e.id);
      $("#minted").innerHTML = `<div class="warn">Copy this key now — it isn't shown again.</div>
        <pre><code>${esc(r.agentKey)}</code></pre>
        <p class="muted small">Tell your agent: escrow <code>${esc(e.id)}</code>, escrowKey above. It will act as the ${esc(r.role)}.</p>`;
    } catch (err) { toast(err.message, "error"); }
  });
}

// ------------------------------------------------------------------ timeline (Bryntum Gantt)
// Shows each milestone's working window against its PayPal hold window. Holds last 29 days, so the
// picture answers the question a client actually has: "will the money still be held when the work lands?"
let bryntumLoad = null;
function loadBryntum() {
  if (!bryntumLoad) {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    for (const href of ["/vendor/bryntum/fontawesome/css/fontawesome.css", "/vendor/bryntum/fontawesome/css/solid.css",
      "/vendor/bryntum/gantt.css", `/vendor/bryntum/${dark ? "svalbard-dark" : "svalbard-light"}.css`]) {
      const l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; document.head.append(l);
    }
    bryntumLoad = import("/vendor/bryntum/gantt.module.js");
  }
  return bryntumLoad;
}

async function renderTimeline(e) {
  $("#tab").innerHTML = `
    <p class="muted small" style="margin-bottom:10px">Bars are the working time for each milestone. The amber band is its PayPal hold —
      authorizations last 29 days, so delivery has to land inside it. Flags mark deadlines and, for unfunded work, the earliest date funding is allowed.</p>
    <div id="gantt" class="gantt-wrap"><p class="muted small" style="padding:16px">Loading timeline…</p></div>`;
  let Gantt;
  try { ({ Gantt } = await loadBryntum()); }
  catch (err) { $("#gantt").innerHTML = `<p class="muted small" style="padding:16px">The timeline couldn't load (${esc(err.message)}). Run npm install to fetch the Bryntum package.</p>`; return; }
  if (state.tab !== "timeline" || !$("#gantt")) return;

  const DAY = 864e5;
  const created = Date.parse(e.createdAt);
  let cursor = created;
  const colors = { RELEASED: "green", REFUNDED: "light-gray", DISPUTED: "red", CHANGES_REQUESTED: "red", NEEDS_REVIEW: "indigo", SUBMITTED: "blue", FUNDED: "teal", AWAITING_APPROVAL: "cyan", DRAFT: "light-gray" };
  const pct = { RELEASED: 100, NEEDS_REVIEW: 90, SUBMITTED: 80, CHANGES_REQUESTED: 60, DISPUTED: 60, FUNDED: 30, AWAITING_APPROVAL: 5, DRAFT: 0, REFUNDED: 0 };
  const heldStates = ["FUNDED", "SUBMITTED", "NEEDS_REVIEW", "CHANGES_REQUESTED", "DISPUTED"];
  let maxEnd = created + 14 * DAY;
  const tasks = e.milestones.map((m) => {
    const start = m.fundedAt ? Math.min(Date.parse(m.fundedAt), cursor) : cursor;
    const due = m.dueDate ? Date.parse(m.dueDate) : start + 7 * DAY;
    const end = Math.max(due, start + DAY);
    cursor = end;
    const holdStart = m.fundedAt ? Date.parse(m.fundedAt) : null;
    const holdEnd = m.authorizationExpiresAt ? Date.parse(m.authorizationExpiresAt) : null;
    maxEnd = Math.max(maxEnd, end, holdEnd ?? 0);
    return {
      id: m.id, name: `${m.seq}. ${m.title}`, startDate: new Date(start), endDate: new Date(end),
      manuallyScheduled: true, percentDone: pct[m.status] ?? 0, eventColor: colors[m.status] ?? "gray",
      ppAmount: money(m.amount, e.currency), ppStatus: STATUS_LABEL[m.status] ?? m.status,
      ppRisk: m.risk ? `${Math.round(m.risk.score * 100)}%` : "–",
      ppHold: holdStart && holdEnd && heldStates.includes(m.status) ? [holdStart, holdEnd] : null,
      ppDue: m.dueDate ? Date.parse(m.dueDate) : null,
      ppEarliestFund: m.status === "DRAFT" && m.dueDate ? Date.parse(m.dueDate) - 28 * DAY : null,
    };
  });
  const od = (t) => t.originalData || {};
  $("#gantt").innerHTML = "";
  state.gantt?.destroy?.();
  state.gantt = new Gantt({
    appendTo: "gantt",
    height: Math.max(260, 120 + tasks.length * 48),
    readOnly: true,
    startDate: new Date(created - 2 * DAY),
    endDate: new Date(maxEnd + 5 * DAY),
    viewPreset: "weekAndDayLetter",
    rowHeight: 48,
    columns: [
      { type: "name", text: "Milestone", width: 220 },
      { text: "Amount", width: 100, align: "right", renderer: ({ record }) => od(record).ppAmount },
      { text: "Status", width: 170, renderer: ({ record }) => od(record).ppStatus },
      { text: "Risk", width: 70, align: "right", renderer: ({ record }) => od(record).ppRisk },
    ],
    features: {
      projectLines: false,
      timeRanges: { showCurrentTimeLine: { name: "Today" } },
      indicators: {
        items: {
          earlyDates: false, lateDates: false, constraintDate: false, deadlineDate: false,
          ppHold: (t) => (od(t).ppHold ? { startDate: new Date(od(t).ppHold[0]), endDate: new Date(od(t).ppHold[1]), name: "PayPal hold (expires after 29 days)", cls: "pp-hold" } : null),
          ppDue: (t) => (od(t).ppDue ? { startDate: new Date(od(t).ppDue), name: "Delivery deadline", iconCls: "fa fa-flag-checkered", cls: "pp-due" } : null),
          ppEarliestFund: (t) => (od(t).ppEarliestFund && od(t).ppEarliestFund > Date.now()
            ? { startDate: new Date(od(t).ppEarliestFund), name: "Earliest date to fund — the hold must cover the deadline", iconCls: "fa fa-unlock", cls: "pp-fund" } : null),
        },
      },
    },
    project: {
      tasks,
      dependencies: tasks.slice(1).map((t, i) => ({ id: `d${i}`, fromTask: tasks[i].id, toTask: t.id })),
    },
  });
  // fit the whole range — including the 29-day hold windows — into view
  requestAnimationFrame(() => { try { state.gantt.zoomToSpan?.({ startDate: new Date(created - DAY), endDate: new Date(maxEnd + 2 * DAY) }); } catch { /* keep default zoom */ } });
}

// ------------------------------------------------------------------ reviewer risk desk (AG Grid)
async function renderDesk() {
  renderList();
  const admin = keys.for(null, "reviewer");
  if (state.role !== "reviewer" || !admin) { location.hash = "#/"; return; }
  $("#main").innerHTML = `
    <div class="escrow-head"><div><h1>Risk desk</h1><p class="parties">Every milestone across every escrow — riskiest and soonest-expiring first.</p></div></div>
    <div class="desk-tools">
      <input id="desk-q" type="search" placeholder="Search escrows, people, statuses…" aria-label="Search">
      <label class="check"><input type="checkbox" id="desk-open" checked> Needs attention only</label>
      <button class="btn" id="desk-csv">Export CSV</button>
    </div>
    <div id="desk-grid" style="height:560px"></div>`;
  let rows;
  try { rows = await api("GET", "/api/desk", undefined, null, admin); }
  catch (err) { toast(err.message, "error"); return; }

  if (agGrid.ModuleRegistry && agGrid.AllCommunityModule && !state.gridModules) { agGrid.ModuleRegistry.registerModules([agGrid.AllCommunityModule]); state.gridModules = true; }
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const attention = new Set(["NEEDS_REVIEW", "DISPUTED", "CHANGES_REQUESTED", "FUNDED", "SUBMITTED"]);
  const needsAttention = (r) => attention.has(r.status) || !!r.paypalDispute;
  const pill = (p) => `<span class="pill s-${esc(p.value)}" style="margin:0">${esc(STATUS_LABEL[p.value] ?? p.value)}</span>`;
  const riskBar = (p) => {
    if (p.value == null) return `<span class="muted">–</span>`;
    const c = p.value < 0.2 ? "var(--green)" : p.value < 0.4 ? "var(--amber)" : "var(--red)";
    return `<span class="riskcell"><span class="riskbar"><i style="width:${Math.max(4, p.value * 100)}%;background:${c}"></i></span>${Math.round(p.value * 100)}%</span>`;
  };
  const holdCell = (p) => (p.value == null ? "" : `<span class="${p.value < 3 ? "hold-soon" : ""}">${p.value < 0 ? "expired" : `${p.value} d`}</span>`);
  const grid = agGrid.createGrid($("#desk-grid"), {
    theme: agGrid.themeQuartz.withParams({
      fontFamily: "Schibsted Grotesk, system-ui, sans-serif", accentColor: dark ? "#47c08f" : "#1f7a5a",
      backgroundColor: dark ? "#161f33" : "#ffffff", foregroundColor: dark ? "#e8ecf4" : "#14213d",
      headerBackgroundColor: dark ? "#0f1626" : "#f3f5f0", borderColor: dark ? "#26314a" : "#dfe3da", wrapperBorderRadius: 12,
    }),
    rowData: rows,
    columnDefs: [
      { field: "escrowTitle", headerName: "Escrow", minWidth: 200, flex: 1, filter: "agTextColumnFilter", pinned: "left" },
      { field: "milestone", headerName: "Milestone", minWidth: 180, flex: 1 },
      { field: "status", headerName: "Status", width: 190, cellRenderer: pill, filter: "agTextColumnFilter" },
      { field: "risk", headerName: "Risk", width: 140, cellRenderer: riskBar, sort: "desc", sortIndex: 0, filter: "agNumberColumnFilter" },
      { field: "topReason", headerName: "Biggest factor", width: 220 },
      { field: "holdDaysLeft", headerName: "Hold left", width: 110, cellRenderer: holdCell, sort: "asc", sortIndex: 1, filter: "agNumberColumnFilter" },
      { field: "amount", headerName: "Amount", width: 120, type: "rightAligned", valueFormatter: (p) => money(p.value, p.data.currency) },
      { headerName: "Checks", width: 130, valueGetter: (p) => (p.data.criteriaPassed == null ? "" : `${p.data.criteriaPassed}/${p.data.criteriaTotal} · ${Math.round(p.data.confidence * 100)}%`) },
      { field: "paypalDispute", headerName: "PayPal dispute", width: 220, cellClass: (p) => (p.value ? "bad-cell" : "") },
      { field: "client", width: 140, filter: true },
      { field: "freelancer", width: 140, filter: true },
      { field: "createdBy", headerName: "Via", width: 90 },
      { field: "lastEvent", headerName: "Last event", width: 250 },
    ],
    defaultColDef: { sortable: true, resizable: true },
    isExternalFilterPresent: () => !!$("#desk-open")?.checked,
    doesExternalFilterPass: (node) => needsAttention(node.data),
    getRowClass: (p) => (p.data.paypalDispute || p.data.status === "DISPUTED" ? "row-alert" : p.data.holdDaysLeft != null && p.data.holdDaysLeft < 3 ? "row-warn" : ""),
    onRowClicked: (p) => { location.hash = `#/escrow/${p.data.escrowId}`; },
    rowStyle: { cursor: "pointer" },
    pagination: true, paginationPageSize: 25, paginationPageSizeSelector: [25, 50, 100],
  });
  $("#desk-q").addEventListener("input", (ev) => grid.setGridOption("quickFilterText", ev.target.value));
  $("#desk-open").addEventListener("change", () => grid.onFilterChanged());
  $("#desk-csv").addEventListener("click", () => grid.exportDataAsCsv({ fileName: "proofpay-risk-desk.csv" }));
}

// ------------------------------------------------------------------ boot
document.querySelectorAll(".role button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.role === state.role)));
loadHealth();
route();
