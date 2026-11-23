import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROLE_BY_ID: Record<string, string> = {
  tdt_hermes: 'hermes', tdt_product: 'product', tdt_architect: 'architect',
  tdt_backend: 'backend', tdt_frontend: 'frontend', tdt_blockchain: 'blockchain',
  tdt_intelligence: 'intelligence', 'tdt_agent-engineer': 'agent-engineer',
  tdt_qa: 'qa', tdt_sentinel: 'sentinel', tdt_devops: 'devops', tdt_docs: 'docs',
}

const ROLE_BY_NAME: Record<string, string> = {
  hermes: 'hermes', 'hermes chief orchestrator': 'hermes',
  product: 'product', 'product research': 'product',
  architect: 'architect', 'system architect': 'architect',
  backend: 'backend', 'backend engineer': 'backend',
  frontend: 'frontend', 'frontend engineer': 'frontend',
  blockchain: 'blockchain', 'wallet finance specialist': 'blockchain',
  intelligence: 'intelligence', 'data intelligence specialist': 'intelligence',
  'agent engineer': 'agent-engineer', 'agent runtime engineer': 'agent-engineer',
  qa: 'qa', 'qa testing': 'qa',
  sentinel: 'sentinel', 'security sentinel': 'sentinel',
  devops: 'devops', 'devops release': 'devops',
  docs: 'docs', documentation: 'docs',
}

export type RoleSkillPack = { role: string; version: string; sha256: string; content: string }

/** Resolve only the twelve reviewed roles; ordinary user-created agents receive no team skill. */
export function loadRoleSkillPack(agentId: string, agentName: string): RoleSkillPack | null {
  if (process.env.THIRDEYE_AGENT_SKILLS_ENABLED === 'false') return null
  const normalizedName = String(agentName ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const role = ROLE_BY_ID[agentId] ?? ROLE_BY_NAME[normalizedName]
  if (!role) return null

  const file = resolve(process.cwd(), 'team', 'agents', role, 'SKILL.md')
  const content = readFileSync(file, 'utf8')
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  if (!frontmatter) throw new Error(`Role skill pack for ${role} has invalid frontmatter`)
  const version = /^\s{2}version:\s*["']?([^"'\s]+)["']?\s*$/m.exec(frontmatter[1])?.[1]
  if (!version) throw new Error(`Role skill pack for ${role} has no metadata.version`)
  return { role, version, sha256: createHash('sha256').update(content).digest('hex'), content }
}
