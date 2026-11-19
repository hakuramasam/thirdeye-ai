import assert from 'node:assert/strict'

const [major, minor] = process.versions.node.split('.').map(Number)
const minimum = [20, 19]
assert.ok(
  major > minimum[0] || (major === minimum[0] && minor >= minimum[1]),
  `Node.js >= 20.19.0 is required; found ${process.version}`
)
const npmVersion = process.env.npm_config_user_agent?.match(/npm\/(\d+\.\d+\.\d+)/)?.[1]
if (npmVersion) {
  const [npmMajor] = npmVersion.split('.').map(Number)
  assert.ok(npmMajor >= 10, `npm >= 10 is required; found ${npmVersion}`)
}
console.log(JSON.stringify({ node: process.version, npm: npmVersion ?? 'not reported by npm_config_user_agent', minimumNode: '20.19.0', configuredMajor: '26' }))
