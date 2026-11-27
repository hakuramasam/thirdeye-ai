import test from 'node:test'
import assert from 'node:assert/strict'
import { loadThetaConfig } from '../src/integrations/theta/config.js'
import { ThetaReadOnlyMcpClient, type ThetaToolFactory } from '../src/integrations/theta/mcp-client.js'

test('exposes only read-only discovery tools and never billable or mutating actions', async () => {
  const config = loadThetaConfig({
    THETA_PROJECT_ID: 'prj_12345678',
    THETA_PROJECT_API_KEY: 'project-secret',
    THETA_ONDEMAND_API_KEY: 'inference-secret',
  })
  let capturedHeaders: Record<string, string> = {}
  let capturedUrl = ''
  const factory: ThetaToolFactory = (url, headers) => {
    capturedUrl = url.toString()
    capturedHeaders = headers
    return {
      async connect() {},
      async listTools() {
        return { tools: [
          { name: 'list_gpu_resources', inputSchema: { type: 'object', properties: {} } },
          { name: 'get_gpu_node_status', inputSchema: { type: 'object', properties: { project_id: { type: 'string' } } } },
          { name: 'list_models', inputSchema: { type: 'object', properties: {} } },
          { name: 'create_gpu_node' },
          { name: 'stop_gpu_node' },
          { name: 'run_inference' },
          { name: 'generate_image' },
        ] }
      },
      async callTool() { return { ok: true } },
      async close() {},
    }
  }
  const client = new ThetaReadOnlyMcpClient(config, factory)
  const tools = await client.connect()
  assert.deepEqual(tools.map((tool) => tool.name), ['list_gpu_resources', 'get_gpu_node_status', 'list_models'])
  assert.equal(capturedUrl, 'https://controller.thetaedgecloud.com/mcp')
  assert.equal(capturedHeaders['x-api-key'], 'project-secret')
  assert.equal(capturedHeaders.Authorization, 'Bearer inference-secret')
  assert.equal(client.describe().exposedToolCount, 3)
})

test('pins project_id from server config and rejects agent-supplied project overrides', async () => {
  const config = loadThetaConfig({ THETA_PROJECT_ID: 'prj_12345678', THETA_PROJECT_API_KEY: 'secret' })
  let callArgs: Record<string, unknown> | undefined
  const factory: ThetaToolFactory = () => ({
    async connect() {},
    async listTools() {
      return { tools: [{ name: 'list_gpu_nodes', inputSchema: {
        type: 'object', properties: { project_id: { type: 'string' }, page: { type: 'number' } },
      } }] }
    },
    async callTool(args) { callArgs = args.arguments; return { ok: true } },
    async close() {},
  })
  const client = new ThetaReadOnlyMcpClient(config, factory)
  await client.connect()
  await client.call('list_gpu_nodes', { page: 2 })
  assert.deepEqual(callArgs, { page: 2, project_id: 'prj_12345678' })
  await assert.rejects(() => client.call('list_gpu_nodes', { project_id: 'prj_attacker' }), /controlled by server configuration/)
  await assert.rejects(() => client.call('create_gpu_node'), /not available in read-only mode/)
})

test('fails closed without credentials and redacts connection failures', async () => {
  const config = loadThetaConfig({ THETA_PROJECT_ID: 'prj_12345678' })
  const client = new ThetaReadOnlyMcpClient(config)
  await assert.rejects(() => client.connect(), /credentials are not configured/)
})
