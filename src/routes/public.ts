import type { SessionApp } from '../lib/session.js'
import { one } from '../db/index.js'
import { CHANGELOG, SUITE } from '../data/changelog.js'

/**
 * Public pages.
 *
 * Rendered on the server rather than added to the SPA so that what is public is decided here, in
 * one place, by what this module chooses to select. Nothing in this file reads a credential, a
 * ledger balance, a key row, a partner term or a security finding: the query surface is limited to
 * a liveness probe and the static changelog data. Private surfaces stay in the authenticated app at
 * `/` and behind master-key routes.
 */

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))

const NAV: [string, string][] = [
  ['/platform', 'Platform'],
  ['/status', 'Status'],
  ['/roadmap', 'Roadmap'],
  ['/changelog', 'Changelog'],
  ['/docs', 'Docs'],
  ['/partnerships', 'Partners'],
]

const CSS = `
:root{--bg:#0a0b0d;--panel:#12151a;--line:#222831;--ink:#e8ecf1;--muted:#8d97a5;--accent:#4ade80;--warn:#fbbf24}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{border-bottom:1px solid var(--line);background:#0d0f12}
.wrap{max-width:940px;margin:0 auto;padding:0 20px}
.brand{display:flex;align-items:center;gap:10px;padding:18px 0 12px;font-weight:650;letter-spacing:-.01em}
.brand span{color:var(--muted);font-weight:400;font-size:13px}
nav{display:flex;flex-wrap:wrap;gap:6px 18px;padding-bottom:14px;font-size:14px}
nav a{color:var(--muted)}nav a.on{color:var(--ink);font-weight:600}
main{padding:34px 0 60px}
h1{font-size:30px;line-height:1.2;letter-spacing:-.02em;margin:0 0 10px}
h2{font-size:18px;margin:34px 0 10px;letter-spacing:-.01em}
h3{font-size:15px;margin:22px 0 6px}
p{color:#c3cbd6;margin:0 0 12px}
.lead{color:var(--muted);font-size:16px;max-width:65ch}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));margin:18px 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
.card h3{margin:0 0 6px;font-size:14px}
.card p{margin:0;font-size:13.5px;color:var(--muted)}
table{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:12.5px;text-transform:uppercase;letter-spacing:.04em}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
pre{background:#0e1116;border:1px solid var(--line);border-radius:10px;padding:14px;overflow-x:auto}
code{background:#0e1116;padding:1px 5px;border-radius:5px}
pre code{background:none;padding:0}
.pill{display:inline-block;font-size:11.5px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.ok{color:var(--accent);border-color:#1f3b2a}.warn{color:var(--warn);border-color:#3b3320}
.muted{color:var(--muted)}
footer{border-top:1px solid var(--line);color:var(--muted);font-size:12.5px;padding:18px 0 40px}
@media(max-width:520px){h1{font-size:24px}nav{gap:4px 14px}}
`

