import type { EffectivePermission } from './types'

// Quotation capability derivation for Task Management.
//
// One place that turns the raw effective permissions for the 'task_management'
// module into the booleans the quotation screens branch on. Same shape as
// orders.ts, finance.ts, assetsAccess.ts and meetings.ts.
//
// NOTE ON NAMING: the module key is 'task_management', not 'tasks'. The
// business requirement is written as tasks.view_quotations; the registered
// action is task_management.view_quotations. Same permission, and the module
// key is what the engine resolves against.
//
// WHAT IS AND IS NOT GATED
//
// Gated — the quotation-specific surfaces:
//   the Quotation Requests nav item and the New Request nav item
//   /tasks/quotation-requests and /tasks/quotation-requests/new
//   the dashboard Quotation panel
//   the quotation fields on task detail: customer_name, contact_number,
//   company_name, city_project
//
// NOT gated — a quotation request that is somebody's assigned work:
//   The task itself stays visible to its assignee and creator in the ordinary
//   task lists and on task detail. Hiding it would take an employee's own
//   assigned work away from them, which is exactly what the requirement
//   forbids. What they lose without view_quotations is the quotation framing
//   and the customer's commercial details, not the task.
//
// There is no price column in Task Management. 20260652_add_quotation_request_fields.sql
// adds task_type, customer_name, contact_number, company_name and city_project
// and nothing else. Quoted prices live in showroom_inquiry_items
// (rate_override, mrp_at_time) under the separate showroom_qr module, which
// this file does not govern. `view_quotations` is named for prices as well
// because it is the action that will gate them if the Task Management
// quotation workflow ever grows a commercial field.
//
// ENFORCEMENT BOUNDARY: these are DISPLAY and ROUTE gates. Unlike Orders and
// Finance, the quotation actions have no RLS backing — see MODULE_ENFORCEMENT
// in enforcement.ts and the limitation recorded in the Access Control docs. A
// determined caller with a valid session can still read the underlying task row
// through PostgREST if the ordinary task policies already allow it.

/** The task fields that carry the customer's commercial details. */
export const QUOTATION_SENSITIVE_FIELDS = [
  'customer_name',
  'contact_number',
  'company_name',
  'city_project',
] as const

export type QuotationSensitiveField = (typeof QUOTATION_SENSITIVE_FIELDS)[number]

export type QuotationCapabilities = {
  /** May open the quotation screens and see customer commercial details. */
  canViewQuotations: boolean
  /**
   * May create, edit, approve or share quotation information, wherever those
   * operations exist. Never true without canViewQuotations.
   */
  canManageQuotations: boolean
}

export const NO_QUOTATION_CAPABILITIES: QuotationCapabilities = {
  canViewQuotations: false,
  canManageQuotations: false,
}

export function deriveQuotationCapabilities(
  role: string | null | undefined,
  permissions: readonly EffectivePermission[],
): QuotationCapabilities {
  if (role === 'admin') {
    return { canViewQuotations: true, canManageQuotations: true }
  }

  const allowed = (actionKey: string) =>
    permissions.some(p => p.actionKey === actionKey && p.allowed)

  // Module entry first, matching orders.ts and finance.ts: a quotation grant
  // left behind on a module the person cannot open must not produce a screen.
  const canOpenModule = allowed('view')
  const canManageQuotations = canOpenModule && allowed('manage_quotations')
  const canViewQuotations =
    canOpenModule && (allowed('view_quotations') || canManageQuotations)

  return {
    // A stronger grant always includes the weaker one. This also repairs
    // previously saved manage-only overrides that could not surface any UI.
    canViewQuotations,
    canManageQuotations,
  }
}

/**
 * A task with its quotation-specific fields blanked when the viewer may not see
 * them.
 *
 * Redaction, not omission: the keys stay present and become null, so a caller
 * cannot mistake "not allowed to see it" for "this field was never set" and
 * render a stale value from elsewhere. The task's own identity — title, status,
 * assignment, dates — is untouched, because an assignee keeps their work.
 */
export function redactQuotationFields<T extends Partial<Record<QuotationSensitiveField, unknown>>>(
  task: T,
  canViewQuotations: boolean,
): T {
  if (canViewQuotations) return task
  const out = { ...task }
  for (const field of QUOTATION_SENSITIVE_FIELDS) {
    if (field in out) (out as Record<string, unknown>)[field] = null
  }
  return out
}

/** Whether a task row is a quotation request. */
export function isQuotationTask(task: { task_type?: string | null }): boolean {
  return task.task_type === 'quotation_request'
}
