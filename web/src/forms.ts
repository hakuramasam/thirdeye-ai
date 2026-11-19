/**
 * The form posts numbers straight through, so one non-numeric field used to store NaN and every
 * later read rendered "nan" in the agent row. Validate where it is given, and name the field.
 */
export function formProblems(f: { name: string; model: string; budget_usd_micros: string; max_steps: string }): string[] {
  const out: string[] = []
  if (!f.name.trim()) out.push('a name')
  if (!f.model) out.push('a model')
  // These caps mirror POST /api/agents exactly: a value the form accepts must not be one the
  // route rejects, or the button enables and the submission fails anyway.
  const budget = Number(f.budget_usd_micros)
  if (!Number.isInteger(budget) || budget < 1 || budget > 10_000_000) out.push('a whole-number budget between 1 and 10,000,000 micro-dollars ($10)')
  const steps = Number(f.max_steps)
  if (!Number.isInteger(steps) || steps < 1 || steps > 20) out.push('max steps between 1 and 20')
  return out
}

