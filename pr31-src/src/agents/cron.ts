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

/** True when the wall-clock minute `t` matches the spec. Pure. */
function matches(spec: CronSpec, t: Date): boolean {
  const dom = t.getDate()
  const dow = t.getDay()
  if (!spec.minutes.has(t.getMinutes())) return false
  if (!spec.hours.has(t.getHours())) return false
  if (!spec.months.has(t.getMonth() + 1)) return false
  // Standard cron semantics for the day fields: if both are restricted, match either.
  const domOk = spec.doms.has(dom)
  const dowOk = spec.dows.has(dow)
  return spec.domRestricted && spec.dowRestricted ? (domOk || dowOk)
    : spec.domRestricted ? domOk
    : spec.dowRestricted ? dowOk
    : true
}

/**
 * The most recent instant at or before `now` that the cron selects, looking back at most
 * `lookbackMinutes`. Zero lookback means "only if this exact minute matches".
 */
export function lastScheduledInstant(spec: CronSpec, now: Date, lookbackMinutes = 0): Date | null {
  const start = new Date(now)
  start.setSeconds(0, 0)
  start.setMilliseconds(0)
  const span = Math.max(0, Math.trunc(lookbackMinutes))
  for (let i = 0; i <= span; i++) {
    const t = new Date(start.getTime() - i * 60_000)
    if (matches(spec, t)) return t
  }
  return null
}

export type DueOptions = {
  /**
   * How late a missed slot may still be picked up. The scheduler is invoked by an external
   * pinger whose timing we do not control, so a slot that passed while nothing was invoking
   * the route must still run rather than be lost. Zero keeps strict minute matching.
   */
  lookbackMinutes?: number
}

/**
 * Whether `cron` is due at `now`, given the agent's previous run time.
 *
 * Due means: the cron selects some instant that has already arrived, and the agent has not
 * run at or after that instant. With the default zero lookback this is exact-minute matching.
 */
export function isCronDue(cron: string, now: Date, lastRunAt: Date | null, opts: DueOptions = {}): boolean {
  const spec = parseCron(cron)
  const anchor = lastScheduledInstant(spec, now, opts.lookbackMinutes ?? 0)
  if (!anchor) return false
  if (lastRunAt) {
    const last = new Date(lastRunAt)
    if (last.getTime() >= anchor.getTime()) return false
  }
  return true
}
