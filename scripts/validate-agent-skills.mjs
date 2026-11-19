import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const org = JSON.parse(readFileSync('team/organization.json', 'utf8'));
const matrix = JSON.parse(readFileSync('team/competency-matrix.json', 'utf8'));
const registry = JSON.parse(readFileSync('team/skill-source-registry.json', 'utf8'));
const units = org.units;
const agents = matrix.agents;
const ids = units.map((unit) => unit.id);

assert.equal(new Set(ids).size, ids.length, 'organization contains duplicate agent ids');
assert.equal(new Set(agents.map((agent) => agent.id)).size, agents.length, 'competency matrix contains duplicate agent ids');
assert.deepEqual([...agents.map((agent) => agent.id)].sort(), [...ids].sort(), 'competency matrix must cover exactly the live roster');

for (const agent of agents) {
  const skill = readFileSync(agent.skill, 'utf8');
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, `${agent.id}: missing YAML frontmatter`);
  assert.match(frontmatter[1], /^name: [a-z0-9-]+$/m, `${agent.id}: invalid skill name`);
  assert.match(frontmatter[1], /^description: .{20,}$/m, `${agent.id}: missing skill description`);
  assert.match(frontmatter[1], /^  version: "2\.0\.0"$/m, `${agent.id}: expected skill version 2.0.0`);
  assert.match(skill, /## Capability contract/, `${agent.id}: missing competency contract`);
  assert.match(skill, /## Freshness and evidence rules/, `${agent.id}: missing freshness rules`);
  assert.equal(agent.status, 'untested', `${agent.id}: do not claim competency without practical evidence`);
  assert.ok(agent.scenario, `${agent.id}: missing competency scenario`);
  assert.ok(agent.critical_gates.length > 0, `${agent.id}: missing critical gates`);
}

assert.ok(registry.sources.length >= 8, 'expected curated external knowledge sources');
for (const source of registry.sources) {
  assert.ok(source.id && source.url && source.roles.length, 'source entry requires id, URL and role mapping');
  assert.equal(source.imported, false, 'WO-TEAM-01 must not auto-import external executable content');
}
console.log(`Validated ${agents.length} agent skill packs and ${registry.sources.length} external knowledge sources.`);
