#!/usr/bin/env node
/**
 * Validate the team package layout. Runs in CI on every pull request.
 *
 * It refuses the mistakes that actually happen: a missing package file, a registry that does not
 * match the directories, an agent pointing at a tier that does not exist, a budget of zero, or a
 * protocol schema that no longer parses.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const errors = []
const warn = []

const tiers = { reasoning: 40000, balanced: 30000, economical: 15000 }
const required = ['system.md', 'agent.json', 'responsibilities.md', 'tools.json']

let registry
try {
  registry = JSON.parse(readFileSync(join(root, 'AGENT_REGISTRY.json'), 'utf8'))
} catch (e) {
  console.error('AGENT_REGISTRY.json does not parse:', e.message)
  process.exit(1)
}

const agentsDir = join(root, 'agents')
const dirs = existsSync(agentsDir) ? readdirSync(agentsDir).filter((d) => statSync(join(agentsDir, d)).isDirectory()) : []
const registered = (registry.agents ?? []).map((a) => a.id).filter((id) => id !== registry.orchestrator)

for (const id of registered) {
  if (!dirs.includes(id)) errors.push(`registry lists "${id}" but agents/${id}/ does not exist`)
  for (const file of required) {
    if (!existsSync(join(agentsDir, id, file))) errors.push(`agents/${id}/${file} is missing`)
  }
  const p = join(agentsDir, id, 'agent.json')
  if (!existsSync(p)) continue
  let meta
  try { meta = JSON.parse(readFileSync(p, 'utf8')) } catch (e) { errors.push(`agents/${id}/agent.json does not parse: ${e.message}`); continue }
  if (!tiers[meta.tier]) errors.push(`agents/${id} has unknown tier "${meta.tier}"`)
  if (!(Number(meta.budget_usd_micros_per_run) > 0)) errors.push(`agents/${id} has no positive budget`)
  if (meta.tier === 'economical' && Number(meta.budget_usd_micros_per_run) > tiers.reasoning) warn.push(`agents/${id} is economical but budgeted above the reasoning cap`)
  if (meta.can_delegate && Number(meta.max_delegation_depth) > 3) errors.push(`agents/${id} allows delegation deeper than 3`)
  if (!existsSync(join(agentsDir, id, 'tools.json'))) errors.push(`agents/${id}/tools.json is missing`)
  const prompt = readFileSync(join(agentsDir, id, 'system.md'), 'utf8')
  for (const section of ['## Model tier', '## Tools', '## Prohibited actions', '## Operating procedure', '## Handoff requirements', '## Completion criteria']) {
    if (!prompt.includes(section)) errors.push(`agents/${id}/system.md is missing section "${section}"`)
  }
}

for (const d of dirs) {
  if (!registered.includes(d)) errors.push(`agents/${d}/ exists but is not in AGENT_REGISTRY.json`)
}

for (const f of ['task-schema.json', 'agent-message-schema.json', 'agent-report.schema.json']) {
  try { JSON.parse(readFileSync(join(root, 'protocols', f), 'utf8')) } catch (e) { errors.push(`protocols/${f} does not parse: ${e.message}`) }
}

if (warn.length) warn.forEach((w) => console.warn('warn:', w))
if (errors.length) {
  errors.forEach((e) => console.error('error:', e))
  console.error(`\n${errors.length} problem(s) found`)
  process.exit(1)
}
console.log(`ok: ${registered.length} agents validated, ${dirs.length} packages, ${warn.length} warning(s)`)
