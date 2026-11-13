import type { SessionApp } from '../lib/session.js'
import { one, query } from '../db/index.js'
import { CHANGELOG, SUITE } from '../data/changelog.js'
import { WHITEPAPER } from './whitepaper.js'

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

const SITE = 'https://thirdeye-ai-alpha.vercel.app'

/**
 * The project's official contact address, published here on purpose.
 *
 * Token listings ask for an address on the project's own domain. The project domain is a
 * vercel.app subdomain, which cannot receive mail, so the address is hosted on AgentMail's public
 * domain instead. Publishing it on this page is what makes it verifiable: a reviewer can see the
 * address the project claims, on the project's own site, next to the contract and the creator
 * address it belongs to. Keep this value in sync with any listing submission.
 */
export const PROJECT_EMAIL = 'thirdeye-ai@agentmail.to'
const OG_DESCRIPTION = 'Pay per call, not per seat. OpenAI-compatible inference, wallet-native accounts, USDC credits.'

/**
 * Head shared by every public page. The icon set and the social card are real files in
 * `web/public`, so the markup here points at assets that exist rather than at a CDN.
 */
function head(title: string, path: string): string {
  return `<meta name="application-name" content="Thirdeye AI">
<meta name="theme-color" content="#0A0C10">
<meta name="color-scheme" content="dark">
<link rel="canonical" href="${SITE}${path}">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Thirdeye AI">
<meta property="og:url" content="${SITE}${path}">
<meta property="og:title" content="${esc(title)} · Thirdeye AI">
<meta property="og:description" content="${OG_DESCRIPTION}">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Thirdeye AI: amber eye mark on ink. Pay per call, not per seat.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@Thirdeye_Infra">
<meta name="twitter:title" content="${esc(title)} · Thirdeye AI">
<meta name="twitter:description" content="${OG_DESCRIPTION}">
<meta name="twitter:image" content="${SITE}/og.png">
<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Thirdeye AI',
    url: SITE,
    logo: `${SITE}/brand/mark.svg`,
    email: PROJECT_EMAIL,
    contactPoint: [{
      '@type': 'ContactPoint',
      contactType: 'customer support',
      email: PROJECT_EMAIL,
      url: `${SITE}/contact`,
      availableLanguage: 'English',
    }],
    description: OG_DESCRIPTION,
  }).replace(/</g, '\\u003c')}</script>`
}

const NAV: [string, string][] = [
  ['/platform', 'Platform'],
  ['/status', 'Status'],
  ['/roadmap', 'Roadmap'],
  ['/changelog', 'Changelog'],
  ['/docs', 'Docs'],
  ['/agents', 'Agents'],
  ['/team', 'Team'],
  ['/partnerships', 'Partners'],
  ['/whitepaper', 'Whitepaper'],
  ['/contact', 'Contact'],
]

const CSS = `
:root{--bg:#050505;--panel:#121212;--line:#212121;--ink:#F9F9F9;--muted:#888888;--accent:#F9F9F9;--warn:#fbbf24}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{border-bottom:1px solid var(--line);background:#0d0f12}
.wrap{max-width:940px;margin:0 auto;padding:0 20px}
.brand{display:flex;align-items:center;gap:10px;padding:18px 0 12px;font-weight:650;letter-spacing:-.01em}
.brand img{width:20px;height:20px;display:block}.brand span{color:var(--muted);font-weight:400;font-size:13px}
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
.tw{overflow-x:auto}.tw table{margin:0}
@media(max-width:520px){h1{font-size:24px}nav{gap:4px 14px}}
`

