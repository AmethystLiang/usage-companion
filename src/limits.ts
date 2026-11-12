export type LimitsWindow = {
  percent: number
  resetsAt: string | null
  status: string | null
}

export type LimitsSnapshot =
  | {
      ok: true
      fiveHour: LimitsWindow | null
      sevenDay: LimitsWindow | null
      limitedBy: string | null
      checkedAt: string | null
    }
  | { ok: false; reason: 'no-accounts' | 'no-usage' | 'unreadable' }

export function formatReset(resetsAt: string | null): string {
  if (!resetsAt) {
    return 'sem data'
  }
  const date = new Date(resetsAt)
  const minutes = Math.round((date.getTime() - Date.now()) / 60_000)
  if (minutes <= 0) {
    return 'agora'
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const when = date.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  const left = hours > 0 ? `${hours}h ${rest}min` : `${rest}min`
  return `em ${left} (${when})`
}
