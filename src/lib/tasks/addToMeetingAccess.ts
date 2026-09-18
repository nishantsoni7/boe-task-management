// Task Detail's "Add to Meeting" — whether it is drawn at all.
//
// Lives with Tasks, not with Meetings: Task Detail imports the action and this one
// rule, and nothing else from the Meetings module.

/**
 * Whether Task Detail offers "Add to Meeting" at all.
 *
 * The same people capture_meeting_discussion_item() accepts as the source task's
 * owner — its creator, its CURRENT assignee, or an admin — and only when they
 * also have Meetings access. A delegator can open a delegated task but is not one
 * of the three, so the action is not drawn for them: offering a button the
 * database will always refuse is worse than not offering it. Quotation requests
 * are not order issues and never get it.
 */
export function canOfferAddToMeeting(input: {
  hasMeetingAccess: boolean
  isCreator: boolean
  isAssignee: boolean
  isAdmin: boolean
  isQuotation: boolean
}): boolean {
  if (!input.hasMeetingAccess || input.isQuotation) return false
  return input.isCreator || input.isAssignee || input.isAdmin
}
