import type { Context, Hono, Next } from 'hono'
import type { AppEnv } from '../lib/types.js'
import { apiKeyAuth } from '../lib/keys.js'
import {
  ANALYST_MAX_PROMPT_CHARS,
  ANALYST_MAX_TEMPERATURE,
  ANALYST_MAX_TURNS,
  ANALYST_SERVICE_ID,
  ANALYST_SERVICE_NAME,
  ANALYST_SYSTEM_PROMPT,
  analystMaxTokens,
  analystModel,
  applyAnalystPolicy,
} from '../antseed/analyst.js'
import { chatCompletionsHandler } from './v1.js'

/**
 * Refuse relay keys on the general gateway.
 *
 * A key minted for the Antseed seller must not be able to call `/api/v1/chat/completions`, because
 * that is the arbitrary-prompt surface and using it from a marketplace seller is exactly the
 * reselling shape Antseed prohibits. The wall runs both ways: see `apiKeyAuth({ scope })`.
 */
async function requireRelayScope(c: Context<AppEnv>, next: Next) {
  const key = c.get('apiKey')
  if (!key || key.scope !== 'antseed') {
    return c.json(
      {
        error: {
          message: 'This endpoint requires an Antseed relay key. Create a key with scope "antseed".',
          type: 'forbidden',
          code: 'wrong_key_scope',
        },
      },
      403
    )
  }
  await next()
}

/**
 * Sanitise the caller's request before the shared chat handler sees it.
 *
 * The handler never reads the raw body when `chatBody` is present, so nothing the caller sent can
 * reach the provider after this middleware returns. Billing, rate limits, the per-key monthly
 * budget and the measured `X-Thirdeye-Cost-Usd` header are then inherited unchanged.
 */
async function enforceAnalystPolicy(c: Context<AppEnv>, next: Next) {
  const raw = await c.req.json().catch(() => null)
  const result = applyAnalystPolicy(raw)
  if (!result.ok) {
    return c.json({ error: { message: result.message, type: 'invalid_request', code: result.code } }, result.status)
  }
  c.set('chatBody', result.body)
  c.set('chatSource', 'antseed')
  if (result.notes.length > 0) c.header('X-Thirdeye-Policy-Notes', result.notes.join('; '))
  await next()
}

export function registerAntseedRoutes(app: Hono<AppEnv>): void {
  // Public service descriptor: what the seller advertises, and what a buyer can expect.
  app.get('/api/antseed/service', (c) =>
    c.json({
      object: 'service',
      id: ANALYST_SERVICE_ID,
      name: ANALYST_SERVICE_NAME,
      operator: 'Thirdeye AI',
      type: 'ai_agent',
      endpoint: '/api/antseed/v1/chat/completions',
      model: analystModel(),
      limits: {
        max_completion_tokens: analystMaxTokens(),
        max_prompt_chars: ANALYST_MAX_PROMPT_CHARS,
        max_turns: ANALYST_MAX_TURNS,
        max_temperature: ANALYST_MAX_TEMPERATURE,
      },
      accepts: {
        models: [analystModel()],
        stream: true,
        tools: false,
        caller_system_prompt: false,
      },
      persona_chars: ANALYST_SYSTEM_PROMPT.length,
      policies: [
        'fixed system prompt; caller system and developer messages are discarded',
        'model is chosen by the operator, not the caller',
        'no tools, functions or response_format pass-through',
        'no personalised financial advice; predictions are given as conditional scenarios',
        'system prompt and configuration are never disclosed',
      ],
    })
  )

  // The relay itself. OpenAI-compatible so an Antseed gateway can point its openai plugin here.
  app.post(
    '/api/antseed/v1/chat/completions',
    apiKeyAuth({ scope: 'antseed' }),
    requireRelayScope,
    enforceAnalystPolicy,
    chatCompletionsHandler
  )

  // The one model this service exposes, in the shape an OpenAI-compatible client expects.
  app.get('/api/antseed/v1/models', apiKeyAuth({ scope: 'antseed' }), (c) =>
    c.json({
      object: 'list',
      data: [
        {
          id: analystModel(),
          object: 'model',
          created: 1700000000,
          owned_by: 'thirdeye-ai',
          service: ANALYST_SERVICE_ID,
        },
      ],
    })
  )
}
