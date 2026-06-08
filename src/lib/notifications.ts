// Shared "real task activity" filter for notifications.
//
// V1 only surfaces activity on tasks the recipient assigned to someone else:
// acknowledged / moved to Waiting / moved to Blocked / completed. Summary and
// digest rows ("Your task summary", morning/evening digests) and generic
// legacy rows ("Task status updated") must be hidden from the list, the unread
// badge, and "mark all as read" — so all three import this single constant to
// stay consistent.
//
// This is a PostgREST `.or()` clause: title must match one of the activity
// phrases (case-insensitive). It is a whitelist, so anything that is not a real
// task-activity title is excluded by definition.
export const NOTIFICATION_ACTIVITY_OR = [
  'title.ilike.%acknowledged task%',     // "Nishant acknowledged task"
  'title.ilike.%task acknowledged%',     // legacy fallback "Task acknowledged"
  'title.ilike.%moved task to waiting%', // actor + "Task moved to Waiting"
  'title.ilike.%moved task to blocked%', // actor + "Task moved to Blocked"
  'title.ilike.%completed task%',        // "Nishant completed task"
  'title.ilike.%task completed%',        // fallback "Task completed"
].join(',')