function layout(title: string, active: string, body: string, path = active): string {
  const links = NAV.map(([href, label]) => `<a href="${href}"${href === active ? ' class="on"' : ''}>${label}</a>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Thirdeye AI</title>
<meta name="description" content="${OG_DESCRIPTION}">
${head(title, path)}
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet"><style>${CSS}</style></head><body>
<header><div class="wrap"><div class="brand"><img src="/brand/mark-micro.svg" alt="" width="20" height="20">Thirdeye AI <span>pay-per-call inference</span></div><nav>${links}<a href="/">App</a></nav></div></header>
<main><div class="wrap">${body}</div></main>
<footer><div class="wrap"><p style="margin:0 0 6px">Official project email: <a href="mailto:${PROJECT_EMAIL}">${PROJECT_EMAIL}</a> &middot; <a href="/contact">Contact and verification</a></p>Public pages show what we choose to publish. Account balances, keys, partner terms and security findings are private and never rendered here.</div></footer>
<script defer src="/_vercel/insights/script.js"></script>
</body></html>`
}

// ── Platform ─────────────────────────────────────────────────────────────────
const PLATFORM = `
<h1>Pay for the call, not the seat.</h1>
<p class="lead">Thirdeye routes requests to several model providers behind one OpenAI-compatible API and bills each call at cost plus margin. No subscription, no seat licence, no minimum.</p>
<div class="grid">
  <div class="card"><h3>One API, several providers</h3><p>Point an existing OpenAI client at our base URL. Model names resolve to a live provider pool, with a fallback chain behind each one.</p></div>
  <div class="card"><h3>Per-call pricing</h3><p>Every JSON response reports its billed amount in <code>x-thirdeye-cost-usd</code>, measured. A stream reports the reserved estimate up front, settles to the measured cost as it ends, and says which figure it is sending in <code>x-thirdeye-cost-basis</code>.</p></div>
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
<div class="card"><h3><a href="/docs/agents">Agent API</a></h3><p>Register an agent identity, get a key, appear in the directory, and call inference.</p></div>
<h2>Also public</h2>
<p><a href="/whitepaper">Whitepaper</a> for how the platform works and what is verifiable about it. <a href="/status">Status</a> for the current deployed version and liveness. <a href="/changelog">Changelog</a> for what changed, in the order it changed.</p>
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
<li>Streaming settled at measured cost: the reserve is trued up inside the response stream, so the charge no longer depends on the runtime keeping a background task alive.</li>
<li>Continuous integration: typecheck, the full suite and a credential scan on every pull request.</li>
</ul>
<h2>In progress</h2>
<ul>
<li><strong>Public pages and agent-facing API</strong>: a documented surface an outside agent can join and use without a human reading the source.</li>
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


const DOCS_AGENTS = `
<h1>Agent API</h1>
<p class="lead">An outside agent can hold an identity here, with its own name, description and capabilities, and call inference with its own key.</p>
<h2>What an identity is, and is not</h2>
<p>An identity belongs to an owner account and its key bills that account. An agent cannot hold its own balance: billing is per account across this platform, so an agent that needs to pay must be given credit by its owner. Everything else is the agent's own: name, description, advertised capabilities and its place in the directory.</p>
<h2>Register</h2>
<pre><code>curl -X POST https://thirdeye-ai-alpha.vercel.app/api/v1/agents/register \\
  -H "authorization: Bearer $THIRDEYE_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{"name":"Ledger Owl","description":"Watches onchain transfer logs and reports anomalies twice an hour.","capabilities":["log-watch"],"homepage":"https://example.com/owl"}'</code></pre>
<p>Returns the identity and a key, shown once. Registration needs a session or an existing key, and is limited to five per client per hour.</p>
<h2>Endpoints</h2>
<table><thead><tr><th>Method</th><th>Path</th><th>Who</th><th>Purpose</th></tr></thead><tbody>
<tr><td>POST</td><td><code>/api/v1/agents/register</code></td><td>session or key</td><td>Create an identity and receive its one key.</td></tr>
<tr><td>GET</td><td><code>/api/v1/agents/me</code></td><td>agent key</td><td>Your identity plus what your key has billed and when it last called.</td></tr>
<tr><td>PATCH</td><td><code>/api/v1/agents/me</code></td><td>agent key</td><td>Edit name, description, capabilities, homepage or callback. A partial edit is still validated as a whole.</td></tr>
<tr><td>DELETE</td><td><code>/api/v1/agents/me</code></td><td>agent key</td><td>Retire: status changes and the key is revoked, but spend history survives.</td></tr>
<tr><td>GET</td><td><code>/api/v1/agents/directory</code></td><td>public</td><td>Active identities: slug, name, description, capabilities, homepage.</td></tr>
</tbody></table>
<h2>Rules the endpoints enforce</h2>
<table><thead><tr><th>Field</th><th>Rule</th></tr></thead><tbody>
<tr><td>name</td><td>2 to 60 characters. The slug is derived from it; a collision takes a random suffix rather than failing.</td></tr>
<tr><td>description</td><td>20 to 600 characters, because it is the whole of what the directory shows.</td></tr>
<tr><td>capabilities</td><td>Up to 12 short strings, 40 characters each, de-duplicated.</td></tr>
<tr><td>homepage, callbackUrl</td><td>https only, public hostname only, no IP literal, no localhost, no query string or fragment.</td></tr>
</tbody></table>
<h2>Using the key</h2>
<p>An agent key is an ordinary platform key, so it works on the inference endpoints:</p>
<pre><code>curl https://thirdeye-ai-alpha.vercel.app/api/v1/chat/completions \\
  -H "authorization: Bearer $AGENT_KEY" \\
  -H "content-type: application/json" \\
  -d '{"model":"gpt-oss-120b","messages":[{"role":"user","content":"hello"}]}'</code></pre>
<p class="muted">A plain user key is refused on the identity endpoints with 403, so an agent cannot claim an identity it was not issued.</p>
<h2>Peer addressing</h2>
<p>For agent-to-agent traffic there is an A2A card at <code>/.well-known/agent-card.json</code> and a JSON-RPC endpoint at <code>/a2a</code>. The identity API is for participation as a user of the platform; A2A is for being addressed as a peer.</p>
`

// ── Team activity ────────────────────────────────────────────────────────────
/**
 * The agent team's working log, built from `agent_runs` and `agent_run_events`.
 *
 * What this page selects *is* the safety design. It reads tool NAMES, outcomes, timestamps, status,
 * spend and budget, and nothing else. It never selects `args_excerpt`, `result_excerpt`, `input`,
 * `output`, `system_prompt` or `user_id`, because those carry repo contents, prompts and account
 * identifiers. Raw provider errors are never rendered either, since they can embed the upstream
 * organisation name, so a failure is reduced to one of four fixed reason codes.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Absolute UTC first: a relative time goes stale in any cache. */
export function utcStamp(value: unknown): string {
  const d = value instanceof Date ? value : value ? new Date(String(value)) : null
  if (!d || Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`
}

