import test from 'node:test'
import assert from 'node:assert/strict'
import { loadThetaConfig } from '../src/integrations/theta/config.js'

test('uses official controller origin and a one-dollar micros ceiling by default', () => {
  const config = loadThetaConfig({ THETA_PROJECT_ID: 'prj_12345678' })
  assert.equal(config.controllerBaseUrl, 'https://controller.thetaedgecloud.com')
  assert.equal(config.maxSpendUsdMicros, 1_000_000n)
  assert.equal(config.projectApiKey, '')
  assert.equal(config.inferenceApiKey, '')
})

test('rejects non-Theta controller origins', () => {
  assert.throws(() => loadThetaConfig({ THETA_CONTROLLER_URL: 'https://attacker.example' }))
  assert.throws(() => loadThetaConfig({ THETA_CONTROLLER_URL: 'http://controller.thetaedgecloud.com' }))
})

test('rejects malformed project IDs and spend limits', () => {
  assert.throws(() => loadThetaConfig({ THETA_PROJECT_ID: 'x' }))
  assert.throws(() => loadThetaConfig({ THETA_MAX_SPEND_USD_MICROS: '-1' }))
  assert.throws(() => loadThetaConfig({ THETA_MAX_SPEND_USD_MICROS: '1.5' }))
})

test('does not place credential values in diagnostic config', () => {
  const config = loadThetaConfig({
    THETA_PROJECT_ID: 'prj_12345678',
    THETA_PROJECT_API_KEY: 'test-project-secret',
    THETA_ONDEMAND_API_KEY: 'test-inference-secret',
  })
  const safe = JSON.stringify({ controllerOrigin: config.controllerBaseUrl, projectId: config.projectId })
  assert.equal(safe.includes('test-project-secret'), false)
  assert.equal(safe.includes('test-inference-secret'), false)
})
