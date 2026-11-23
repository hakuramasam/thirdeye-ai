import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const json = (path) => JSON.parse(read(path));
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const exists = (path) => existsSync(resolve(root, path));

const org = json('team/organization.json');
const platforms = json('team/platforms.json');
const tools = json('team/tools.json');
const resources = json('team/resources.json');

check(org.version === 1, 'Unsupported team organization version');
check(org.orchestrator === 'tdt_hermes', 'HERMES must remain the only orchestrator');
check(Array.isArray(org.units) && org.units.length === 12, 'Expected the canonical 12-agent roster');

const ids = new Set(org.units.map((unit) => unit.id));
check(ids.size === org.units.length, 'Agent IDs must be unique');
check(ids.has(org.orchestrator), 'Orchestrator must exist in the roster');

for (const unit of org.units) {
  const slug = unit.id.replace(/^tdt_/, '');
  const skillPath = `team/agents/${slug}/SKILL.md`;
  const profilePath = `.github/agents/${slug}.agent.md`;
  const claudeAgentPath = `.claude/agents/${slug}.md`;
  check(exists(skillPath), `${unit.id}: missing canonical skill ${skillPath}`);
  check(exists(profilePath), `${unit.id}: missing Copilot profile ${profilePath}`);
  check(exists(claudeAgentPath), `${unit.id}: missing Claude Code subagent ${claudeAgentPath}`);
  check(Array.isArray(unit.owns_paths), `${unit.id}: owns_paths must be an array`);
  check(Array.isArray(unit.handoff_to), `${unit.id}: handoff_to must be an array`);
  for (const next of unit.handoff_to || []) check(ids.has(next), `${unit.id}: unknown handoff target ${next}`);

  if (exists(skillPath)) {
    const skill = read(skillPath);
    check(!skill.includes('## What you can and cannot do today'), `${unit.id}: stale runtime capability section remains`);
    check(skill.includes('## Current runtime capabilities and limits'), `${unit.id}: current runtime capability section missing`);
  }

  if (exists(profilePath)) {
    const profile = read(profilePath);
    const frontmatter = profile.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    check(Boolean(frontmatter), `${unit.id}: Copilot profile has no YAML frontmatter`);
    check(frontmatter?.[1].includes('description:'), `${unit.id}: Copilot profile needs a description`);
    check(frontmatter?.[1].includes('tools:'), `${unit.id}: Copilot profile must declare least-privilege tools`);
    check(profile.includes(skillPath), `${unit.id}: profile must reference its canonical skill`);
  }
  if (exists(claudeAgentPath)) {
    const profile = read(claudeAgentPath);
    const frontmatter = profile.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    check(Boolean(frontmatter), `${unit.id}: Claude subagent has no YAML frontmatter`);
    check(frontmatter?.[1].includes('tools:'), `${unit.id}: Claude subagent must declare tools`);
    check(frontmatter?.[1].includes('permissionMode:'), `${unit.id}: Claude subagent must declare permission mode`);
    check(frontmatter?.[1].includes('skills: [thirdeye-team]'), `${unit.id}: Claude subagent must load thirdeye-team skill`);
    check(profile.includes(skillPath), `${unit.id}: Claude subagent must reference its canonical skill`);
  }
}

const expectedPlatformPaths = [
  platforms.platforms.codex.instructions,
  platforms.platforms.codex.skills,
  platforms.platforms.claude_code.instructions,
  platforms.platforms.claude_code.skills,
  platforms.platforms.cursor.instructions,
  platforms.platforms.cursor.rules,
  platforms.platforms.github_copilot.instructions,
  platforms.platforms.gemini_cli.instructions,
  platforms.platforms.github_actions.ci,
  platforms.platforms.github_actions.neon_lifecycle,
  platforms.platforms.github_actions.controlled_preview,
  platforms.platforms.github_actions.dependabot,
  platforms.platforms.github_actions.pull_request_template,
  platforms.platforms.github_actions.issue_template,
];
for (const path of expectedPlatformPaths) check(exists(path), `Missing platform adapter: ${path}`);

