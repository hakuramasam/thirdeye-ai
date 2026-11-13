export {}
/**
 * Boot the real app under a chosen environment and report what selected paths answer.
 *
 * A child process is the only honest way to test this: `src/app.ts` reads `process.env` at module
 * scope, so setting a variable in-process would leak into every other test file in the same run.
 */
const { default: app } = await import('../../src/app.js')

const paths = (process.env.PROBE_PATHS || '/api/healthz,/api/v1/models').split(',')
const out: Record<string, { status: number; body: unknown }> = {}
for (const path of paths) {
  const res = await app.request(path)
  const body = await res.json().catch(() => null)
  out[path] = { status: res.status, body }
}
// One line on stdout, so a caller can parse the last line without fighting tsx noise.
console.log(JSON.stringify(out))
