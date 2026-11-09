/**
 * Langfuse tracing for agent runs.
 *
 * Written as a tiny OTLP/HTTP exporter rather than pulling in an SDK: we already intend to
 * speak OpenTelemetry, and this keeps the dependency tree (and the bundle) honest. The exporter
 * is fire-and-forget and can never break a run: a tracing outage must not fail a paid request.
 */

export type LangfuseConfig = { publicKey: string; secretKey: string; baseUrl: string }

export function langfuseConfig(input: NodeJS.ProcessEnv = process.env): LangfuseConfig | null {
  const publicKey = input.LANGFUSE_PUBLIC_KEY || ''
  const secretKey = input.LANGFUSE_SECRET_KEY || ''
  if (!publicKey || !secretKey) return null
  return {
    publicKey,
    secretKey,
    baseUrl: (input.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com').replace(/\/+$/, ''),
  }
}

export function langfuseConfigured(input: NodeJS.ProcessEnv = process.env): boolean {
  return langfuseConfig(input) !== null
}

export type AgentRunSpan = {
  traceId: string
  spanId: string
  name: string
  startMs: number
  endMs: number
  attributes: Record<string, string | number | boolean>
}

const hex = (n: number) => n.toString(16).padStart(2, '0')

/** A trace id must be 32 hex chars, a span id 16. Deterministic from a run id so retries collapse. */
export function traceIdFrom(runId: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < runId.length; i++) {
    h1 = (h1 ^ runId.charCodeAt(i)) * 16777619 >>> 0
    h2 = (h2 + runId.charCodeAt(i) * (i + 7)) * 2654435761 >>> 0
  }
  return [h1, h2, h1 ^ h2, h1 + h2].map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('').slice(0, 32)
}

export function spanIdFrom(runId: string): string {
  return traceIdFrom(`${runId}:span`).slice(0, 16)
}

/**
 * Build the OTLP payload. Pure, so the shape is testable without a network call.
 * Values are wrapped per the OTLP JSON convention (stringValue, intValue, boolValue).
 */
export function buildOtlpPayload(span: AgentRunSpan, serviceName = 'thirdeye-ai') {
  // Langfuse maps namespaced attributes onto first-class fields; plain keys are kept too so
  // nothing is lost if the mapping changes. Anything not recognised lands in observation
  // metadata only when it carries the langfuse.observation.metadata. prefix.
  const namespaced: Array<[string, string | number | boolean]> = Object.entries(span.attributes).flatMap(
    ([key, value]) => [
      [key, value] as [string, any],
      [`langfuse.observation.metadata.${key.replace(/[^a-zA-Z0-9_]/g, '_')}`, value] as [string, any],
    ]
  )
  const attributes = namespaced.map(([key, value]) => ({
    key,
    value:
      typeof value === 'number'
        ? { intValue: String(Math.round(value)) }
        : typeof value === 'boolean'
          ? { boolValue: value }
          : { stringValue: String(value) },
  }))
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
        scopeSpans: [
          {
            scope: { name: 'thirdeye-ai.agent' },
            spans: [
              {
                traceId: span.traceId,
                spanId: span.spanId,
                name: span.name,
                kind: 1, // SPAN_KIND_INTERNAL
                startTimeUnixNano: String(span.startMs * 1_000_000),
                endTimeUnixNano: String(span.endMs * 1_000_000),
                attributes,
                status: { code: span.attributes['agent.status'] === 'error' ? 2 : 1 },
              },
            ],
          },
        ],
      },
    ],
  }
}

/** Export one span. Never throws; returns whether Langfuse accepted it. */
export async function emitAgentRunSpan(
  span: AgentRunSpan,
  config: LangfuseConfig | null = langfuseConfig()
): Promise<boolean> {
  if (!config) return false
  try {
    const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64')
    const res = await fetch(`${config.baseUrl}/api/public/otel/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
      body: JSON.stringify(buildOtlpPayload(span)),
      signal: AbortSignal.timeout(5000),
    })
    return res.ok
  } catch {
    return false
  }
}
