// Shared "real activity" filter for notifications — used by the list API,
// the unread-badge count endpoint, and mark-all-read. All three must stay in
// sync, so they all import this single constant.
//
// This is a PostgREST `.or()` clause. It is a whitelist: rows that match
// none of these conditions are hidden everywhere (digest rows, legacy
// "Task status updated" noise, etc.).
//
// Task notifications are matched by title phrase.
// Sample Tracking notifications are matched by type prefix (sample_*) so that
// adding new sample event types never requires updating this filter.
export const NOTIFICATION_ACTIVITY_OR = [
  // ── Task Management ──────────────────────────────────────────────────────
  'title.ilike.%acknowledged task%',     // "Nishant acknowledged task"
  'title.ilike.%task acknowledged%',     // legacy fallback
  'title.ilike.%moved task to waiting%',
  'title.ilike.%moved task to blocked%',
  'title.ilike.%completed task%',        // "Nishant completed task"
  'title.ilike.%task completed%',        // legacy fallback
  'title.ilike.%added a comment%',       // "Prerna added a comment"
  'title.ilike.%new comment on task%',   // legacy fallback
  // ── Sample Tracking ──────────────────────────────────────────────────────
  // Matched by title phrase because type is always 'task_acknowledged' (table
  // constraint). Five patterns cover all twelve sample notification variants:
  'title.ilike.%sample request%',        // created/approved/rejected/reapplied/edited/deleted
  'title.ilike.%QR for sample%',         // QR submitted
  'title.ilike.%your sample%',           // dispatched / received / marked your sample as lost
  'title.ilike.%follow-up for sample%',  // follow-up logged
  'title.ilike.%a sample as lost%',      // lost (admin copy)
].join(',')