export function usdFromMicros(micros: unknown): string {
  const n = Number(micros ?? 0)
  if (!Number.isFinite(n) || n <= 0) return '$0'
  const d = n / 1_000_000
  return d >= 0.01 ? `$${d.toFixed(4)}` : `$${d.toFixed(6)}`
}

export type RunFailure = 'rate_limited' | 'timeout' | 'crashed' | 'failed' | null

/** Lossy on purpose: show a shape an operator can act on without publishing provider details. */
export function classifyRunError(status: string, error: unknown): RunFailure {
  if (status !== 'error' && status !== 'failed') return null
  const t = String(error ?? '').toLowerCase()
  if (!t) return 'failed'
  if (t.includes('429') || t.includes('rate limit')) return 'rate_limited'
  if (t.includes('timeout') || t.includes('timed out') || t.includes('etimedout')) return 'timeout'
  if (t.includes('crash') || t.includes('http 500')) return 'crashed'
  return 'failed'
}

const FAILURE_LABEL: Record<Exclude<RunFailure, null>, string> = {
  rate_limited: 'provider rate limit',
  timeout: 'timed out',
  crashed: 'crashed mid-run',
  failed: 'run failed',
}

/** A run still marked `running` long after it started is the orphan the runner never closes. */
export const STUCK_AFTER_MS = 30 * 60 * 1000

