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
  check(exists(skillPath), `${unit.id}: missing canonical skill ${skillPath}`);
  check(exists(profilePath), `${unit.id}: missing Copilot profile ${profilePath}`);
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
];
for (const path of expectedPlatformPaths) check(exists(path), `Missing platform adapter: ${path}`);

for (const role of platforms.role_profiles || []) {
  const unit = org.units.find((item) => item.id === role.agent_id);
  check(Boolean(unit), `Platform profile references unknown role ${role.agent_id}`);
  check(exists(role.skill), `${role.agent_id}: missing skill reference ${role.skill}`);
  check(exists(role.copilot_profile), `${role.agent_id}: missing profile ${role.copilot_profile}`);
  check(Array.isArray(role.tools) && role.tools.includes('read') && role.tools.includes('search'), `${role.agent_id}: read/search tools are required`);
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
