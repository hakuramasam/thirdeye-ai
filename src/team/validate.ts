/**
 * Inter-agent message validation.
 *
 * The blueprint in docs/agent-team/schemas defines three message shapes. Agents are language
 * models, so their output is a proposal, not a contract: everything crossing between agents is
 * checked against the schema before it is stored or forwarded, and a validation failure is
 * returned to the caller as a refusal rather than being quietly coerced.
 */
// The blueprint schemas declare draft 2020-12, so use Ajv's 2020 build, not the draft-07 default.
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import messageSchema from './schemas/agent-message.schema.json' with { type: 'json' }
import taskSchema from './schemas/task.schema.json' with { type: 'json' }
import reportSchema from './schemas/agent-report.schema.json' with { type: 'json' }

export type ValidationResult = { ok: true } | { ok: false; errors: string[] }

const ajv = new (Ajv2020 as any)({ allErrors: true, strict: false })
try { addFormats(ajv as any) } catch { /* formats optional: date-time checks degrade to plain string */ }

const validators = {
  message: ajv.compile(messageSchema as any),
  task: ajv.compile(taskSchema as any),
  report: ajv.compile(reportSchema as any),
}

function run(kind: keyof typeof validators, value: unknown): ValidationResult {
  const validate = validators[kind]
  if (validate(value)) return { ok: true }
  const errors = (validate.errors ?? []).map((e: any) => `${e.instancePath || '/'} ${e.message}`)
  return { ok: false, errors: errors.slice(0, 12) }
}

export const validateAgentMessage = (v: unknown) => run('message', v)
export const validateTask = (v: unknown) => run('task', v)
export const validateAgentReport = (v: unknown) => run('report', v)

/** Parse JSON text and validate in one step; models often hand back a string. */
export function parseAndValidate(kind: keyof typeof validators, text: string): ValidationResult & { value?: any } {
  let value: any
  try { value = typeof text === 'string' ? JSON.parse(text) : text } catch {
    return { ok: false, errors: ['not valid JSON'] }
  }
  const result = run(kind, value)
  return result.ok ? { ...result, value } : result
}