function layout(title: string, active: string, body: string): string {
  const links = NAV.map(([href, label]) => `<a href="${href}"${href === active ? ' class="on"' : ''}>${label}</a>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Thirdeye AI</title>
<meta name="description" content="Thirdeye AI Platform: pay-per-call AI inference for users and agents.">
<style>${CSS}</style></head><body>
<header><div class="wrap"><div class="brand">Thirdeye AI <span>pay-per-call inference</span></div><nav>${links}<a href="/">App</a></nav></div></header>
<main><div class="wrap">${body}</div></main>
<footer><div class="wrap">Public pages show what we choose to publish. Account balances, keys, partner terms and security findings are private and never rendered here.</div></footer>
</body></html>`
}

// ── Platform ─────────────────────────────────────────────────────────────────
const PLATFORM = `
<h1>Pay for the call, not the seat.</h1>
<p class="lead">Thirdeye routes requests to several model providers behind one OpenAI-compatible API and bills each call at cost plus margin. No subscription, no seat licence, no minimum.</p>
<div class="grid">
  <div class="card"><h3>One API, several providers</h3><p>Point an existing OpenAI client at our base URL. Model names resolve to a live provider pool, with a fallback chain behind each one.</p></div>
  <div class="card"><h3>Per-call pricing</h3><p>Every response reports the billed amount in <code>x-thirdeye-cost-usd</code>, measured, not estimated.</p></div>
  <div class="card"><h3>Prepaid credit</h3><p>Fund the account, or fund a specific API key. A key can carry its own balance and its own monthly ceiling.</p></div>
  <div class="card"><h3>Bring your own key</h3><p>Supply a provider key and it is stored encrypted, used only for your calls, and never shown again.</p></div>
  <div class="card"><h3>Agents with budgets</h3><p>Registered agents run with a step cap, a spend cap and an allowlist for outbound paid tool calls.</p></div>
  <div class="card"><h3>Streaming and tools</h3><p>Server-sent events and OpenAI-shaped tool calling, both billed the same way as a normal call.</p></div>
</div>
<h2>Use it</h2>
<pre><code>curl https://thirdeye-ai-alpha.vercel.app/api/v1/chat/completions \\
  -H "authorization: Bearer $THIRDEYE_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{"model":"gpt-oss-120b","messages":[{"role":"user","content":"hi"}]}'</code></pre>
<p class="muted">Sign in with a wallet to create a key, then fund it with USDC on Base. Full details in <a href="/docs/api">the API guide</a>.</p>
`

// ── Docs hub ─────────────────────────────────────────────────────────────────
const DOCS_HUB = `
<h1>Documentation</h1>
<p class="lead">Three separate guides, because a caller reads one of them rather than all three.</p>
<div class="grid">
  <div class="card"><h3><a href="/docs/api">API usage</a></h3><p>Authentication, keys, chat completions, streaming, tool calling, credits and error codes.</p></div>
  <div class="card"><h3><a href="/docs/mcp">MCP</a></h3><p>Attaching a model context protocol server to an agent, and the guards that apply to the tools it exposes.</p></div>
  <div class="card"><h3><a href="/docs/x402">x402</a></h3><p>How an agent pays for a tool call over HTTP 402, and the limits that keep it from spending freely.</p></div>
</div>
<h2>Also public</h2>
<p><a href="/status">Status</a> for the current deployed version and liveness. <a href="/changelog">Changelog</a> for what changed, in the order it changed.</p>
`

const DOCS_API = `
<h1>API guide</h1>
<p class="lead">OpenAI-compatible at the edge, with per-call billing attached to every response.</p>
<h2>Authentication</h2>
<p>Two paths, both a bearer token. A signed-in session uses the cookie the app sets; programmatic callers use an API key issued in the app.</p>
<pre><code>GET /api/v1/models
authorization: Bearer $THIRDEYE_API_KEY</code></pre>
<h2>Endpoints</h2>
<table><thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead><tbody>
<tr><td>GET</td><td><code>/api/v1/models</code></td><td>Public model catalogue with per-model pricing. The only endpoint that needs no key.</td></tr>
<tr><td>POST</td><td><code>/api/v1/chat/completions</code></td><td>Chat completions, streaming or buffered, with tool calling.</td></tr>
<tr><td>GET</td><td><code>/api/keys</code></td><td>List your keys with per-key credit, budget and rate limits.</td></tr>
<tr><td>POST</td><td><code>/api/keys</code></td><td>Issue a key. The secret is shown once.</td></tr>
<tr><td>POST</td><td><code>/api/payments/intent</code></td><td>Create a deposit intent, optionally tagged to one key.</td></tr>
<tr><td>GET</td><td><code>/api/stats/me</code></td><td>Your usage by day, with tokens and billed cost.</td></tr>
<tr><td>POST</td><td><code>/api/feedback</code></td><td>Public issue or idea intake. Anonymous is allowed.</td></tr>
</tbody></table>
<h2>Billing headers</h2>
<table><thead><tr><th>Header</th><th>Meaning</th></tr></thead><tbody>
<tr><td><code>x-thirdeye-cost-usd</code></td><td>The billed amount for this call, including margin. This is the number to quote.</td></tr>
<tr><td><code>x-thirdeye-key-credit-remaining-usd</code></td><td>Credit left on the key that paid, when the key carries its own balance.</td></tr>
<tr><td><code>x-thirdeye-key-budget-remaining-usd</code></td><td>Spend left under the key's monthly ceiling, when one is set.</td></tr>
</tbody></table>
<p class="muted">Do not compute cost from the catalogue and present it as the price you paid: catalogue rates exclude the platform margin, so the arithmetic understates the real charge by roughly ten percent.</p>
<h2>Errors</h2>
<table><thead><tr><th>Status</th><th>Code</th><th>Meaning</th></tr></thead><tbody>
<tr><td>401</td><td><code>auth</code></td><td>No valid session or key.</td></tr>
<tr><td>402</td><td><code>insufficient_credit</code> / <code>budget_exceeded</code></td><td>The account or the key cannot cover the call.</td></tr>
<tr><td>404</td><td><code>model_not_found</code></td><td>The model is not in the catalogue.</td></tr>
<tr><td>429</td><td><code>rate_limit</code></td><td>The key is over its RPM or TPM window, or the endpoint is protecting itself.</td></tr>
</tbody></table>
`

const DOCS_MCP = `
<h1>MCP guide</h1>
<p class="lead">An agent can be given a model context protocol server. The tools it exposes are treated as untrusted input.</p>
<h2>What is stored</h2>
<p>A list of server entries on the agent row. Each entry is a name and a URL; there is no separate credential store for a server, so a server that needs a token is out of scope today.</p>
<h2>Guards</h2>
<table><thead><tr><th>Control</th><th>Behaviour</th></tr></thead><tbody>
<tr><td>Scheme</td><td>Only <code>https</code>. Anything else is refused before a socket is opened.</td></tr>
<tr><td>Destination</td><td>Private, loopback, link-local and metadata ranges are refused, and the check runs again after every redirect.</td></tr>
<tr><td>Reply size</td><td>Capped, so a hostile server cannot exhaust memory.</td></tr>
<tr><td>Spend</td><td>A paid tool call is bounded by the agent's per-call cap and its allowlist. An unlisted host cannot be paid.</td></tr>
<tr><td>Steps</td><td>The run has a step cap and a budget cap. A loop stops rather than running until the credit is gone.</td></tr>
</tbody></table>
<p class="muted">The same destination policy applies to the generic fetch tool, so a URL that appears in a prompt cannot reach an internal service.</p>
`

const DOCS_X402 = `
<h1>x402 guide</h1>
<p class="lead">HTTP 402 as a payment rail: the server states a price, the client pays, the call proceeds.</p>
<h2>Direction</h2>
<p>Our agents pay for external paid tools. We do not currently accept x402 payments inbound; inbound funding is a prepaid deposit credited to an account or a key.</p>
<h2>What bounds a payment</h2>
<table><thead><tr><th>Control</th><th>Behaviour</th></tr></thead><tbody>
<tr><td>Enable flag</td><td>Off by default per agent. No flag, no payment.</td></tr>
<tr><td>Allowlist</td><td>Only hosts on the agent's list can be paid. Unlisted host means refusal, not a payment attempt.</td></tr>
<tr><td>Per-call cap</td><td>A quoted price above the cap is refused before any signing.</td></tr>
<tr><td>Destination policy</td><td>The payable destination is judged before the unpaid probe, so a hostile quote cannot send us somewhere private.</td></tr>
<tr><td>Ledger</td><td>Recorded against the run, with the amount and the host, so a spike is attributable rather than mysterious.</td></tr>
</tbody></table>
<h2>Reading a 402</h2>
<p class="muted">A 402 is not automatically a demand for money. Some gateways return 402 with a complete free payload. Judge the body, not the status code.</p>
`

// ── Roadmap ──────────────────────────────────────────────────────────────────
const ROADMAP = `
<h1>Roadmap</h1>
<p class="lead">Stated as work, not dates. An item stays in progress until it is measured on the production path.</p>
<h2>Shipped</h2>
<ul>
<li>OpenAI-compatible inference with streaming and tool calling, billed per call.</li>
<li>SIWE sign-in, API keys, per-key credit and per-key monthly ceilings.</li>
<li>BYOK with AES-256-GCM at rest and a documented rotation path.</li>
<li>Agents with MCP servers, step and spend caps, and a SSRF-guarded fetch tool.</li>
<li>Public feedback intake with a triage queue.</li>
<li>Hardening pass on payment verification, log hygiene and auth abuse limits.</li>
</ul>
<h2>In progress</h2>
<ul>
<li><strong>Public pages and agent-facing API</strong>: a documented surface an outside agent can join and use without a human reading the source.</li>
<li><strong>Continuous integration</strong>: typecheck, the full suite and a secret scan gating every push, before any agent is given a write path.</li>
<li><strong>Streaming reconciliation</strong>: streams are charged an estimate up front; the true-up to measured cost is not landing yet.</li>
<li><strong>Finality policy</strong>: a deposit is credited on confirmation depth, and the reorg case needs an explicit rule.</li>
</ul>
<h2>Later</h2>
<ul>
<li>Audit log with correlation ids across a request, its charges and its agent steps.</li>
<li>Agent write access, branch and pull request only, never to the default branch.</li>
<li>Partner-facing analytics on the partner hub.</li>
</ul>
<p class="muted">Nothing here is a promise of a date. Items move when they are verified, not when they are scheduled.</p>
`

// ── Partnerships ─────────────────────────────────────────────────────────────
const PARTNERSHIPS = `
<h1>Partnerships</h1>
<p class="lead">We publish the existence of a partnership and never its terms. Terms are private, and no partnership implies an endorsement of any token or trade.</p>
<div class="grid">
  <div class="card"><h3>Cross-promotion</h3><p>One post each, mutual disclosure, no payment in either direction. Both sides link the other. Nothing else is exchanged.</p></div>
  <div class="card"><h3>Technical pilot</h3><p>A partner's tool gateway attached to one agent, read-only, with a per-call cap and an allowlist. Data is measured before anything is claimed about it.</p></div>
  <div class="card"><h3>What we decline</h3><p>Paid placement without disclosure, resale of our keys, white-label access, and any arrangement that would have us promote a specific coin.</p></div>
</div>
<h2>Disclosed</h2>
<table><thead><tr><th>Partner</th><th>Kind</th><th>Disclosure</th></tr></thead><tbody>
<tr><td>Coin Gawd</td><td>Mutual cross-promotion</td><td>One public post each about a workflow, linking each other, no payment. Terms private, nothing else agreed.</td></tr>
</tbody></table>
<p class="muted">Others are under pilot and are not named until the partner agrees to be named. If you were told about a partnership and cannot find it here, treat that claim as unconfirmed.</p>
`

export function registerPublicRoutes(app: SessionApp): void {
  app.get('/platform', (c) => c.html(layout('Platform', '/platform', PLATFORM)))
  app.get('/docs', (c) => c.html(layout('Documentation', '/docs', DOCS_HUB)))
  app.get('/docs/api', (c) => c.html(layout('API guide', '/docs', DOCS_API)))
  app.get('/docs/mcp', (c) => c.html(layout('MCP guide', '/docs', DOCS_MCP)))
  app.get('/docs/x402', (c) => c.html(layout('x402 guide', '/docs', DOCS_X402)))
  app.get('/roadmap', (c) => c.html(layout('Roadmap', '/roadmap', ROADMAP)))
  app.get('/partnerships', (c) => c.html(layout('Partnerships', '/partnerships', PARTNERSHIPS)))

  /**
   * Status is the only page that reads the database, and it reads exactly one thing: whether a
   * trivial query answers. It deliberately reports no balances, no counts of users or traffic and
   * no open security findings, since those are either private or would be a map for an attacker.
   */
  app.get('/status', async (c) => {
    let db = 'unknown'
    try {
      await one('SELECT 1 AS ok')
      db = 'up'
    } catch {
      db = 'down'
    }
    const sha = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || 'local'
    const changed = CHANGELOG.slice(0, 5)
      .map((e) => `<tr><td><code>${esc(e.sha)}</code></td><td>${esc(e.date)}</td><td>${esc(e.summary)}</td></tr>`)
      .join('')
    const body = `
<h1>Status</h1>
<p class="lead">What is running, what it was built from, and how much of it is covered by tests.</p>
<div class="grid">
  <div class="card"><h3>API</h3><p><span class="pill ${db === 'up' ? 'ok' : 'warn'}">database ${esc(db)}</span></p></div>
  <div class="card"><h3>Deployed commit</h3><p><code>${esc(sha)}</code></p></div>
  <div class="card"><h3>Test suite</h3><p>${SUITE.tests} tests green, measured ${esc(SUITE.measuredOn)} with <code>${esc(SUITE.command)}</code>.</p></div>
</div>
<h2>Recent changes</h2>
<table><thead><tr><th>Commit</th><th>Date</th><th>Change</th></tr></thead><tbody>${changed}</tbody></table>
<p class="muted">A green suite is not a promise of correctness, only that the behaviour we thought to test still holds.</p>
<p><a href="/changelog">Full changelog</a></p>`
    return c.html(layout('Status', '/status', body))
  })

  app.get('/changelog', (c) => {
    const rows = CHANGELOG.map((e) => `<tr><td><code>${esc(e.sha)}</code></td><td>${esc(e.date)}</td><td>${esc(e.summary)}</td></tr>`).join('')
    const body = `
<h1>Changelog</h1>
<p class="lead">Generated from the commit history. Newest first, merge commits excluded.</p>
<table><thead><tr><th>Commit</th><th>Date</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table>`
    return c.html(layout('Changelog', '/changelog', body))
  })
}
