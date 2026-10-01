/** 5-field cron (minute-resolution) parser + due check for autonomous agents. */

export type CronSpec = {
  minutes: Set<number>
  hours: Set<number>
  doms: Set<number>
  months: Set<number>
  dows: Set<number>
  domRestricted: boolean // any field other than '*' in dom position
  dowRestricted: boolean
}

function parseField(field: string, min: number, max: number, label: string): Set<number> {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const p = part.trim()
    let step = 1
    let range = p
    const slashIdx = p.indexOf('/')
    if (slashIdx >= 0) {
      range = p.slice(0, slashIdx)
      step = Number(p.slice(slashIdx + 1))
      if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step in cron ${label}: '${field}'`)
    }
    let lo: number, hi: number
    if (range === '*' || range === '') {
      lo = min; hi = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number)
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < min || b > max || a > b) {
        throw new Error(`Invalid range in cron ${label}: '${field}'`)
      }
      lo = a; hi = b
    } else {
      const v = Number(range)
      if (!Number.isInteger(v) || v < min || v > max) throw new Error(`Invalid value in cron ${label}: '${field}'`)
      lo = v; hi = v
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

/** Parse a cron expression. Throws on invalid syntax. */
export function parseCron(cron: string): CronSpec {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('Cron must have exactly 5 fields (m h dom mon dow)')
  return {
    minutes: parseField(fields[0], 0, 59, 'minute'),
    hours: parseField(fields[1], 0, 23, 'hour'),
    doms: parseField(fields[2], 1, 31, 'day-of-month'),
    months: parseField(fields[3], 1, 12, 'month'),
    dows: parseField(fields[4], 0, 6, 'day-of-week'), // 0 = Sunday
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  }
}

/**
 * Whether `cron` is due at `now`, given the agent's previous run time.
 * A run is due when the minute of `now` matches AND the agent has not already
 * run during this matching minute (or later, since its last run).
 */
export function isCronDue(cron: string, now: Date, lastRunAt: Date | null): boolean {
  const spec = parseCron(cron)
  const m = now.getMinutes()
  const h = now.getHours()
  const dom = now.getDate()
  const mon = now.getMonth() + 1
  const dow = now.getDay()

  if (!spec.minutes.has(m) || !spec.hours.has(h) || !spec.months.has(mon)) return false

  // Standard cron semantics for the day fields: if both are restricted, match either.
  const domOk = spec.doms.has(dom)
  const dowOk = spec.dows.has(dow)
  const dayOk = spec.domRestricted && spec.dowRestricted ? (domOk || dowOk)
    : spec.domRestricted ? domOk
    : spec.dowRestricted ? dowOk
    : true
  if (!dayOk) return false

  // Already ran during or after this matching minute -> not due again.
  if (lastRunAt) {
    const last = new Date(lastRunAt)
    const nowMinute = new Date(now)
    nowMinute.setSeconds(0, 0)
    if (last.getTime() >= nowMinute.getTime()) return false
  }
  return true
}
