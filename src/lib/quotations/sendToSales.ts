// "Send to sales" for a quotation made from a quotation request: the same three calls as the request page's Send
// (src/app/tasks/[id]/page.tsx sendQuotation): one update tagged as the sent quotation (a link to the quotation
// instead of a file), the request completed through change_task_status, and the usual notice to the salesperson.

import type { SupabaseClient } from '@supabase/supabase-js'
import { QUOTATION_SENT_MARKER } from '@/lib/tasks/quotationSend'
import { browserNoticePost, changeTaskStatus, sendStatusNotice, type NoticePost, type StatusChangeTask } from '@/lib/tasks/statusChange'

export function sentNote(quoteNo: string, versionNo: number | null, url: string, note: string | null): string {
  return [`Quotation ${quoteNo}${versionNo ? ` v${versionNo}` : ''} is ready in BOE One: ${url}`, note?.trim() || null].filter(Boolean).join('\n')
}

export async function sendToSales(supabase: SupabaseClient, p: {
  task: StatusChangeTask; actorId: string; quoteNo: string; versionNo: number | null; url: string; note: string | null; post?: NoticePost
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.from('task_activity_log').insert({
    task_id: p.task.id, actor_id: p.actorId, action: 'note_added', note: sentNote(p.quoteNo, p.versionNo, p.url, p.note),
    attachment_url: null, new_val: QUOTATION_SENT_MARKER,
  })
  if (error) return { ok: false, error: 'Could not post the update on the request. Please try again.' }
  const outcome = await changeTaskStatus(supabase, { task: p.task, actorId: p.actorId, status: 'completed' })
  // 'own_action_found': an answer was lost but our own completion is there, so it counts as done.
  const eventId = outcome.kind === 'saved' ? outcome.change.eventId : outcome.kind === 'own_action_found' ? outcome.eventId : undefined
  if (eventId === undefined) {
    return { ok: false, error: 'The update was posted, but the request could not be marked complete. Open the request and complete it there.' }
  }
  await sendStatusNotice(p.post ?? browserNoticePost, { task: p.task, actorId: p.actorId, status: 'completed', eventId })
  return { ok: true }
}
