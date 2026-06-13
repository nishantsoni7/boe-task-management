// Shared "real activity" filter for Task Management notifications — used by
// the list API, the unread-badge count endpoint, and mark-all-read. All three
// must stay in sync, so they all import this single constant.
//
// This is a PostgREST `.or()` clause. It is a whitelist: rows that do not
// match any condition here are hidden everywhere (digest rows, legacy noise).
//
// Sample Tracking has its own separate notification system (sample_notifications
// table) and is intentionally excluded here.
export const NOTIFICATION_ACTIVITY_OR = [
  'title.ilike.%acknowledged task%',
  'title.ilike.%task acknowledged%',
  'title.ilike.%moved task to waiting%',
  'title.ilike.%moved task to blocked%',
  'title.ilike.%completed task%',
  'title.ilike.%task completed%',
  'title.ilike.%added a comment%',
  'title.ilike.%new comment on task%',
  'title.ilike.%cancelled task%',
  'title.ilike.%task cancelled%',
  'title.ilike.%cancelled a task%',
  'title.ilike.%reversed cancellation%',
  'title.ilike.%cancellation reversed%',
].join(',')