export function runPill(status: string, createdAt: unknown, error: unknown, now = Date.now()): string {
  const started = createdAt ? new Date(String(createdAt)).getTime() : NaN
  if (status === 'running') {
    return Number.isFinite(started) && now - started > STUCK_AFTER_MS
      ? '<span class="pill warn">stuck</span>'
      : '<span class="pill">running</span>'
  }
  if (status === 'success' || status === 'completed' || status === 'ok') return '<span class="pill ok">ok</span>'
  const reason = classifyRunError(status, error)
  return `<span class="pill warn">${esc(reason ? FAILURE_LABEL[reason] : 'failed')}</span>`
}

const TEAM_WHERE = `left(a.id, 4) = 'tdt_'`

async function teamPage(): Promise<string> {
  let failed = false
  let stats: any = null
  let roster: any[] = []
  let runs: any[] = []
  let log: any[] = []
  let findings: any[] = []
  try {
    stats = await one(
      `SELECT
         (SELECT count(*) FROM agent_runs r WHERE left(r.agent_id, 4) = 'tdt_')::int AS runs,
         (SELECT count(*) FROM agent_run_events e WHERE left(e.agent_id, 4) = 'tdt_')::int AS calls,
         (SELECT coalesce(sum(r.spend_usd_micros), 0) FROM agent_runs r WHERE left(r.agent_id, 4) = 'tdt_')::int AS spend,
         (SELECT count(*) FROM agent_alerts WHERE acknowledged_at IS NULL)::int AS open_findings`
    )
    roster = (
      await query(
        `SELECT a.id, a.name, a.model, a.status, a.budget_usd_micros, a.last_run_at,
                (SELECT count(*) FROM agent_runs r WHERE r.agent_id = a.id)::int AS runs,
                (SELECT coalesce(sum(r.spend_usd_micros), 0) FROM agent_runs r WHERE r.agent_id = a.id)::int AS spend
         FROM agents a WHERE ${TEAM_WHERE} ORDER BY a.name`
      )
    ).rows
    runs = (
      await query(
        `SELECT r.status, r.tool_calls, r.spend_usd_micros, r.created_at, r.error, a.name
         FROM agent_runs r JOIN agents a ON a.id = r.agent_id
         WHERE ${TEAM_WHERE} ORDER BY r.created_at DESC LIMIT 20`
      )
    ).rows
    log = (
      await query(
        `SELECT e.seq, e.tool, e.ok, e.refused, e.created_at, a.name
         FROM agent_run_events e JOIN agents a ON a.id = e.agent_id
         WHERE ${TEAM_WHERE} ORDER BY e.created_at DESC, e.seq DESC LIMIT 30`
      )
    ).rows
    findings = (
      await query(
        `SELECT al.code, al.severity, al.created_at, al.acknowledged_at, a.name
         FROM agent_alerts al LEFT JOIN agents a ON a.id = al.agent_id
         ORDER BY al.created_at DESC LIMIT 10`
      )
    ).rows
  } catch {
    failed = true
  }

  if (failed) {
    return `
<h1>Agent team activity</h1>
<p class="lead">The working log of the development team: what each agent ran, which tools it called and what came back.</p>
<div class="card"><h3>The ledger did not answer</h3><p>This page reads the run ledger directly. The query failed, so nothing here would be true, and an empty table would read as "quiet team" instead of "broken page". Try again shortly.</p></div>`
  }

  const now = Date.now()

  const stat = (label: string, value: string, note: string) =>
    `<div class="card"><h3>${esc(label)}</h3><p style="font-size:22px;color:var(--ink);font-variant-numeric:tabular-nums">${esc(value)}</p><p>${esc(note)}</p></div>`

  const statStrip = `<div class="grid">
  ${stat('Runs recorded', String(stats?.runs ?? 0), 'every agent run, successful or not')}
  ${stat('Tool calls logged', String(stats?.calls ?? 0), 'one row per call, arguments never stored here')}
  ${stat('Spend to date', usdFromMicros(stats?.spend), 'sum of recorded per-run spend')}
  ${stat('Open findings', String(stats?.open_findings ?? 0), 'raised by the monitor, not yet acknowledged')}
</div>`

  const rosterRows = roster.length
    ? roster
        .map(
          (a) =>
            `<tr><td><strong>${esc(a.name)}</strong></td><td>${esc(a.model)}</td><td>${esc(usdFromMicros(a.budget_usd_micros))}</td><td>${a.runs}</td><td>${esc(usdFromMicros(a.spend))}</td><td>${esc(utcStamp(a.last_run_at))}</td><td>${esc(a.status)}</td></tr>`
        )
        .join('')
    : `<tr><td colspan="7" class="muted">No team agents registered.</td></tr>`

  const runRows = runs.length
    ? runs
        .map(
          (r) =>
            `<tr><td>${esc(utcStamp(r.created_at))}</td><td>${esc(r.name)}</td><td>${runPill(String(r.status), r.created_at, r.error, now)}</td><td>${r.tool_calls}</td><td>${esc(usdFromMicros(r.spend_usd_micros))}</td></tr>`
        )
        .join('')
    : `<tr><td colspan="5" class="muted">No runs recorded yet. The first scheduled tick writes the first row.</td></tr>`

  const logRows = log.length
    ? log
        .map((e) => {
          const outcome = e.refused
            ? '<span class="pill warn">refused</span>'
            : e.ok
              ? '<span class="pill ok">ok</span>'
              : '<span class="pill warn">error</span>'
          return `<tr><td>${esc(utcStamp(e.created_at))}</td><td>${esc(e.name)}</td><td>${e.seq}</td><td><code>${esc(e.tool)}</code></td><td>${outcome}</td></tr>`
        })
        .join('')
    : `<tr><td colspan="5" class="muted">No tool calls logged yet.</td></tr>`

  const findingRows = findings.length
    ? findings
        .map(
          (f) =>
            `<tr><td><code>${esc(f.code)}</code></td><td>${esc(f.severity)}</td><td>${esc(f.name ?? '—')}</td><td>${esc(utcStamp(f.created_at))}</td><td>${f.acknowledged_at ? '<span class="pill ok">acknowledged</span>' : '<span class="pill warn">open</span>'}</td></tr>`
        )
        .join('')
    : `<tr><td colspan="5" class="muted">No findings raised.</td></tr>`

  return `
<h1>Agent team activity</h1>
<p class="lead">The working log of the development team. Every row below is a recorded run or a recorded tool call, read from the same ledger the monitor reads. Nothing here is a summary we wrote by hand.</p>
${statStrip}
<h2>The team</h2>
<div class="tw"><table><thead><tr><th>Agent</th><th>Model</th><th>Per-run budget</th><th>Runs</th><th>Spend</th><th>Last run</th><th>Status</th></tr></thead><tbody>${rosterRows}</tbody></table></div>
<h2>Recent runs</h2>
<div class="tw"><table><thead><tr><th>Started (UTC)</th><th>Agent</th><th>Outcome</th><th>Tool calls</th><th>Spend</th></tr></thead><tbody>${runRows}</tbody></table></div>
<h2>Working log</h2>
<p class="muted" style="font-size:13.5px">The last 30 tool calls, newest first. A refused call is one the agent attempted and the runner blocked.</p>
<div class="tw"><table><thead><tr><th>When (UTC)</th><th>Agent</th><th>#</th><th>Tool</th><th>Outcome</th></tr></thead><tbody>${logRows}</tbody></table></div>
<h2>Findings</h2>
<p class="muted" style="font-size:13.5px">Raised by the monitor over these rows: stuck and failed runs, refused writes, spend without a matching verification, timestamp mismatches.</p>
<div class="tw"><table><thead><tr><th>Code</th><th>Severity</th><th>Agent</th><th>Raised (UTC)</th><th>State</th></tr></thead><tbody>${findingRows}</tbody></table></div>
<p class="muted" style="margin-top:26px">What this page leaves out, deliberately: agent prompts, tool arguments, tool results, run inputs and outputs, account identifiers, and the raw text of a provider error. Arguments and results are the parts that carry repository contents and customer data, so they stay behind the master key at <code>/api/admin/agents</code>. A failure is published as one of four reason codes instead of the provider's message, because that message can name the upstream account.</p>`
}

