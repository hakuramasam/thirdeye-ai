/**
 * Durable functions. Each step is a separate unit of work with its own retry, so a failure
 * halfway through never repeats the money-moving half.
 */
import { inngest } from './client.js'
import { query, one } from '../db/index.js'
import { runAgent, type AgentRow } from '../agents/runner.js'
import { convertPending } from '../payments/convert.js'
import type { UserRow } from '../lib/types.js'

/**
 * Convert pending volatile-token deposits. Runs every ten minutes and on demand, so a deposit
 * that arrives after the swap route was funded does not sit pending until someone notices.
 */
export const convertPendingDeposits = inngest.createFunction(
  {
    id: 'convert-pending-deposits',
    name: 'Convert pending token deposits',
    concurrency: { limit: 1 }, // one pass at a time; the executor also claims rows
    retries: 2,
    triggers: [{ cron: '*/10 * * * *' }, { event: 'thirdeye/deposit.convert' }],
  },
  async ({ step, logger }: any) => {
    const result = await step.run('convert-pass', async () => convertPending({ limit: 5 }))
    logger.info('conversion pass', {
      examined: result.examined,
      credited: result.credited,
      blocked: result.blocked,
      failed: result.failed,
    })
    // A blocked deposit means no signer or no route: surface it rather than retrying blindly.
    if (result.blocked > 0) {
      await step.run('record-blockers', async () => {
        await query(
          `INSERT INTO ops_events (id, kind, detail) VALUES (gen_random_uuid()::text, 'conversion_blocked', $1)`,
          [JSON.stringify(result.outcomes.filter((o: any) => o.status === 'blocked')).slice(0, 2000)]
        ).catch(() => {})
        return true
      })
    }
    return result
  }
)

/**
 * Run one team agent durably. The run is claimed before the model is called, so a retry after a
 * crash resumes the record instead of starting a second billable run.
 */
export const teamAgentRun = inngest.createFunction(
  {
    id: 'team-agent-run',
    name: 'Run one team agent',
    retries: 1,
    concurrency: { limit: 3 },
    triggers: [{ event: 'thirdeye/team.run' }],
  },
  async ({ event, step, logger }: any) => {
    const agentId = String((event.data as any)?.agentId ?? '')
    const input = String((event.data as any)?.input ?? '').slice(0, 4000)
    if (!agentId || !input) throw new Error('agentId and input are required')

    const loaded = await step.run('load-agent', async () => {
      const agent = await one('SELECT * FROM agents WHERE id = $1 AND status = $2', [agentId, 'active'])
      if (!agent) throw new Error(`agent ${agentId} is not active`)
      const user = await one('SELECT * FROM users WHERE id = $1', [(agent as any).user_id])
      if (!user) throw new Error(`owner of ${agentId} not found`)
      return { agentId, userId: (user as any).id }
    })

    const result = await step.run('run-agent', async () => {
      const agent = await one('SELECT * FROM agents WHERE id = $1', [loaded.agentId])
      const user = await one('SELECT * FROM users WHERE id = $1', [loaded.userId])
      const r = await runAgent(agent as unknown as AgentRow, input, user as unknown as UserRow)
      return { status: r.status, spendMicros: r.spend_usd_micros ?? 0, output: String(r.output ?? '').slice(0, 2000) }
    })

    logger.info('team run finished', result)
    return result
  }
)

export const functions = [convertPendingDeposits, teamAgentRun]
