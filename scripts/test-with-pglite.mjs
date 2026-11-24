import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The test suite may use embedded PGlite, but only by explicit opt-in.
 * Production/runtime code never enables this automatically.
 */
process.env.PGLITE_MODE = '1'

const requested = process.argv.slice(2)
const files = requested.length
  ? requested
  : readdirSync('tests')
      .filter((name) => name.endsWith('.test.ts'))
      .sort()
      .map((name) => resolve('tests', name))

const bin = resolve('node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
const result = spawnSync(bin, ['--test', ...files], {
  stdio: 'inherit',
  env: { ...process.env, PGLITE_MODE: '1' },
  shell: process.platform === 'win32',
})

if (result.error) {
  console.error('Could not start the test runner:', result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
