// Who a quotation request is sent to (owner, 18 Nov 2026: the owner or Nitish; the salesperson must pick, and the pick
// is remembered). The list comes from quotation_request_receivers() (20270804000000): active administrators and holders
// of task_management.receive_quotations. The database refuses any other assignee.

export type Receiver = { id: string; full_name: string }

export const SEND_TO_STORAGE_KEY = 'boe.quotationRequest.sendTo'

/** The pre-selected receiver: the remembered one while they still receive requests, the only one when there is one, else none. */
export function initialReceiver(receivers: readonly Receiver[], remembered: string | null): string {
  if (remembered && receivers.some(r => r.id === remembered)) return remembered
  return receivers.length === 1 ? receivers[0].id : ''
}

/** The words for the database's refusal (tasks_quotation_request_receiver), or null for any other error. */
export function receiverRefusal(message: string | null | undefined): string | null {
  return /QUOTATION_REQUEST_RECEIVER/.test(message ?? '')
    ? 'The person you picked no longer receives quotation requests. Reload the page and pick again.'
    : null
}

export function rememberedReceiver(): string | null {
  try { return window.localStorage.getItem(SEND_TO_STORAGE_KEY) } catch { return null }
}

export function rememberReceiver(id: string): void {
  try { window.localStorage.setItem(SEND_TO_STORAGE_KEY, id) } catch { /* private window: the pick is simply not remembered */ }
}
