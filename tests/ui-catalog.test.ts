/**
 * Two live UI defects, reported from the deployed dashboard on 2026-11-15.
 *
 * The Playground's model select rendered ten blank rows and then sent a request with no model
 * ("Missing model or messages in request body"). It read `m.id` from a response that answers
 * `{ models: [{ model, ... }] }`, so every option label and value was undefined.
 *
 * The Create-agent form posted `Number(field)` with no check, so a non-numeric budget was stored
 * as NaN and the agent list rendered "nan" where a budget belongs.
 *
 * These tests pin the two pure functions that now own those decisions.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const { normalizeModels, modelLabel } = await import('../web/src/models.js')
const { formProblems } = await import('../web/src/forms.js')

describe('the model catalogue the dashboard actually receives', () => {
  it('reads the /api/models shape and keeps a readable label', () => {
    const rows = normalizeModels({
      models: [
        { model: 'gpt-oss-120b', provider: 'groq', price_in_1m_usd_micros: 150000, price_out_1m_usd_micros: 600000 },
        { model: 'ministral-3b', provider: 'mistral', price_in_1m_usd_micros: 40000, price_out_1m_usd_micros: 40000 },
      ],
    })

    assert.deepEqual(rows.map((m: any) => m.id), ['gpt-oss-120b', 'ministral-3b'])
    assert.equal(rows[0].provider, 'groq')
    assert.equal(rows[0].promptUsdPerMillion, 0.15)
    assert.equal(rows[0].completionUsdPerMillion, 0.6)
    assert.match(modelLabel(rows[0]), /^gpt-oss-120b · \$0\.15\/M in$/, 'the option names the model and its price')
  })

  it('reads the OpenAI-compatible shape, whose prices are already USD per million', () => {
    // /api/v1/models publishes pricing.prompt as USD per 1M tokens: gpt-4o-mini reports "0.15".
    // Reading that as a per-token figure multiplied every price by a million.
    const rows = normalizeModels({ data: [{ id: 'base-model', owned_by: 'thirdeye', pricing: { prompt: '0.15' } }] })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'base-model')
    assert.equal(rows[0].provider, 'thirdeye')
    assert.equal(rows[0].promptUsdPerMillion, 0.15)
    assert.equal(rows[0].completionUsdPerMillion, null, 'an absent output price is null, never NaN')
    assert.equal(modelLabel(rows[0]), 'base-model · $0.15/M in')
  })

  it('shows a sub-cent price as sub-cent instead of rounding it to free', () => {
    const rows = normalizeModels({ data: [{ id: 'cheap-model', pricing: { prompt: '0.0008' } }] })
    assert.equal(rows[0].promptUsdPerMillion, 0.0008)
    assert.equal(modelLabel(rows[0]), 'cheap-model · $0.0008/M in', 'two decimals would print $0.00 and read as free')
  })

  it('drops a row it cannot name instead of rendering a blank option', () => {
    const rows = normalizeModels({ models: [{ model: 'real-model' }, {}, { model: '   ' }, { id: '' }] })
    assert.deepEqual(rows.map((m: any) => m.id), ['real-model'])
    // This is the regression: undefined ids produced the ten empty rows in the screenshot.
    assert.equal(rows.every((m: any) => typeof m.id === 'string' && m.id.length > 0), true)
  })

  it('survives a failed or empty catalogue without inventing a model', () => {
    for (const raw of [null, undefined, {}, { models: null }, []]) {
      assert.deepEqual(normalizeModels(raw), [])
    }
  })
})

describe('the create-agent form refuses numbers it cannot use', () => {
  const valid = { name: 'defi-research', model: 'gpt-oss-120b', budget_usd_micros: '150000', max_steps: '8' }

  it('accepts a complete form', () => {
    assert.deepEqual(formProblems(valid), [])
  })

  it('names the field that is missing rather than disabling the button silently', () => {
    assert.deepEqual(formProblems({ ...valid, name: '  ' }), ['a name'])
    assert.deepEqual(formProblems({ ...valid, model: '' }), ['a model'])
  })

  it('rejects a non-numeric budget, which is what stored NaN and rendered "nan"', () => {
    assert.deepEqual(formProblems({ ...valid, budget_usd_micros: 'abc' }), ['a whole-number budget between 1 and 10,000,000 micro-dollars ($10)'])
    assert.deepEqual(formProblems({ ...valid, budget_usd_micros: '' }), ['a whole-number budget between 1 and 10,000,000 micro-dollars ($10)'])
    assert.deepEqual(formProblems({ ...valid, budget_usd_micros: '0' }), ['a whole-number budget between 1 and 10,000,000 micro-dollars ($10)'])
  })

  it('rejects a step count outside the range the runner accepts', () => {
    assert.deepEqual(formProblems({ ...valid, max_steps: '0' }), ['max steps between 1 and 20'])
    assert.deepEqual(formProblems({ ...valid, max_steps: '20' }), [])
    assert.deepEqual(formProblems({ ...valid, max_steps: '21' }), ['max steps between 1 and 20'])
    assert.deepEqual(formProblems({ ...valid, max_steps: '2.5' }), ['max steps between 1 and 20'])
  })

  it('reports every problem at once, so one fix does not reveal the next', () => {
    assert.deepEqual(formProblems({ name: '', model: '', budget_usd_micros: 'x', max_steps: '99' }), [
      'a name',
      'a model',
      'a whole-number budget between 1 and 10,000,000 micro-dollars ($10)',
      'max steps between 1 and 20',
    ])
  })
})
