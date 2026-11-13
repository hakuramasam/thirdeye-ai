/**
 * The whitepaper, rendered as a public page so it has a stable URL on the project's own domain
 * (BaseScan and exchange listing forms ask for one).
 *
 * Discipline for this file: every number that can be checked onchain or over HTTP is stated with
 * the way to check it, and nothing that is a plan is written as if it were shipped. Where an
 * earlier internal document disagrees with the deployed contract, the contract wins.
 */

export const WHITEPAPER = `
<h1>Thirdeye AI: pay-per-call inference for autonomous software</h1>
<p class="lead">Whitepaper, version 1.0, 13 November 2026. This describes the platform as it is
deployed. Where a claim can be verified onchain or with a single HTTP request, the verification
path is named beside it. Anything not yet built is filed under Roadmap and labelled.</p>

<h2>Abstract</h2>
<p>Software that calls a language model today is billed the way a person is billed: a subscription
per seat, a card on file, a dashboard, a monthly invoice. None of that survives contact with an
autonomous agent. An agent needs a balance it can spend, a per-call cost it can read out of the
response, hard limits it cannot talk its way past, and a way to be charged that does not route
through a human and a credit card form.</p>
<p>Thirdeye is an OpenAI-compatible inference broker that meters every call at the point of service.
A caller authenticates with a wallet session or a platform key, the request is proxied to a
third-party model provider, the billed cost of that call returns in a response header, and the amount
is debited from a prepaid stablecoin balance. There is no seat, no minimum and no monthly commitment.
The platform also issues agent identities, exposes model context protocol (MCP) tooling to the agents
it runs, and speaks x402 so an agent can settle a call over HTTP without an account at all.</p>

<h2>1. The problem we are solving</h2>
<p>Three failures recur whenever software, rather than a person, is the customer.</p>
<h3>Billing is priced per human</h3>
<p>Per-seat pricing assumes a stable count of people and predictable monthly volume. Agent work is
bursty and metered in tokens: idle for six days, then four hundred calls on the seventh. A seat price
either overcharges the idle week or bankrupts the busy one.</p>
<h3>Payment rails assume a card and a person</h3>
<p>A card needs a name, an expiry, a billing address and a verification step. An agent has a key and
a balance. Every card-gated signup is a wall autonomous software cannot climb without a human
stopping what they are doing to help it.</p>
<h3>Cost is invisible until the invoice</h3>
<p>When the caller cannot see what a call cost until the end of the month, it cannot decide whether to
make the call. Retries, loops and runaway tool chains are discovered in arrears. The cost has to
travel with the response, at the moment of the decision.</p>

<h2>2. Protocol overview</h2>
<p>Thirdeye sits between a caller and one or more model providers. It presents the OpenAI chat
completions interface, so an existing client changes one field: the base URL.</p>
<div class="grid">
  <div class="card"><h3>Interface</h3><p><code>POST /api/v1/chat/completions</code> and <code>GET /api/v1/models</code>, with streaming and tool calling.</p></div>
  <div class="card"><h3>Identity</h3><p>A wallet session (Sign-In With Ethereum) or a platform API key issued to the account.</p></div>
  <div class="card"><h3>Money</h3><p>A prepaid balance funded in USDC on Base, debited per call, readable per response.</p></div>
  <div class="card"><h3>Supply</h3><p>Models brokered through provider keys held by the platform, or supplied by the caller with bring-your-own-key.</p></div>
</div>

<h2>3. The request path</h2>
<p>One call, in the order the money is decided. Each step exists because skipping it produced a wrong
ledger at some point in this platform's history.</p>
<table><thead><tr><th>Step</th><th>What happens</th><th>Why it is there</th></tr></thead><tbody>
<tr><td>1. Authenticate</td><td>The key or session is resolved to an account and a key row.</td><td>Every later debit needs an owner, not just a caller.</td></tr>
<tr><td>2. Authorise</td><td>The model is checked against the catalogue, and the key against its own budget and status.</td><td>A revoked key and an unlisted model are refused before any provider is paid.</td></tr>
<tr><td>3. Admit</td><td>The request is admitted against an invocation-wide deadline and a rate budget.</td><td>A provider that never answers must not become an unbounded charge.</td></tr>
<tr><td>4. Proxy</td><td>The call goes to the provider, streaming through to the caller where streaming was asked for.</td><td>Time to first token is the caller's problem, not ours: we do not buffer.</td></tr>
<tr><td>5. Meter</td><td>Token usage is read from the response, priced, and written to the run record.</td><td>An unpriced call is a free call, and a free call is a bug.</td></tr>
<tr><td>6. Debit</td><td>The balance is reduced and the billed cost returns in <code>x-thirdeye-cost-usd</code>.</td><td>The caller learns what the call cost before deciding to make another.</td></tr>
<tr><td>7. Record</td><td>An append-only audit event captures the call, its cost and its outcome.</td><td>A failed run that was still charged has to be reconcilable.</td></tr>
</tbody></table>
<p>Providers fail, so the broker treats a provider error as a routing problem rather than a dead end:
rate limits and transient failures are retried under the same deadline and counted once. A call that
exhausts its deadline closes through the same accounting path as a successful one, because the
provider has already been paid for the tokens it produced.</p>

<h2>4. Accounts, credit and settlement</h2>
<p>An account is created by connecting a wallet. Balances are denominated in credit, and one credit
is one US dollar of consumption, stored in micros so that a call costing a fraction of a cent is
representable.</p>
<h3>Deposits</h3>
<p>Deposits are made in USDC on Base and are verified onchain before credit is granted. A deposit is a
liability, not revenue: the platform owes inference against it. Every user sees their own balance,
and no public page publishes balances, user counts or traffic.</p>
<h3>Keys and budgets</h3>
<p>An account can hold several keys, and a key can carry its own budget and rate limit. This exists
for the same reason the per-call cost header exists: the entity making the spending decision should
be the entity that cannot exceed it. Revoking a key stops new calls immediately while leaving its
spend history intact, so the ledger does not change shape when a key is retired.</p>
<h3>Bring your own key</h3>
<p>A caller may supply their own provider credentials. In that mode the provider bills the caller
directly and the platform charges for brokering rather than for the tokens, so a high-volume customer
does not pay the platform's margin on inference they could buy themselves.</p>

<h2>5. Model supply</h2>
<p>The catalogue is not a fixed list in a document; it is what the platform can currently serve,
published at <code>/api/v1/models</code> with per-million-token list prices attached. That endpoint is
the authority, and this page deliberately does not repeat its contents, because a stale price in a
PDF is a promise the code no longer keeps.</p>
<p>Today that catalogue is served from provider relationships on free or metered tiers, dominated by
open-weight models plus a hosted frontier family. The design assumption is that model supply is
replaceable: the broker's job is to know which provider is healthy, price the call correctly, and
fail over when one is not.</p>

<h2>6. Agents as first-class callers</h2>
<p>An ordinary API key proves that an account may spend. It does not say who is calling. For software
that transacts with other software, identity has to be a first-class object.</p>
<h3>Agent identities</h3>
<p><code>POST /api/v1/agents/register</code> mints an agent identity and one key, shown once. The
identity carries a name, a description, capabilities and a homepage, and appears in a public directory
at <code>/agents</code>. Owner accounts and spend are never published there. An agent key is an
ordinary platform key on the inference endpoints but is refused on the identity endpoints, so an agent
cannot mint more identities than it was given.</p>
<h3>Tool use over MCP</h3>
<p>Agents can be given model context protocol servers as tools. What a server exposes is guarded on
the platform side: an agent cannot widen its own tool surface, and every tool call is recorded with
the run that made it.</p>
<h3>Agent-to-agent</h3>
<p>There is a discovery card at <code>/.well-known/agent-card.json</code> and a JSON-RPC endpoint at
<code>/a2a</code>, so an agent can be addressed as a peer rather than only used as a client.</p>
<h3>x402</h3>
<p>For callers with no account at all, a paid resource answers HTTP 402 with its price and accepts
settlement in stablecoin. This is the path for a single call from an agent that holds a wallet but no
relationship with the platform, and it is deliberately capped: an agent should not be able to spend
freely just because it can sign.</p>

<h2>7. Operating posture</h2>
<p>The platform runs a small autonomous team of agents that maintain it, and that arrangement only
works if the boundary between what they may do and what a human must approve is written down and
enforced in code.</p>
<table><thead><tr><th>Principle</th><th>How it is enforced</th></tr></thead><tbody>
<tr><td>Agents do not merge or deploy</td><td>Agent write access produces a branch and a pull request through <code>src/agents/repo-write.ts</code>, which refuses money paths, credential files and path traversal before any commit is made.</td></tr>
<tr><td>Money and schema changes escalate</td><td>Billing, settlement, key and schema paths sit outside the agent allowlist and require a human.</td></tr>
<tr><td>Public pages are chosen, not leaked</td><td>The public surface is rendered in one module that selects only liveness and static history. Balances, keys, partner terms and open findings are never in its query surface.</td></tr>
<tr><td>Claims are measured</td><td>A published cost figure must come from the billed value in <code>x-thirdeye-cost-usd</code> on the production path, never from list-price arithmetic.</td></tr>
<tr><td>Charges are reconcilable</td><td>Every run writes an audit event with its spend and tool use, and a run that fails keeps its recorded cost.</td></tr>
</tbody></table>
<p>Scheduled work runs on a cron with a ledger of its own: a run that fails keeps its slot owed rather
than silently consuming the day, and a run that crashes still reports what it spent.</p>

<h2>8. The THIRDEYE token</h2>
<p>THIRDEYE exists to give the people who consume the platform a settlement unit of its own and to put
usage on a public, verifiable surface. It is not a fundraising instrument. No token was sold to fund
development, and this document is not an offer to sell one.</p>
<h3>Launch record</h3>
<p>Verified by reading the chain rather than copying a receipt.</p>
<table><thead><tr><th>Item</th><th>Value</th></tr></thead><tbody>
<tr><td>Contract</td><td><code>0xA8A65A86E01D227Dbfd7C7a94d14344b33603df5</code> on Base (chain id 8453)</td></tr>
<tr><td>Name, symbol, decimals</td><td>Thirdeye, THIRDEYE, 18</td></tr>
<tr><td>Total supply</td><td>1,000,000,000, fixed, no mint function</td></tr>
<tr><td>Launch transaction</td><td><code>0x66e65f6e49bf08a34cbc703df9ae6b2d4fd983a2a2068340a17a53b93589ead2</code>, block 56,365,145, 12 November 2026 06:03:24 UTC</td></tr>
<tr><td>Launched by</td><td><code>0xb09f37a1110a126d63463ec08a0c0b97612d90ab</code> through the launch contract <code>0x660eaaedebc968f8f3694354fa8ec0b4c5ba8d12</code></td></tr>
<tr><td>Liquidity</td><td>200,000,000 (20%) into a Uniswap v4 pool created in that transaction, with a 0.30% pool fee and the position locked</td></tr>
<tr><td>Retained supply</td><td>800,000,000 (80%) held at the token contract itself, releasable only through the contract's own release mechanism</td></tr>
<tr><td>Creator wallet</td><td>Holds 0 THIRDEYE. No founder allocation was distributed at launch.</td></tr>
<tr><td>Trading fees</td><td>Of pool fees, 95% routes to the treasury vault <code>0x73faf95b2baa23bde4ce8547b64c55159022cf0d</code> and 5% to the protocol, as encoded in the launch transaction</td></tr>
</tbody></table>
<h3>What the retained supply is for</h3>
<p>The 800,000,000 at the contract is the project's long-run budget, not circulating float. Its
purpose is to pay for what a platform like this needs and cannot fund from margin: development and
operations, community and partner programmes, promotional allocations and airdrops to users. The
binding record of how and when it can move is the contract's release schedule, not this page. A
reader who wants to know what can be released today should read the contract, because a document
cannot override it and this one does not try.</p>
<h3>What it is not</h3>
<p>It is not equity, a share of a company, a claim on the treasury, or a promise of profit. The
platform does not commit to buy it back, to support its price, or to distribute revenue in it.
Holding it confers no governance right today. It is a token for using and being paid inside one
platform, and should be treated as such.</p>

<h2>9. Disclosure</h2>
<p>A token attached to a product creates a conflict of interest, and the honest response is to say so
in the same place the token is described.</p>
<ul>
<li>Value described here is denominated in dollars, not in the token. A figure that is $X of revenue
stays $X when the token price moves.</li>
<li>Revenue, profit and token value are reported separately and never merged. Platform revenue is
billed consumption minus provider cost; the token is not counted as revenue when received, and not as
profit until swapped.</li>
<li>The platform publishes what is measurable and declines to publish what is a guess. Where a number
here disagrees with the chain or with <code>/api/v1/models</code>, they are right and this page is
wrong.</li>
</ul>

<h2>10. Roadmap</h2>
<p>Direction, not commitment. Items move; the changelog and the status page are where delivered work
is recorded.</p>
<table><thead><tr><th>Area</th><th>Direction</th></tr></thead><tbody>
<tr><td>Billing integrity</td><td>Deposit finality hardening (confirmations, reorg handling, duplicate detection), ledger invariants, and an operator discrepancy report that reconciles provider cost against billed credit.</td></tr>
<tr><td>Reliability</td><td>Model rotation when a provider rate-limits, so a scheduled run degrades to another provider instead of failing the day.</td></tr>
<tr><td>Settlement</td><td>Wider stablecoin support on Base, and a published policy rate for crediting the platform's own token as a deposit, bounded by liquidity.</td></tr>
<tr><td>Agents</td><td>Deeper identity: reputation built from measured uptime and disputes, and bounded spending policies for x402 callers.</td></tr>
<tr><td>Assurance</td><td>Provider-neutral acceptance tests run against production, and an external review of the money paths before volume grows.</td></tr>
</tbody></table>

<h2>11. Risks</h2>
<p>Stated plainly, because a whitepaper that lists only opportunity is advertising.</p>
<ul>
<li><strong>Early software.</strong> The platform is young and its money paths have been corrected more than once. Bugs can cost credit, and the ledger has needed repair before.</li>
<li><strong>Provider dependency.</strong> Inference is bought from third parties on free or metered tiers. A provider can change its limits, prices or terms, and calls will fail or cost more when it does.</li>
<li><strong>Thin market.</strong> The token's only price is what a single pool quotes against a shallow float. A price read from that pool is easy to move and is not a valuation.</li>
<li><strong>Unaudited code.</strong> Neither the platform nor the token contract has had an external audit. The token is a minimal-proxy clone launched through a launchpad factory, so its implementation and constructor arguments are what that factory chose.</li>
<li><strong>Regulatory exposure.</strong> Tokens and stablecoins sit in an unsettled legal area in most jurisdictions, and availability of any feature can change on legal advice.</li>
<li><strong>Key custody.</strong> If you deposit from an account you do not control, or attach a provider key to the platform, the failure modes are yours to reason about.</li>
</ul>

<h2>12. Verification</h2>
<p>Everything below answers without trusting this document.</p>
<table><thead><tr><th>Claim</th><th>How to check it</th></tr></thead><tbody>
<tr><td>Supply, balances, release state</td><td>Read <code>totalSupply()</code> and <code>balanceOf()</code> on basescan.org/token/0xA8A65A86E01D227Dbfd7C7a94d14344b33603df5</td></tr>
<tr><td>Launch, pool and fee routing</td><td>The launch transaction above, decoded: the pool creation, the 200,000,000 transfer and the fee split all appear in its logs.</td></tr>
<tr><td>Catalogue and prices</td><td><code>GET /api/v1/models</code>, unauthenticated and live. No stale copy is kept.</td></tr>
<tr><td>Deployed version</td><td><code>/status</code> prints the commit the running build came from and the size of the test suite at that commit.</td></tr>
<tr><td>What changed and when</td><td><code>/changelog</code>, generated from the commit history rather than written by hand.</td></tr>
<tr><td>Source</td><td>github.com/hakuramasam/thirdeye-ai</td></tr>
</tbody></table>

<h2>Colophon</h2>
<p>Written and maintained by the Thirdeye AI operating team and its platform agent, and reviewed by
the project owner before publication. This version replaces no earlier whitepaper, because there was
none. Earlier internal tokenomics drafts described a launch venue that was not the one used, and are
superseded by the launch record above.</p>
<p class="muted">Nothing here is financial, investment, legal or tax advice. Numbers describing the
deployed system were read from it; numbers describing the future are labelled as direction.
Corrections are welcome at the contact address on the site and are applied in place, with the change
recorded in the changelog rather than quietly removed.</p>
`
