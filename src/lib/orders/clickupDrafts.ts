// ── DRAFT ORDERS (CLICKUP) — 20270713000000 ─────────────────────────────────
//
// Pure helpers shared by the import page, the routes and the pages. The
// ClickUp subscription is ending, so every order of its "Running Orders" list
// is copied into BOE One as a draft (a place to test and to keep, apart from
// Confirmed Orders). Nothing here knows about the database or the browser.
//
// The input is the folder written by the one-off ClickUp export
// (orders.json + files/…); times in it are IST ("2026-10-01 17:39:56").

import type { Sheet, SheetCell } from '@/lib/finance/expenseReimbursementExport'

export const CLICKUP_DRAFT_BUCKET = 'clickup-draft-files'
export const CLICKUP_DRAFTS_PATH = '/orders/clickup'

// ── What the export folder holds (orders.json) ──

export type BackupFile = {
  id: string
  name: string
  uploaded_at: string
  uploaded_by: string
  bytes?: number
  sha256?: string
  /** Path inside the export folder, e.g. files/535 Acme [86abc]/2026-10-01_535 Acme ji.xlsx */
  file: string
  status?: string
}

export type BackupOrder = {
  clickup_id: string
  custom_id?: string | null
  name: string
  order_no?: string | null
  status?: string
  created_at?: string
  updated_at?: string
  closed_at?: string
  start_date?: string
  due_date?: string
  created_by?: string
  assignees?: string[]
  tags?: string[]
  priority?: string
  description?: string
  fields?: Record<string, string>
  checklists?: { name: string; items: { name: string; resolved: boolean }[] }[]
  subtasks?: { id: string; name: string; status: string }[]
  status_history?: { status: string; since: string }[] | null
  comments?: { id: string; at: string; by: string; reply_to?: string | null; text: string }[]
  files?: BackupFile[]
}

// ── What is stored ──

export type DraftFile = { id: string; name: string; uploaded_at: string | null; uploaded_by: string; size: number; sha256: string }
export type DraftComment = { id: string; at: string | null; by: string; reply_to: string | null; text: string }

export type DraftOrder = {
  id: string
  clickup_id: string
  clickup_custom_id: string | null
  order_no: string | null
  name: string
  client_name: string
  status: string
  created_in_clickup: string | null
  updated_in_clickup: string | null
  closed_in_clickup: string | null
  start_date: string | null
  due_date: string | null
  created_by_name: string
  assignees: string[]
  tags: string[]
  priority: string
  description: string
  fields: Record<string, string>
  checklists: { name: string; items: { name: string; resolved: boolean }[] }[]
  subtasks: { id: string; name: string; status: string }[]
  status_history: { status: string; since: string | null }[] | null
  comments: DraftComment[]
  files: DraftFile[]
  file_count: number
  comment_count: number
  imported_at: string
}

/** The row a save writes (everything but id, the generated counts and the import stamp). */
export type DraftInsert = Omit<DraftOrder, 'id' | 'file_count' | 'comment_count' | 'imported_at'>

// ── Ids, paths, times ──

const ID = /^[A-Za-z0-9_-]{1,64}$/
// ClickUp names a file "<uuid>.<extension>" (e.g. 3f2c…-….xlsx), so a file id may end in one short dotted extension.
const FILE_ID = /^[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9]{1,8})?$/
export const isClickupId = (value: unknown): value is string => typeof value === 'string' && ID.test(value)
export const isFileId = (value: unknown): value is string => typeof value === 'string' && FILE_ID.test(value)

/** Where a file lives in the private bucket. Built from ids only: a file name can hold anything. */
export function draftFilePath(clickupId: string, fileId: string): string {
  return `${clickupId}/${fileId}`
}

/** The little of a folder handle the import reads (a real FileSystemDirectoryHandle fits; a test can fake it). */
export type BackupDir = {
  name: string
  getFileHandle(name: string): Promise<unknown>
  entries(): AsyncIterable<[string, { kind: string } & Partial<BackupDir>]>
}

/**
 * The folder that holds orders.json: the one chosen, or the single dated folder inside it (the Windows folder
 * window easily lands one level up, on clickup-running-orders instead of 2026-11-13). The newest-named one wins.
 */
