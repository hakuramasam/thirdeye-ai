import { one } from '../db/index.js'
import { decryptSecret, env } from '../lib/env.js'
import type { ModelRow } from '../lib/pricing.js'
import type { UserRow } from '../lib/types.js'
import { callAnthropicChat, callAnthropicStream } from './anthropic.js'
import { callMockChat, callMockStream } from './mock.js'
import { callOpenAIChat, callOpenAIStream } from './openai.js'

export class UpstreamError extends Error {
  status: number
  payload: any

  constructor(message: string, status: number = 500, payload?: any) {
    super(message)
    this.name = 'UpstreamError'
    this.status = status
    this.payload = payload ?? {
      error: { message, type: status === 402 ? 'billing' : 'upstream', code: status },
    }
  }
}

export type ProviderCall = {
  model: ModelRow
  byok: boolean
  call(params: Record<string, any>): Promise<{
    content: string
    prompt_tokens: number
    completion_tokens: number
    tool_calls?: any[]
    raw?: any
  }>
  stream(params: Record<string, any>): Promise<Response>
}

// 30-second TTL cache for getModelRow
const modelCache = new Map<string, { row: ModelRow | null; expiresAt: number }>()

export async function getModelRow(modelName: string): Promise<ModelRow | null> {
  const now = Date.now()
  const cached = modelCache.get(modelName)
  if (cached && now < cached.expiresAt) {
    return cached.row
  }

  const row = await one('SELECT * FROM models_catalog WHERE model = $1', [modelName])
  modelCache.set(modelName, { row, expiresAt: now + 30000 })
  return row
}

export function deriveProviderName(model: ModelRow): string {
  if (model.provider === 'openai' || model.provider === 'anthropic' || model.provider === 'mock') {
    return model.provider
  }
  if (model.base_url) {
    try {
      const url = new URL(model.base_url.startsWith('http') ? model.base_url : `https://${model.base_url}`)
      let host = url.hostname.toLowerCase()
      host = host.replace(/^api\./, '').replace(/\.[a-z]+$/, '')
      return host
    } catch (_) {
      return model.provider
    }
  }
  return model.provider
}

export async function resolveProvider(user: UserRow, model: ModelRow): Promise<ProviderCall> {
  const providerName = deriveProviderName(model)

  // Look up BYOK key for this user & provider
  const byokRow = await one('SELECT * FROM byok_keys WHERE user_id = $1 AND provider = $2', [user.id, providerName])

  let byok = false
  let apiKey = ''

  if (byokRow) {
    byok = true
    try {
      apiKey = decryptSecret(byokRow.key_ciphertext)
    } catch (_) {
      apiKey = ''
    }
  } else {
    byok = false
    if (model.provider === 'mock') {
      apiKey = ''
    } else {
      apiKey = env.providerKeys[providerName] || ''
      if (!apiKey) {
        throw new UpstreamError(
          `No API key available for provider ${providerName}. Add one in the dashboard (BYOK) or use a model the platform brokers.`,
          402,
          {
            error: {
              message: `No API key available for provider ${providerName}. Add one in the dashboard (BYOK) or use a model the platform brokers.`,
              type: 'billing',
              code: 402,
            },
          }
        )
      }
    }
  }

  return {
    model,
    byok,
    async call(params: Record<string, any>) {
      const p = { ...params, model: model.upstream_model }
      if (model.provider === 'mock') {
        return callMockChat(p)
      }
      if (model.provider === 'anthropic') {
        return callAnthropicChat({ apiKey, params: p })
      }
      return callOpenAIChat({ baseUrl: model.base_url, apiKey, params: p })
    },
    async stream(params: Record<string, any>) {
      const p = { ...params, model: model.upstream_model }
      if (model.provider === 'mock') {
        return callMockStream(p)
      }
      if (model.provider === 'anthropic') {
        return callAnthropicStream({ apiKey, params: p })
      }
      return callOpenAIStream({ baseUrl: model.base_url, apiKey, params: p })
    },
  }
}
