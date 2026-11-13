// The Reviews ranking switch (20270702000000): an administrator turns the review
// leaderboard on or off for everyone, in Control Center → Reviews → Rankings.
//
// HIDDEN UNLESS THE DATABASE SAYS "ON". Only a stored `true` shows the ranking.
// A switch that is still loading, a read that failed, a row that is missing or a
// database that does not have the table yet all read as hidden, so the ranking
// can never appear by accident.

export const REVIEW_RANKINGS_KEY = ['review-rankings-visible'] as const

export function readRankingsVisible(row: unknown): boolean {
  return typeof row === 'object' && row !== null
    && (row as { rankings_visible?: unknown }).rankings_visible === true
}

/** Shown on /my-credits/leaderboard when someone opens it while the ranking is off. */
export const RANKINGS_OFF_TITLE = 'The review ranking is switched off'
export const RANKINGS_OFF_BODY = 'Your own reviews and credits are not affected. They are still counted and paid as usual.'

/** What "ranked" means, in the words the team asks for. Shown under the board and on its own page. */
export const HOW_RANKED = [
  'Ranked by reward-eligible reviews in the month: approved reviews whose credit has not been reversed. Deleted, rejected and confirmed duplicate reviews do not count, and neither does an edited review still waiting to be approved again.',
  'Equal counts share a rank (1, 2, 2, 4).',
  'Points are the credits earned from those reviews ÷ 10, and start again every month. They are not a performance score.',
] as const
