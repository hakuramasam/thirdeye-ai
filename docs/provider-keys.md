# Adding a provider key

The catalogue is not a fixed list in a document; it is what the platform can currently serve.
Adding supply is meant to be a configuration change, not a code change, and this is the runbook
for it.

## How availability works

For a catalogue row, the provider name decides which environment variable is read:

1. `provider` is `openai`, `anthropic` or `mock` → the name is that value.
2. Otherwise the name is the first label of `base_url`'s hostname after stripping `api.`, reduced
   to `[a-z0-9]`.

`env.providerKeys` then loads every `PROV_<NAME>_API_KEY` in the environment, so the key
`PROV_GROQ_API_KEY` funds every catalogue row whose derived name is `groq`.

`GET /api/v1/models` reports `available` by doing exactly that lookup, and `GET /api/models` (the
dashboard) shows the same flag. A model is never listed as available because someone wrote it in
a list.

| catalogue rows | derived name | variable |
| --- | --- | --- |
| `openai` provider rows | `openai` | `PROV_OPENAI_API_KEY` |
| `anthropic` provider rows | `anthropic` | `PROV_ANTHROPIC_API_KEY` |
| `api.groq.com` | `groq` | `PROV_GROQ_API_KEY` |
| `api.mistral.ai` | `mistral` | `PROV_MISTRAL_API_KEY` |
| `api.deepseek.com` | `deepseek` | `PROV_DEEPSEEK_API_KEY` |
| `openrouter.ai` | `openrouter` | `PROV_OPENROUTER_API_KEY` |
| `generativelanguage.googleapis.com` | `generativelanguage` | `PROV_GENERATIVELANGUAGE_API_KEY` |

A host with more than one label before the TLD used to derive a dotted name that the key loader
could never match, which made a correctly configured provider look unfunded. That is fixed here;
prefer hosts whose first label is the vendor's name.

## Adding a key for a catalogued provider

1. Decide the provider. OpenAI, Anthropic and DeepSeek are already catalogued with prices, so
   nothing else is needed.
2. Create the account and fund it. OpenAI, Anthropic and DeepSeek direct all require a working
   card; there is no free-credit path for these three, so this step is the real blocker and no
   amount of code removes it.
3. Add `PROV_<NAME>_API_KEY` to the deployment environment. Do not commit it and do not paste it
   into chat or a document.
4. Redeploy so the function picks up the new environment.
5. Confirm with the catalogue: the row's `available` flips to `true`, and `auto` may start
   resolving to it if it is the cheapest. No code change, no migration.

## Adding a new OpenAI-compatible provider

The adapter is the OpenAI protocol with a per-row `base_url`, so a new vendor is a row plus a key:

```sql
INSERT INTO models_catalog
  (model, provider, upstream_model, base_url, price_in_1m_usd_micros, price_out_1m_usd_micros)
VALUES
  ('vendor-model-id', 'openai-compatible', 'vendor-model-id', 'https://api.vendor.com/v1', 100000, 300000)
ON CONFLICT (model) DO UPDATE SET
  provider = EXCLUDED.provider,
  upstream_model = EXCLUDED.upstream_model,
  base_url = EXCLUDED.base_url,
  price_in_1m_usd_micros = EXCLUDED.price_in_1m_usd_micros,
  price_out_1m_usd_micros = EXCLUDED.price_out_1m_usd_micros;
```

Prices are USD micros per million tokens. `upstream_model` is the vendor's own id and is what is
sent upstream; `model` is the public id callers use.

## OpenRouter: compatible, and deliberately not in the serving path

OpenRouter is a genuine drop-in (`https://openrouter.ai/api/v1`, bearer key, OpenAI-compatible
`/chat/completions`), so it would cost one environment variable and a handful of rows. It is
excluded anyway, for two reasons that are not about engineering:

- Their terms prohibit using the service "for purposes of reselling API access to Models or
  otherwise developing a competing service". A credits-billed OpenAI-compatible gateway is that.
- Their free variants are capped at 20 requests/minute and 50 requests/day, rising to 1,000/day
  only once 10 credits have been purchased, which cannot supply a shared platform.

It may still be reasonable for our own internal experiments on our own account. It must not sit
behind `/api/v1`.

## What this runbook does not do

Adding a key makes a model servable; it does not make it good, cheap, or contractually allowed to
resell. Check the vendor's terms and the price before the row goes in, and measure the first calls
through the production path before any price or performance claim is published.
