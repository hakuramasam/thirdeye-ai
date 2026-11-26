/** MCP (Model Context Protocol) client for autonomous-agent tool calling. */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { assertPublicUrl } from '../lib/ssrf.js'
import { env } from '../lib/env.js'

export type McpAuthProvider = 'agentmail' | 'cloudflare'
export type McpServerConfig = {
  name: string
  url: string
  /** Non-secret headers only. Prefer auth references for supported platform MCP servers. */
  headers?: Record<string, string>
  /** Resolves a platform credential from runtime environment; never store its value in the DB. */
  auth?: { provider: McpAuthProvider }
  /** Exact remote tool names to expose. Omitted means all discovered tools. */
  allowedTools?: string[]
}

export type OpenAiTool = {
  type: 'function'
  function: { name: string; description: string; parameters: any }
}

export type McpTools = {
  tools: OpenAiTool[]
  /** Execute a namespaced tool (mcp_<server>_<tool>) and return its text content. */
  call(toolName: string, args: Record<string, unknown>): Promise<string>
  close(): Promise<void>
  /** Per-server connection failures (server skipped, rest still usable). */
  errors: string[]
}

/**
 * Allowlist comes from env so a self-hosted MCP server can be permitted explicitly, and can
 * be injected by callers (tests) instead of mutating process env.
 */
function mcpPolicy(allowHosts?: string[]) {
  return { allowHosts: allowHosts ?? env.mcpAllowedHosts }
}

/**
 * Resolve a supported platform credential without persisting it in agent configuration.
 * Credentials are bound to the vendor's official hostname and authentication header so a
 * database-controlled URL cannot exfiltrate a runtime secret to an arbitrary MCP server.
 */
export function resolveMcpHeaders(
  srv: McpServerConfig,
  environment: Record<string, string | undefined> = process.env
): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...(srv.headers ?? {}) }
  if (!srv.auth) return Object.keys(headers).length ? headers : undefined

  const policy = srv.auth.provider === 'agentmail'
    ? { host: 'mcp.agentmail.to', envName: 'AGENTMAIL_API_KEY', header: 'x-api-key', format: (value: string) => value }
    : { host: 'mcp.cloudflare.com', envName: 'CLOUDFLARE_API_TOKEN', header: 'Authorization', format: (value: string) => `Bearer ${value}` }

  let url: URL
  try {
    url = new URL(srv.url)
  } catch {
    throw new Error(`MCP auth for '${srv.name}' requires a valid HTTPS URL`)
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== policy.host) {
    throw new Error(`MCP auth provider '${srv.auth.provider}' is restricted to https://${policy.host}/`)
  }
  if (Object.keys(headers).some((name) => name.toLowerCase() === policy.header.toLowerCase())) {
    throw new Error(`MCP auth header '${policy.header}' must come from the runtime secret reference, not agent configuration`)
  }
  const secret = String(environment[policy.envName] ?? '').trim()
  if (!secret) throw new Error(`MCP server '${srv.name}' requires runtime secret ${policy.envName}`)
  headers[policy.header] = policy.format(secret)
  return headers
}

function contentToText(content: any[]): string {
  const parts = (content || [])
    .map((b: any) => (b?.type === 'text' ? b.text : null))
    .filter((t: any) => typeof t === 'string')
  return parts.length ? parts.join('\n') : JSON.stringify(content)
}

/**
 * Connect to the given MCP servers (streamable HTTP) and expose their tools
 * in OpenAI tool-call format, namespaced mcp_<server>_<tool>.
 */
export async function createMcpTools(
  servers: McpServerConfig[],
  opts: { allowHosts?: string[] } = {}
): Promise<McpTools> {
  const tools: OpenAiTool[] = []
  const errors: string[] = []
  const clients: { client: Client; serverName: string; toolName: string; url: string }[] = []

  await Promise.all(
    servers.map(async (srv) => {
      const safeName = String(srv.name || '').replace(/[^a-zA-Z0-9_-]/g, '_')
      const client = new Client({ name: `thirdeye-agent-${safeName}`, version: '1.0.0' })
      try {
        // A user-supplied MCP URL is untrusted input: refuse anything that is not a public
        // http(s) host before a socket is ever opened. Without this an agent owner could
        // point a server at cloud metadata or an internal service.
        await assertPublicUrl(srv.url, mcpPolicy(opts.allowHosts))
        const headers = resolveMcpHeaders(srv)
        if (srv.allowedTools !== undefined) {
          if (!Array.isArray(srv.allowedTools) || srv.allowedTools.some((name) => typeof name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(name))) {
            throw new Error('allowedTools must contain exact tool names using letters, numbers, underscores or hyphens')
          }
        }
        const allowedTools = srv.allowedTools === undefined ? null : new Set(srv.allowedTools)
        const transport = new StreamableHTTPClientTransport(new URL(srv.url), {
          requestInit: headers ? { headers } : undefined,
        })
        await client.connect(transport)
        const res = await client.listTools()
        for (const t of res.tools || []) {
          if (allowedTools && !allowedTools.has(t.name)) continue
          const fullName = `mcp_${safeName}_${t.name}`
          tools.push({
            type: 'function',
            function: {
              name: fullName,
              description: t.description || `Tool ${t.name} on MCP server ${safeName}`,
              parameters: t.inputSchema || { type: 'object', properties: {} },
            },
          })
          clients.push({ client, serverName: safeName, toolName: t.name, url: srv.url })
        }
      } catch (e: any) {
        errors.push(`mcp server '${srv.name}' (${srv.url}): ${String(e?.message || e).slice(0, 200)}`)
        try { await client.close() } catch { /* ignore */ }
      }
    })
  )

  return {
    tools,
    errors,
    async call(toolName: string, args: Record<string, unknown>): Promise<string> {
      const entry = clients.find((c) => `mcp_${c.serverName}_${c.toolName}` === toolName)
      if (!entry) throw new Error(`Unknown MCP tool: ${toolName}`)
      // Re-resolve before every call: a connection can outlive a DNS record, and this is
      // where a rebinding attempt would have to show up.
      await assertPublicUrl(entry.url, mcpPolicy(opts.allowHosts))
      const res = await entry.client.callTool({ name: entry.toolName, arguments: args ?? {} })
      // zod-parsed results land in structuredContent; older servers in content.
      const structured = (res as any).structuredContent
      if (structured && Object.keys(structured).length) return JSON.stringify(structured)
      return contentToText((res as any).content)
    },
    async close(): Promise<void> {
      await Promise.all(
        [...new Set(clients.map((c) => c.client))].map((c) => c.close().catch(() => {}))
      )
    },
  }
}
