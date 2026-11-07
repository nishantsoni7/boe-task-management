// "Hide for today" on the punch-in strip (owner, 2026-11-07): the red notice
// stays all day until the person hides it, and is never carried to the next day.
//
// What is remembered is the DATE, the server's IST date (PunchStrip.today), so a
// wrong phone clock can neither hide tomorrow's notice nor keep today's up. It
// lives in this browser's localStorage, per signed-in user: hiding it on a phone
// does not hide it on a laptop. Pure helpers so the test runner can execute them.

/** The localStorage key for one signed-in user. */
export const punchStripHiddenKey = (userId: string) => `boe.punchStrip.hidden.${userId}`

/** Hidden only when the stored date is exactly today's; yesterday's choice is nothing. */
export function isPunchStripHidden(stored: string | null, today: string): boolean {
  return stored !== null && stored === today
}
