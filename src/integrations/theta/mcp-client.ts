import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ThetaConfig } from './config.js'
import { assertThetaCredentials } from './config.js'

export type ThetaReadTool = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

type ThetaSession = {
  connect(): Promise<void>
  listTools(): Promise<{ tools: ThetaReadTool[] }>
  callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<unknown>
  close(): Promise<void>
}

export type ThetaToolFactory = (url: URL, headers: Record<string, string>) => ThetaSession

const READ_ONLY_NAME = /(?:^|[_-])(list|listmodels|models|resources|templates|nodes|node|describe|inspect|status|logs|events|balance|usage|billing|pricing|prices|result|results)(?:$|[_-])/i
const WRITE_NAME = /(create|start|stop|restart|delete|remove|update|deploy|launch|terminate|destroy|resize|attach|detach|write|submit|execute|run|generate|transcribe|inference|completion|chat)/i

function defaultFactory(url: URL, headers: Record<string, string>): ThetaSession {
  const client = new Client({ name: 'thirdeye-theta-readonly', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
  })
  return {
    connect: () => client.connect(transport),
    listTools: () => client.listTools(),
    callTool: (args) => client.callTool(args),
    close: () => client.close(),
  }
}

/**
 * Narrow hosted-MCP facade. It never exposes mutating tools or billable inference execution.
 * The owner must separately approve any paid inference test or GPU lifecycle operation.
 */
export class ThetaReadOnlyMcpClient {
  private session: ThetaSession | null = null
  private readonly allowed = new Map<string, ThetaReadTool>()

  constructor(
    private readonly config: ThetaConfig,
    private readonly factory: ThetaToolFactory = defaultFactory,
  ) {}

  async connect(): Promise<ThetaReadTool[]> {
    if (!this.config.projectApiKey && !this.config.inferenceApiKey) {
      throw new Error('Theta read-only credentials are not configured')
    }
    const headers: Record<string, string> = {}
    if (this.config.projectApiKey) headers['x-api-key'] = this.config.projectApiKey
    if (this.config.inferenceApiKey) headers.Authorization = `Bearer ${this.config.inferenceApiKey}`

    const session = this.factory(new URL('/mcp', this.config.controllerBaseUrl), headers)
    try {
      await session.connect()
      const listed = await session.listTools()
      const safe = (listed.tools || []).filter((tool) => {
        const name = String(tool.name || '')
        if (!name || WRITE_NAME.test(name) || !READ_ONLY_NAME.test(name)) return false
        this.allowed.set(name, tool)
        return true
      })
      this.session = session
      return safe
    } catch (error) {
      await session.close().catch(() => undefined)
      this.allowed.clear()
      throw new Error('Theta read-only MCP connection failed')
    }
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.session || !this.allowed.has(name)) {
      throw new Error('Theta tool is not available in read-only mode')
    }
    // Project identity is pinned by server configuration, never supplied by an agent.
    const safeArgs = { ...args }
    const schema = this.allowed.get(name)?.inputSchema as { properties?: Record<string, unknown> } | undefined
    if ('project_id' in safeArgs || 'projectId' in safeArgs) {
      throw new Error('Theta project identity is controlled by server configuration')
    }
    if (schema?.properties && Object.prototype.hasOwnProperty.call(schema.properties, 'project_id')) {
      safeArgs.project_id = this.config.projectId
    }
    return this.session.callTool({ name, arguments: safeArgs })
  }

  async close(): Promise<void> {
    const current = this.session
    this.session = null
    this.allowed.clear()
    if (current) await current.close()
  }

  describe(): { controllerOrigin: string; projectId: string; connected: boolean; exposedToolCount: number } {
    return {
      controllerOrigin: this.config.controllerBaseUrl,
      projectId: this.config.projectId,
      connected: Boolean(this.session),
      exposedToolCount: this.allowed.size,
    }
  }
}
