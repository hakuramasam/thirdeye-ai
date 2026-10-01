/** MCP (Model Context Protocol) client for autonomous-agent tool calling. */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export type McpServerConfig = { name: string; url: string; headers?: Record<string, string> }

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
export async function createMcpTools(servers: McpServerConfig[]): Promise<McpTools> {
  const tools: OpenAiTool[] = []
  const errors: string[] = []
  const clients: { client: Client; serverName: string; toolName: string }[] = []

  await Promise.all(
    servers.map(async (srv) => {
      const safeName = String(srv.name || '').replace(/[^a-zA-Z0-9_-]/g, '_')
      const client = new Client({ name: `thirdeye-agent-${safeName}`, version: '1.0.0' })
      try {
        const transport = new StreamableHTTPClientTransport(new URL(srv.url), {
          requestInit: srv.headers ? { headers: srv.headers } : undefined,
        })
        await client.connect(transport)
        const res = await client.listTools()
        for (const t of res.tools || []) {
          const fullName = `mcp_${safeName}_${t.name}`
          tools.push({
            type: 'function',
            function: {
              name: fullName,
              description: t.description || `Tool ${t.name} on MCP server ${safeName}`,
              parameters: t.inputSchema || { type: 'object', properties: {} },
            },
          })
          clients.push({ client, serverName: safeName, toolName: t.name })
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
