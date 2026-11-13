import { newId } from '../lib/env.js'

export async function callMockChat(params: Record<string, any>): Promise<{
  content: string
  prompt_tokens: number
  completion_tokens: number
  tool_calls?: any[]
  raw?: any
}> {
  const messages = params.messages || []
  const lastUserMsg = [...messages].reverse().find((m: any) => m.role === 'user')?.content || ''
  const content = `MOCK: ${lastUserMsg} (mock provider echo)`
  const promptTokens = Math.max(1, Math.ceil(JSON.stringify(messages).length / 4))
  const completionTokens = 7

  let toolCalls: any[] | undefined
  const hasWeather = /weather/i.test(lastUserMsg)
  if (hasWeather && Array.isArray(params.tools) && params.tools.length > 0) {
    const firstTool = params.tools[0]
    const fnName = firstTool.function?.name || firstTool.name || 'get_weather'
    toolCalls = [
      {
        id: `call_${newId()}`,
        type: 'function',
        function: {
          name: fnName,
          arguments: JSON.stringify({ location: 'Yangon' }),
        },
      },
    ]
  }

  const raw = {
    id: `chatcmpl-mock-${newId()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: params.model || 'thirdeye-mock',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }

  return {
    content,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    tool_calls: toolCalls,
    raw,
  }
}

export async function callMockStream(params: Record<string, any>): Promise<Response> {
  const messages = params.messages || []
  const lastUserMsg = [...messages].reverse().find((m: any) => m.role === 'user')?.content || ''
  const content = `MOCK: ${lastUserMsg} (mock provider echo)`
  const promptTokens = Math.max(1, Math.ceil(JSON.stringify(messages).length / 4))
  const completionTokens = 7

  const model = params.model || 'thirdeye-mock'
  const id = `chatcmpl-mock-${newId()}`
  const created = Math.floor(Date.now() / 1000)

  const len = content.length
  const p1 = Math.ceil(len / 3)
  const p2 = Math.ceil((2 * len) / 3)
  const chunk1Text = content.slice(0, p1)
  const chunk2Text = content.slice(p1, p2)
  const chunk3Text = content.slice(p2)

  const chunks = [
    JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: chunk1Text }, finish_reason: null }],
    }),
    JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { content: chunk2Text }, finish_reason: null }],
    }),
    JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { content: chunk3Text }, finish_reason: 'stop' }],
    }),
    JSON.stringify({
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
    }),
  ]

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${chunk}\n\n`))
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
