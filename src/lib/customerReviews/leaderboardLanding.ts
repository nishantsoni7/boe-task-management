import type { Leaderboard, LeaderboardRow } from './reviewReport'

// How the Reviews landing page arranges the EXISTING leaderboard aggregate
// (customer_review_leaderboard, #269). Nothing is recalculated here: eligibility,
// ranks, ties, points and credits all arrive from the database. This only decides
// which rows go in which card.
//
//   * Leaders are the rows holding rank 1 with at least one eligible review.
//   * One leader → "Leading this month" plus a runner-up card for the rank-2 group
//     (joint runners-up are shown together, never one as THE runner-up).
//   * Joint leaders → they are shown together as joint leaders and there is no
//     runner-up card: equal counts are not a first and a second.
//   * Nobody with an eligible review → empty.

/** Rows in the compact list below the cards. */
export const LANDING_LIST_ROWS = 5

export type LandingBoard =
  | { kind: 'empty' }
  | {
      kind: 'ranked'
      leaders: LeaderboardRow[]
      joint: boolean
      runnersUp: LeaderboardRow[]
      /** The compact list: top rows with an eligible review, plus the viewer if outside them. */
      list: LeaderboardRow[]
      /** True when the viewer was appended below the top rows. */
      meOutside: boolean
    }

export function arrangeLanding(board: Leaderboard): LandingBoard {
  const ranked = board.rows.filter(r => r.reviews > 0)
  if (ranked.length === 0) return { kind: 'empty' }

  const leaders = ranked.filter(r => r.rank === 1)
  const joint = leaders.length > 1
  const below = ranked.filter(r => r.rank > 1)
  const nextRank = below.length ? Math.min(...below.map(r => r.rank)) : null
  const runnersUp = joint || nextRank === null ? [] : below.filter(r => r.rank === nextRank)

  const top = ranked.slice(0, LANDING_LIST_ROWS)
  const me = ranked.find(r => r.is_me)
  const meOutside = !!me && !top.some(r => r.employee_id === me.employee_id)
  return { kind: 'ranked', leaders, joint, runnersUp, list: meOutside && me ? [...top, me] : top, meOutside }
}