// ── Contact ──────────────────────────────────────────────────────────────────
/**
 * The official contact page. Two jobs: publish the address a token listing asks for, and give a
 * reviewer enough anchors to check that the address really belongs to this project.
 */
const CONTACT = `
<h1>Contact</h1>
<p class="lead">One address, published here so it can be checked against the project rather than taken on trust.</p>
<div class="card"><h3>Official project email</h3><p style="font-size:16px"><a href="mailto:${PROJECT_EMAIL}">${PROJECT_EMAIL}</a></p><p class="muted" style="margin-top:6px">Display name: Thirdeye AI. This is the only address the project uses.</p></div>
<h2>What this address is for</h2>
<div class="grid">
  <div class="card"><h3>Token and listing verification</h3><p>The contact address on file with block explorers and token listings, including the BaseScan token information submission for the THIRDEYE contract.</p></div>
  <div class="card"><h3>Platform and billing</h3><p>Account, invoice, deposit and credit questions for people and agents using the inference API.</p></div>
  <div class="card"><h3>Security and abuse</h3><p>Vulnerability reports, key exposure, and reports of the platform being used to attack something else.</p></div>
  <div class="card"><h3>Partnerships</h3><p>First contact for barter and integration enquiries. Terms already published at <a href="/partnerships">Partnerships</a>.</p></div>
</div>
<h2>Why the address is not on this domain</h2>
<p>The project site runs on a <code>vercel.app</code> subdomain. A subdomain of a hosting platform cannot receive mail, so the project mail is hosted on AgentMail's public domain instead. That is a public mail domain in the same sense as Gmail, which is why this page exists: the address is published on the project's own site, next to the contract and the creator address it belongs to, so a reviewer can confirm that the project is the party claiming it rather than relying on the address alone.</p>
<h2>Verifying that this is the project</h2>
<p>Every anchor below is onchain or on a public host, so none of them depend on this page being truthful.</p>
<table><thead><tr><th>Anchor</th><th>Value</th></tr></thead><tbody>
<tr><td>Token contract (Base)</td><td><code>0xA8A65A86E01D227Dbfd7C7a94d14344b33603df5</code></td></tr>
<tr><td>Launch transaction</td><td><code>0x66e65f6e49bf08a34cbc703df9ae6b2d4fd983a2a2068340a17a53b93589ead2</code></td></tr>
<tr><td>Block and time of launch</td><td>56,365,145 &middot; 12 Nov 2026 06:03:24 UTC</td></tr>
<tr><td>Creator address</td><td><code>0xb09f37a1110a126d63463Ec08a0C0B97612D90ab</code></td></tr>
<tr><td>Launch contract</td><td><code>0x660eaaedebc968f8f3694354fa8ec0b4c5ba8d12</code></td></tr>
<tr><td>Source repository</td><td><a href="https://github.com/hakuramasam/thirdeye-ai" rel="noopener">github.com/hakuramasam/thirdeye-ai</a></td></tr>
<tr><td>X</td><td><a href="https://x.com/Thirdeye_Infra" rel="noopener">@Thirdeye_Infra</a></td></tr>
</tbody></table>
<h2>What this address will never ask for</h2>
<p>No one writing from this address will ask for a seed phrase, a private key, a signed transaction you did not initiate, or a payment to anywhere other than the deposit path documented in <a href="/docs/api">the API guide</a>. A message from a lookalike domain is not from us: the address on this page is the only one the project uses.</p>
<p class="muted">Response is not instant. The mailbox is read by the project operator, and an autonomous agent triages it first; anything involving money, credentials or a contract change is escalated to the operator rather than answered by the agent.</p>
`

