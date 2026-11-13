import { newId } from '../lib/env.js'
import { UpstreamError } from './index.js'

export function convertOpenAIToAnthropicParams(params: Record<string, any>): Record<string, any> {
  const systemMsgs: string[] = []
  const rawMessages: any[] = []

  for (const msg of params.messages || []) {
    if (msg.role === 'system' || msg.role === 'developer') {
      if (typeof msg.content === 'string') {
        systemMsgs.push(msg.content)
      } else if (Array.isArray(msg.content)) {
        systemMsgs.push(msg.content.map((c: any) => c.text || '').join('\n'))
      }
    } else if (msg.role === 'user') {
      rawMessages.push({ role: 'user', content: msg.content })
    } else if (msg.role === 'assistant') {
      const contentBlocks: any[] = []
      if (msg.content) {
        contentBlocks.push({ type: 'text', text: msg.content })
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let input = tc.function?.arguments
          if (typeof input === 'string') {
            try {
              input = JSON.parse(input)
            } catch (_) {
              input = {}
            }
          }
          contentBlocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function?.name,
            input: input || {},
          })
        }
      }
      rawMessages.push({
        role: 'assistant',
        content: contentBlocks.length > 0 ? contentBlocks : msg.content || '',
      })
    } else if (msg.role === 'tool') {
      rawMessages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          },
        ],
      })
    }
  }

  // Merge adjacent messages with the same role for Anthropic compliance
  const mergedMessages: any[] = []
  for (const m of rawMessages) {
    if (mergedMessages.length > 0 && mergedMessages[mergedMessages.length - 1].role === m.role) {
      const prev = mergedMessages[mergedMessages.length - 1]
      const prevContent = Array.isArray(prev.content) ? prev.content : [{ type: 'text', text: String(prev.content) }]
      const currContent = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }]
      prev.content = [...prevContent, ...currContent]
    } else {
      mergedMessages.push(m)
    }
  }

  let anthropicTools: any[] | undefined
  if (Array.isArray(params.tools) && params.tools.length > 0) {
    anthropicTools = params.tools.map((t: any) => {
      const fn = t.function || t
      return {
        name: fn.name,
        description: fn.description || '',
        input_schema: fn.parameters || { type: 'object', properties: {} },
      }
    })
  }

  const max_tokens = params.max_tokens ?? params.max_completion_tokens ?? 4096

  return {
    model: params.model,
    messages: mergedMessages,
    max_tokens,
    ...(systemMsgs.length > 0 ? { system: systemMsgs.join('\n\n') } : {}),
    ...(anthropicTools ? { tools: anthropicTools } : {}),
    ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
  }
}

export async function callAnthropicChat({
  apiKey,
  params,
}: {
  apiKey: string
  params: Record<string, any>
}): Promise<{
  content: string
  prompt_tokens: number
  completion_tokens: number
  tool_calls?: any[]
  raw?: any
}> {
  const payload = convertOpenAIToAnthropicParams(params)
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const errBody = await res.json().catch(() => null)
    const msg = errBody?.error?.message || `Anthropic upstream error: ${res.statusText || res.status}`
    throw new UpstreamError(msg, res.status, errBody || { error: { message: msg, type: 'upstream', code: res.status } })
  }

  const data: any = await res.json()
  let contentText = ''
  let toolCalls: any[] | undefined

  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block.type === 'text') {
        contentText += block.text || ''
      } else if (block.type === 'tool_use') {
        if (!toolCalls) toolCalls = []
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
          },
        })
      }
    }
  }

  const prompt_tokens = data.usage?.input_tokens ?? 0
  const completion_tokens = data.usage?.output_tokens ?? 0

  return {
    content: contentText,
    prompt_tokens,
    completion_tokens,
    tool_calls: toolCalls,
    raw: data,
  }
}

export async function callAnthropicStream({
  apiKey,
  params,
}: {
  apiKey: string
  params: Record<string, any>
}): Promise<Response> {
  const payload = convertOpenAIToAnthropicParams(params)
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...payload, stream: true }),
  })

  if (!res.ok) {
    const errBody = await res.json().catch(() => null)
    const msg = errBody?.error?.message || `Anthropic stream error: ${res.statusText || res.status}`
    throw new UpstreamError(msg, res.status, errBody || { error: { message: msg, type: 'upstream', code: res.status } })
  }

  if (!res.body) {
    throw new UpstreamError('No stream body from Anthropic', 500)
  }

  const upstreamReader = res.body.getReader()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  let buffer = ''
  let id = `chatcmpl-anthropic-${newId()}`
  const created = Math.floor(Date.now() / 1000)
  const model = params.model || 'claude'
  let promptTokens = 0
  let completionTokens = 0

  const stream = new ReadableStream({
    async start(controller) {
      let currentEventType = ''

      const sendChunk = (obj: any) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
      }

      while (true) {
        const { done, value } = await upstreamReader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) {
            currentEventType = ''
            continue
          }
          if (trimmed.startsWith('event: ')) {
            currentEventType = trimmed.slice(7).trim()
            continue
          }
          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.slice(6).trim()
            if (!dataStr) continue
            try {
              const data = JSON.parse(dataStr)
              const evt = currentEventType || data.type

              if (evt === 'message_start' && data.message) {
                if (data.message.id) id = `chatcmpl-${data.message.id}`
                if (data.message.usage?.input_tokens) promptTokens = data.message.usage.input_tokens
                sendChunk({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
                })
              } else if (evt === 'content_block_start' && data.content_block?.type === 'tool_use') {
                sendChunk({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: data.index ?? 0,
                            id: data.content_block.id,
                            type: 'function',
                            function: {
                              name: data.content_block.name,
                              arguments: '',
                            },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                })
              } else if (evt === 'content_block_delta') {
                if (data.delta?.type === 'text_delta') {
                  sendChunk({
                    id,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    choices: [{ index: 0, delta: { content: data.delta.text }, finish_reason: null }],
                  })
                } else if (data.delta?.type === 'input_json_delta') {
                  sendChunk({
                    id,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              index: data.index ?? 0,
                              function: { arguments: data.delta.partial_json },
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  })
                }
              } else if (evt === 'message_delta') {
                if (data.usage?.output_tokens) completionTokens = data.usage.output_tokens
                const stopReason = data.delta?.stop_reason
                const finish_reason =
                  stopReason === 'end_turn'
                    ? 'stop'
                    : stopReason === 'tool_use'
                    ? 'tool_calls'
                    : stopReason === 'max_tokens'
                    ? 'length'
                    : 'stop'

                sendChunk({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{ index: 0, delta: {}, finish_reason }],
                })
                sendChunk({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [],
                  usage: {
                    prompt_tokens: promptTokens,
                    completion_tokens: completionTokens,
                    total_tokens: promptTokens + completionTokens,
                  },
                })
              } else if (evt === 'message_stop') {
                controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              }
            } catch (_) {}
          }
        }
      }

      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
