# Quickstart

Five minutes from an empty client to a billed response.

## 1. Get a key

Sign in with a wallet, open **API Keys**, create a key. The secret is shown once and only its
hash is stored, so copy it then or issue another one.

## 2. Point any OpenAI client at the gateway

```python
from openai import OpenAI

client = OpenAI(base_url="https://thirdeye-ai-alpha.vercel.app/api/v1", api_key="sk-thirdeye-...")

r = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Say hello in five words."}],
)
print(r.choices[0].message.content)
```

`auto` is the safe default: it resolves to the cheapest model the platform can serve at that
moment, and the response header `x-thirdeye-model-resolved` names the model that answered. A
concrete id works too, as long as the catalogue marks it available.

## 3. Check what is servable before you hardcode a model

```bash
curl https://thirdeye-ai-alpha.vercel.app/api/v1/models \
  -H "authorization: Bearer $THIRDEYE_API_KEY"
```

Each entry carries:

| field | meaning |
| --- | --- |
| `available` | the platform holds an upstream key, so the model answers on your balance |
| `byok_supported` | the model can be used with a provider key you supply instead |
| `unavailable_reason` | `no_platform_key` when it is catalogued but not currently servable |
| `provider_key_var` | the environment variable the platform would need to serve it |

Do not assume a model is servable because it appears in the list. That is exactly the mistake
that makes an integration report "this platform needs your own OpenAI key" when the platform is
in fact serving six other models fine.

## 4. Read the billed cost, not the catalogue

Every JSON response reports the measured, billed amount in `x-thirdeye-cost-usd`. On a stream,
the reserved estimate goes out up front and settles to the measured cost, and
`x-thirdeye-cost-basis` says which of the two you are looking at.

Catalogue rates in `/api/v1/models` exclude the platform margin, so arithmetic from the catalogue
understates the real charge. Quote the header.

## 5. When a model is refused

| status | code | what to do |
| --- | --- | --- |
| 402 | `model_unavailable` | retry with a model id from `available_models` in the same response, or supply your own provider key |
| 402 | `insufficient_credit` | top up with USDC on Base or USDG on Robinhood Chain |
| 402 | `budget_exceeded` | the key's monthly ceiling is spent; raise it or wait for the period to roll |
| 404 | `model_not_found` | the id is not in the catalogue at all |
| 503 | `no_model_available` | `auto` was sent and nothing is servable right now |

`model_unavailable` is not a request for your own key. It means that *one* model needs a key the
platform does not hold; the rest of the catalogue may be fine.

## 6. Bring your own key (optional)

Dashboard → BYOK. The key is stored encrypted, used only for your calls, and metered at 2% of
catalogue price instead of the full brokered rate. This is the only way to reach a model the
platform has no upstream key for.

Operators adding a platform key for a whole provider should read
[provider-keys.md](provider-keys.md).
