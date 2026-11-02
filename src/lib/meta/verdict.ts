// How an ad set or a campaign is judged. The numbers below are the owner's proposed defaults (module 26): the owner
// confirms or changes them, so they live in one place. Nothing here changes the Meta account; a Losing verdict is a
// suggestion to look, never an action.

export const MIN_CHATS = 20
export const MIN_SPEND_PAISE = 300_000 // Rs 3,000
/** "Well over" the target: more than half as much again. */
export const LOSING_OVER_TARGET = 1.5

export type Verdict = 'winning' | 'watch' | 'losing' | 'too_early' | 'no_data' | 'other_goal'

export const VERDICT_LABEL: Record<Verdict, string> = {
  winning: 'Winning',
  watch: 'Watch',
  losing: 'Losing',
  too_early: 'Too early',
  no_data: 'No data',
  other_goal: 'Other goal',
}

/** The badge class from the BOE tokens. */
export const VERDICT_BADGE: Record<Verdict, string> = {
  winning: 'boe-badge-completed',
  watch: 'boe-badge-waiting',
  losing: 'boe-badge-blocked',
  too_early: 'boe-badge-pending',
  no_data: 'boe-badge-pending',
  other_goal: 'boe-badge-pending',
}

/**
 * `chats` is null when the ad set's goal has no confirmed result count (src/lib/meta/results.ts): it gets no verdict.
 * `targetPaise` is what the owner will pay for one chat; with none set nothing can be Winning or Losing.
 */
export function judge({ spendPaise, chats, targetPaise }: { spendPaise: number; chats: number | null; targetPaise: number | null }): Verdict {
  if (spendPaise <= 0) return 'no_data'
  if (chats === null) return 'other_goal'
  if (chats < MIN_CHATS && spendPaise < MIN_SPEND_PAISE) return 'too_early'
  if (targetPaise === null) return 'watch'
  if (chats === 0) return 'losing'
  const cost = spendPaise / chats
  if (cost <= targetPaise) return 'winning'
  return cost <= targetPaise * LOSING_OVER_TARGET ? 'watch' : 'losing'
}
