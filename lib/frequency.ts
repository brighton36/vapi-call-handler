// Call frequency for one person: how often they've called lately.
//
// The deferred after-call job (functions/after-call.ts) maintains each
// person's recentCalls (startedAt timestamps within the last 30 days) and the
// counts computed from them. At assistant-request time the webhook re-buckets
// those stored timestamps against "now", so a count never goes stale when the
// person simply stops calling. Pure functions — tested without AWS.

export const WINDOW_MS = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
}

export interface CallFrequency {
  callsLast24h: number
  callsLast7d: number
  callsLast30d: number
  // startedAt timestamps within the last 30 days, newest first.
  recentCalls: string[]
}

export function computeFrequency(startedAts: string[], now: Date = new Date()): CallFrequency {
  const t = now.getTime()
  const within = (ms: number) => (iso: string) => {
    const at = Date.parse(iso)
    return Number.isFinite(at) && at <= t && t - at <= ms
  }
  const recent = [...new Set(startedAts)].filter(within(WINDOW_MS.month)).sort().reverse()
  return {
    callsLast24h: recent.filter(within(WINDOW_MS.day)).length,
    callsLast7d: recent.filter(within(WINDOW_MS.week)).length,
    callsLast30d: recent.length,
    recentCalls: recent,
  }
}

// Human phrasing for the prompt, e.g. "2 calls in the last 24 hours, 3 in the
// last week, 6 in the last month". Empty string when they haven't called in
// 30 days (the prompt treats that as "no recent calls").
export function describeFrequency(f: Pick<CallFrequency, 'callsLast24h' | 'callsLast7d' | 'callsLast30d'>): string {
  if (!f.callsLast30d) return ''
  const n = (k: number, unit: string) => `${k} call${k === 1 ? '' : 's'} in the last ${unit}`
  return [
    n(f.callsLast24h, '24 hours'),
    `${f.callsLast7d} in the last week`,
    `${f.callsLast30d} in the last month`,
  ].join(', ')
}
