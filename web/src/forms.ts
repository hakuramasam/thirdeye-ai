/**
 * The form posts numbers straight through, so one non-numeric field used to store NaN and every
 * later read rendered "nan" in the agent row. Validate where it is given, and name the field.
 */
export function formProblems(f: { name: string; model: string; budget_usd_micros: string; max_steps: string }): string[] {
  const out: string[] = []
  if (!f.name.trim()) out.push('a name')
  if (!f.model) out.push('a model')
  const budget = Number(f.budget_usd_micros)
  if (!Number.isInteger(budget) || budget <= 0) out.push('a whole-number budget in micro-dollars')
  const steps = Number(f.max_steps)
  if (!Number.isInteger(steps) || steps < 1 || steps > 30) out.push('max steps between 1 and 30')
  return out
}