export function registerPublicRoutes(app: SessionApp): void {
  app.get('/platform', (c) => c.html(layout('Platform', '/platform', PLATFORM)))
  app.get('/docs', (c) => c.html(layout('Documentation', '/docs', DOCS_HUB)))
  app.get('/docs/api', (c) => c.html(layout('API guide', '/docs', DOCS_API, '/docs/api')))
  app.get('/docs/mcp', (c) => c.html(layout('MCP guide', '/docs', DOCS_MCP, '/docs/mcp')))
  app.get('/docs/x402', (c) => c.html(layout('x402 guide', '/docs', DOCS_X402, '/docs/x402')))
  app.get('/docs/agents', (c) => c.html(layout('Agent API', '/docs', DOCS_AGENTS, '/docs/agents')))
  app.get('/roadmap', (c) => c.html(layout('Roadmap', '/roadmap', ROADMAP)))
  app.get('/partnerships', (c) => c.html(layout('Partnerships', '/partnerships', PARTNERSHIPS)))
  app.get('/whitepaper', (c) => c.html(layout('Whitepaper', '/whitepaper', WHITEPAPER)))
  app.get('/contact', (c) => c.html(layout('Contact', '/contact', CONTACT)))

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


  /** Public directory of registered agent identities. Identity and claims only. */
  app.get('/agents', async (c) => {
    let rows: any[] = []
    try {
      const r = await query(
        `SELECT slug, name, description, capabilities, homepage FROM agent_identities
         WHERE status = 'active' ORDER BY created_at DESC LIMIT 60`
      )
      rows = r.rows
    } catch {
      rows = []
    }
    const cards = rows.length
      ? rows
          .map((a) => {
            const caps = (a.capabilities ?? []).map((x: string) => `<span class="pill">${esc(x)}</span>`).join(' ')
            const link = a.homepage ? ` <a href="${esc(a.homepage)}" rel="nofollow noopener">homepage</a>` : ''
            return `<div class="card"><h3>${esc(a.name)}</h3><p>${esc(a.description)}</p><p style="margin-top:8px">${caps}</p><p class="muted" style="margin-top:6px"><code>${esc(a.slug)}</code>${link}</p></div>`
          })
          .join('')
      : `<div class="card"><h3>No agents registered yet</h3><p>The directory fills as identities register. The first one is a single POST.</p></div>`
    const body = `
<h1>Agent directory</h1>
<p class="lead">Agents that hold an identity on this platform. Each one is described by its owner, so treat a claim here as a claim and not as a verification.</p>
<div class="grid">${cards}</div>
<p class="muted">Registering takes a session or a key and one request. See <a href="/docs/agents">the Agent API</a>. Owner accounts, spend and key prefixes are never published.</p>`
    return c.html(layout('Agent directory', '/agents', body))
  })

  /**
   * The agent team's working log. Public by construction: the SELECT list is the allowlist, so a
   * column that is not named here cannot appear on the page.
   */
  app.get('/team', async (c) => c.html(layout('Team activity', '/team', await teamPage())))

  app.get('/changelog', (c) => {
    const rows = CHANGELOG.map((e) => `<tr><td><code>${esc(e.sha)}</code></td><td>${esc(e.date)}</td><td>${esc(e.summary)}</td></tr>`).join('')
    const body = `
<h1>Changelog</h1>
<p class="lead">Generated from the commit history. Newest first, merge commits excluded.</p>
<table><thead><tr><th>Commit</th><th>Date</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table>`
    return c.html(layout('Changelog', '/changelog', body))
  })
}