for (const role of platforms.role_profiles || []) {
  const unit = org.units.find((item) => item.id === role.agent_id);
  check(Boolean(unit), `Platform profile references unknown role ${role.agent_id}`);
  check(exists(role.skill), `${role.agent_id}: missing skill reference ${role.skill}`);
  check(exists(role.copilot_profile), `${role.agent_id}: missing profile ${role.copilot_profile}`);
  check(exists(role.codex_agent), `${role.agent_id}: missing Codex agent ${role.codex_agent}`);
  if (exists(role.codex_agent)) {
    const toml = read(role.codex_agent);
    check(toml.includes(`name = "${role.agent_id}"`), `${role.agent_id}: Codex agent name mismatch`);
    check(toml.includes('description = '), `${role.agent_id}: Codex agent description missing`);
    check(toml.includes('developer_instructions = """'), `${role.agent_id}: Codex developer instructions missing`);
    check(toml.includes(role.skill), `${role.agent_id}: Codex agent must reference its canonical skill`);
    if (['tdt_hermes', 'tdt_blockchain', 'tdt_sentinel'].includes(role.agent_id)) {
      check(toml.includes('sandbox_mode = "read-only"') && toml.includes('shell_tool = false'), `${role.agent_id}: Codex reviewer/orchestrator must remain read-only without shell`);
    }
  }
  check(Array.isArray(role.tools) && role.tools.includes('read') && role.tools.includes('search'), `${role.agent_id}: read/search tools are required`);
  if (exists(role.copilot_profile)) {
    const profile = read(role.copilot_profile);
    const fm = profile.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const toolLine = fm?.[1].split('\n').find((line) => line.trim().startsWith('tools:')) ?? '';
    const declared = [...toolLine.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    check(JSON.stringify(declared) === JSON.stringify(role.tools), `${role.agent_id}: Copilot tools differ from team/platforms.json`);
  }
  const claudePath = `.claude/agents/${role.slug}.md`;
  check(exists(claudePath), `${role.agent_id}: missing Claude profile ${claudePath}`);
  if (exists(claudePath)) {
    const profile = read(claudePath);
    const fm = profile.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const toolLine = fm?.[1].split('\n').find((line) => line.trim().startsWith('tools:')) ?? '';
    const declared = toolLine.slice(toolLine.indexOf('[') + 1, toolLine.lastIndexOf(']')).split(',').map((value) => value.trim().replace(/^"|"$/g, '')).filter(Boolean);
    check(JSON.stringify(declared) === JSON.stringify(role.claude_tools), `${role.agent_id}: Claude tools differ from team/platforms.json`);
  }
  if (role.agent_id === 'tdt_blockchain' || role.agent_id === 'tdt_sentinel') {
    check(!role.tools.includes('edit'), `${role.agent_id}: sensitive independent reviewer must not have edit tool`);
  }
  if (role.agent_id === 'tdt_hermes') {
    check(role.tools.includes('agent') && !role.tools.includes('edit') && !role.tools.includes('execute'), 'HERMES must orchestrate without direct edit/execute tools');
  }
  if (role.agent_id === 'tdt_qa') {
    check(role.tools.includes('execute') && !role.tools.includes('edit'), 'QA needs test execution but must not edit the implementation');
  }
}
check((platforms.role_profiles || []).length === org.units.length, 'Every canonical role must have exactly one platform profile');
check(platforms.platforms.claude_code.agents === '.claude/agents/<role>.md', 'Claude subagent directory mapping is missing');
check(platforms.platforms.codex.agents === '.codex/agents/<role>.toml', 'Codex subagent directory mapping is missing');

for (const item of [...resources.knowledge, ...resources.skills, ...resources.workflows, ...resources.schemas]) {
  check(exists(item.path), `Resource registry path does not exist: ${item.path}`);
}

const expectedTools = ['repo_read', 'repo_write', 'delegate_to_agent', 'read_artifact', 'http_fetch', 'namespaced_mcp_tools'];
const actualTools = new Set(tools.tools.map((item) => item.name));
for (const name of expectedTools) check(actualTools.has(name), `Missing runtime tool manifest entry: ${name}`);
check(tools.tools.find((item) => item.name === 'repo_write')?.never?.includes('merges a pull request'), 'repo_write manifest must state that it cannot merge');
check(tools.tools.find((item) => item.name === 'repo_write')?.access?.includes('task-scoped'), 'repo_write must remain task-scoped');

for (const path of [
  'team/platforms.json',
  'team/tools.json',
  'team/resources.json',
  'docs/agent-platforms.md',
  '.github/copilot-instructions.md',
  '.cursor/rules/thirdeye-team.mdc',
  'CLAUDE.md',
  'GEMINI.md',
  'AGENTS.md',
]) check(exists(path), `Required platform contract missing: ${path}`);

if (failures.length) {
  console.error(`Agent platform validation failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Agent platform validation passed: ${org.units.length} roles, ${platforms.role_profiles.length} Copilot profiles, ${resources.skills.length} canonical skills, ${tools.tools.length} runtime tool contracts, and ${expectedPlatformPaths.length} platform instruction surfaces.`);
