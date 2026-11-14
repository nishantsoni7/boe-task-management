// ONE CALL FOR THE LAUNCHER'S FOUR DAY-CLOSE / SCOREBOARD ANSWERS (2026-11-14, page speed part 6).
//
// The Modules page asked four separate routes on every visit: the Day Close strip, the score card, the
// vote card and the Star Seller card. Each is a server function that checks the caller, reads the settings
// and answers; while Day Close is paused (team_live is false in production) every one of them answers
// "nothing", so the person paid for four function calls and a dozen database reads to be told nothing,
// and they were the slowest requests on the page. This runs the SAME four loaders, one caller check, in
// parallel, and hands back each answer exactly as its own route would have: same status, same body.
//
// IT DECIDES NOTHING. Every part is the unchanged loader of the route it replaces (loadMyPrompt,
// loadMyScore, loadVote, loadStarSeller), run for the same caller from the same bearer token, so who may
// see what is exactly as before. A part that throws becomes that route's own 500 answer and does not
// take the others with it. The four routes stay, and the client falls back to them if this one fails.

import type { Caller } from '@/lib/security/attendancePayrollApiAuth'
import type { Result } from './server'

export const LAUNCHER_PARTS = ['prompt', 'me', 'vote', 'starSeller'] as const
export type LauncherPart = (typeof LAUNCHER_PARTS)[number]

export type LauncherLoaders = Record<LauncherPart, (caller: Caller) => Promise<Result>>

/** The parts named in `?parts=a,b`, in the order given, once each; anything unknown is ignored. */
export function parseLauncherParts(raw: string | null): LauncherPart[] {
  const wanted = new Set((raw ?? '').split(',').map(part => part.trim()))
  return LAUNCHER_PARTS.filter(part => wanted.has(part))
}

const ERROR_500: Result = { status: 500, body: { error: 'Something went wrong. Try again.' } }

export async function loadLauncher(
  caller: Caller,
  parts: readonly LauncherPart[],
  loaders: LauncherLoaders,
): Promise<Result> {
  const answers = await Promise.all(parts.map(async (part): Promise<[LauncherPart, Result]> => {
    try {
      return [part, await loaders[part](caller)]
    } catch (error) {
      console.error(`[day-close/launcher/${part}]`, error instanceof Error ? error.message : 'unknown error')
      return [part, ERROR_500]
    }
  }))
  return { status: 200, body: { parts: Object.fromEntries(answers) } }
}
