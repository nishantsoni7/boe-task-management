// What counts as a "result" for an ad set, worked out from Meta's own list of what happened on a day.
//
// The raw list is stored as sent (meta_insights_daily.actions), so a mapping that turns out wrong at the first real
// read is fixed here and the numbers follow, with no second read from Meta. A goal with no entry has no result
// count: the screens show it as another goal and give it no verdict. Add a goal only after checking its number
// against Ads Manager.

import type { Action } from './parse'

/** Ads Manager's "Messaging conversations started", which the owner calls a chat. */
export const CHAT_ACTION = 'onsite_conversion.messaging_conversation_started_7d'

const RESULT_ACTION_BY_GOAL: Record<string, string> = {
  CONVERSATIONS: CHAT_ACTION,
}

export function hasResultMapping(optimizationGoal: string): boolean {
  return optimizationGoal in RESULT_ACTION_BY_GOAL
}

/** The day's result for an ad set with this goal, or null when the goal has no confirmed mapping. */
export function resultCount(optimizationGoal: string, actions: Action[]): number | null {
  const wanted = RESULT_ACTION_BY_GOAL[optimizationGoal]
  if (!wanted) return null
  return actions.filter(a => a.action_type === wanted).reduce((sum, a) => sum + (Number(a.value) || 0), 0)
}
