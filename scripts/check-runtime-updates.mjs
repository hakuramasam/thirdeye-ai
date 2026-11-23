import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const configuredMajor = Number(readFileSync('.nvmrc', 'utf8').trim().replace(/^v/, '').split('.')[0])
const nodeResponse = await fetch('https://nodejs.org/dist/index.json')
if (!nodeResponse.ok) throw new Error('Unable to retrieve official Node.js release index: HTTP ' + nodeResponse.status)
const releases = await nodeResponse.json()
const latestNode = releases.find((release) => release.version.startsWith('v' + configuredMajor + '.') && release.lts)
if (!latestNode) throw new Error('No current LTS release found for configured Node major ' + configuredMajor)
const npmLatestRaw = execFileSync('npm', ['view', 'npm', 'version', '--json'], { encoding: 'utf8' }).trim()
const npmLatest = JSON.parse(npmLatestRaw)
const npmCurrent = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim()
const cmp = (a, b) => {
  const aa = a.replace(/^v/, '').split('.').map(Number)
  const bb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((aa[i] || 0) !== (bb[i] || 0)) return (aa[i] || 0) < (bb[i] || 0) ? -1 : 1
  return 0
}
const report = {
  checked_at: new Date().toISOString(),
  node: { current: process.version, configured_major: configuredMajor, latest_lts_patch: latestNode.version, update_available: cmp(process.version, latestNode.version) < 0 },
  npm: { current: npmCurrent, latest: npmLatest, update_available: cmp(npmCurrent, npmLatest) < 0 },
}
writeFileSync('runtime-updates.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
