// The shapes the tracking page reads (image_credit_report, in the 20270807000000 migration) and the two sums on it.
// Client-safe.

/** What the fal balance reader answers (src/lib/imageCredits/falBalance.ts, server only). Lives here so the page can name it. */
export type FalBalance =
  | { connected: false }
  | { connected: true; usd: number }
  | { connected: true; usd: null; error: string }

export type Totals = { presses: number; credits: number; usd: number }
export type DayRow = Totals & { day: string; top_user: string | null; top_presses: number | null }
export type PersonRow = Totals & { user_id: string | null }
export type ToolRow = Totals & { tool: string }

export type CreditReport = {
  daily: DayRow[]
  people: PersonRow[]
  tools: ToolRow[]
  today: Totals
  month: Totals
  /** Dollars spent over the seven full India days before today. */
  usd_prev7: number
}

/** Whole days the fal balance lasts at the last seven days' pace; null when there is no pace to go by. */
export function daysOfBalanceLeft(balanceUsd: number, usdPrev7: number): number | null {
  if (!(usdPrev7 > 0) || !(balanceUsd >= 0)) return null
  return Math.floor(balanceUsd / (usdPrev7 / 7))
}

export const rupees = (usd: number, inrPerUsd: number): number => Math.round(usd * inrPerUsd)