export async function findBackupFolder<D extends BackupDir>(chosen: D): Promise<D | null> {
  const has = (d: BackupDir) => d.getFileHandle('orders.json').then(() => true, () => false)
  if (await has(chosen)) return chosen
  const inside: D[] = []
  for await (const [, entry] of chosen.entries()) if (entry.kind === 'directory') inside.push(entry as unknown as D)
  inside.sort((a, b) => b.name.localeCompare(a.name))
  for (const d of inside) if (await has(d)) return d
  return null
}

/** "2026-10-01 17:39:56" (IST) or "2026-10-01" → an ISO instant; anything else → null. */
export function istToIso(value: unknown): string | null {
  const s = typeof value === 'string' ? value.trim() : ''
  if (!s) return null
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00+05:30` : `${s.replace(' ', 'T')}+05:30`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const dayOnly = (value: unknown): string | null => {
  const s = typeof value === 'string' ? value.trim() : ''
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

/** "532-Asha Rao Outdoor" → "Asha Rao Outdoor"; a name that is only a number stays as it is. */
export function clientNameOf(name: string): string {
  const rest = name.replace(/^\s*\d{3,5}\s*[-.:)]*\s*/, '').trim()
  return rest || name.trim()
}

// ── Checking what the browser sends (a trust boundary) ──

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '')
const list = <T>(value: unknown, max: number): T[] => (Array.isArray(value) ? (value.slice(0, max) as T[]) : [])
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseSaveOrder(raw: unknown): { ok: true; row: DraftInsert } | { ok: false; message: string } {
  if (!isObject(raw)) return { ok: false, message: 'The order is missing.' }
  if (!isClickupId(raw.clickup_id)) return { ok: false, message: 'The ClickUp task id is not valid.' }
  const name = text(raw.name, 500)
  if (!name) return { ok: false, message: 'The order has no name.' }

  const fields: Record<string, string> = {}
  if (isObject(raw.fields)) {
    for (const [k, v] of Object.entries(raw.fields).slice(0, 200)) {
      const value = text(v, 5000)
      if (k && value) fields[k.slice(0, 200)] = value
    }
  }

  const files: DraftFile[] = []
  for (const f of list<unknown>(raw.files, 200)) {
    if (!isObject(f) || !isFileId(f.id)) return { ok: false, message: 'A file of this order has no valid id.' }
    const size = Number(f.bytes ?? f.size)
    if (!Number.isFinite(size) || size < 0) return { ok: false, message: 'A file of this order has no size.' }
    files.push({
      id: f.id,
      name: text(f.name, 300) || f.id,
      uploaded_at: istToIso(f.uploaded_at),
      uploaded_by: text(f.uploaded_by, 120),
      size: Math.trunc(size),
      sha256: /^[0-9a-f]{64}$/.test(String(f.sha256 ?? '')) ? String(f.sha256) : '',
    })
  }

  const comments: DraftComment[] = []
  for (const c of list<unknown>(raw.comments, 5000)) {
    if (!isObject(c)) continue
    comments.push({
      id: text(c.id, 64),
      at: istToIso(c.at),
      by: text(c.by, 120),
      reply_to: text(c.reply_to, 64) || null,
      text: text(c.text, 20000),
    })
  }

  const checklists = list<unknown>(raw.checklists, 50).filter(isObject).map(c => ({
    name: text(c.name, 200),
    items: list<unknown>(c.items, 200).filter(isObject).map(i => ({ name: text(i.name, 300), resolved: i.resolved === true })),
  }))
  const subtasks = list<unknown>(raw.subtasks, 200).filter(isObject).map(s => ({ id: text(s.id, 64), name: text(s.name, 500), status: text(s.status, 100) }))
  const history = Array.isArray(raw.status_history)
    ? list<unknown>(raw.status_history, 200).filter(isObject).map(h => ({ status: text(h.status, 100), since: istToIso(h.since) }))
    : null

  return {
    ok: true,
    row: {
      clickup_id: raw.clickup_id,
      clickup_custom_id: text(raw.custom_id, 64) || null,
      order_no: /^\d{1,6}$/.test(String(raw.order_no ?? '')) ? String(raw.order_no) : null,
      name,
      client_name: clientNameOf(name),
      status: text(raw.status, 100).toLowerCase(),
      created_in_clickup: istToIso(raw.created_at),
      updated_in_clickup: istToIso(raw.updated_at),
      closed_in_clickup: istToIso(raw.closed_at),
      start_date: dayOnly(raw.start_date),
      due_date: dayOnly(raw.due_date),
      created_by_name: text(raw.created_by, 120),
      assignees: list<unknown>(raw.assignees, 50).map(a => text(a, 120)).filter(Boolean),
      tags: list<unknown>(raw.tags, 50).map(t => text(t, 120)).filter(Boolean),
      priority: text(raw.priority, 50),
      description: text(raw.description, 100000),
      fields,
      checklists,
      subtasks,
      status_history: history,
      comments,
      files,
    },
  }
}

// ── What the screens show ──

export const DRAFT_STATUS_TABS = [
  { key: 'running orders', label: 'Running orders' },
  { key: 'ready for dispatch', label: 'Ready for dispatch' },
  { key: 'hold', label: 'On hold' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'dispatched', label: 'Dispatched' },
] as const

export function statusLabel(status: string): string {
  const known = DRAFT_STATUS_TABS.find(t => t.key === status)
  if (known) return known.label
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : '—'
}

/** The fields people look for first, in this order; the rest follow alphabetically. */
const FIRST_FIELDS = [
  'New Project Code', 'Project Code', 'Confirm Date', 'Total Product Value', 'Lead Source', 'Phone', 'Email', 'Location',
  'Customer Type', 'Company', 'CUSTOMER BILLING', 'CUSTOMER SHIPPING', 'Requirement',
  'Order Status', 'Factory Status', 'FABRIC STATUS', 'FINISH STATUS', 'Fabric on Drive', 'Finish on Drive', 'Dispatch Date',
]

export function orderedFields(fields: Record<string, string>): [string, string][] {
  const rank = (k: string) => { const i = FIRST_FIELDS.indexOf(k); return i < 0 ? FIRST_FIELDS.length : i }
  return Object.entries(fields).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/** A rupee amount typed as text in ClickUp ("361900") for display; anything else is shown as typed. */
export function inr(value: string | undefined): string {
  if (!value) return '—'
  const n = Number(value)
  return Number.isFinite(n) ? `₹${n.toLocaleString('en-IN')}` : value
}

const IST = 'Asia/Kolkata'
export const whenIst = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString('en-IN', { timeZone: IST, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'
export const dayIst = (value: string | null): string =>
  value ? new Date(value.length === 10 ? `${value}T00:00:00+05:30` : value).toLocaleDateString('en-IN', { timeZone: IST, day: 'numeric', month: 'short', year: 'numeric' }) : '—'

// ── The Excel (same three sheets as the export folder's orders.xlsx) ──

export function draftWorkbook(rows: readonly DraftOrder[]): Sheet[] {
  const names = [...new Set(rows.flatMap(r => Object.keys(r.fields)))].sort()
  const clip = (s: string): SheetCell => s.slice(0, 30000)
  const orders: SheetCell[][] = [
    ['Order no', 'Name', 'Status', 'Assignees', 'Created in ClickUp', 'Start', 'Due', 'Tags', 'Files', 'Comments', ...names, 'Description'],
    ...rows.map(r => [
      r.order_no, r.name, statusLabel(r.status), r.assignees.join(', '), whenIst(r.created_in_clickup),
      dayIst(r.start_date), dayIst(r.due_date), r.tags.join(', '), r.file_count, r.comment_count,
      ...names.map(k => r.fields[k] ?? ''), clip(r.description),
    ] as SheetCell[]),
  ]
  const files: SheetCell[][] = [
    ['Order no', 'Order', 'File', 'Uploaded (IST)', 'Uploaded by', 'Size (bytes)'],
    ...rows.flatMap(r => r.files.map(f => [r.order_no, r.name, f.name, whenIst(f.uploaded_at), f.uploaded_by, f.size] as SheetCell[])),
  ]
  const comments: SheetCell[][] = [
    ['Order no', 'Order', 'When (IST)', 'By', 'Comment'],
    ...rows.flatMap(r => r.comments.map(c => [r.order_no, r.name, whenIst(c.at), c.by, clip(c.text)] as SheetCell[])),
  ]
  return [{ name: 'Orders', rows: orders }, { name: 'Files', rows: files }, { name: 'Comments', rows: comments }]
}
