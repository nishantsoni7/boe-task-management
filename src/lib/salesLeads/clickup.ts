import { normalizeLeadPhone } from '@/lib/exhibitionLeads/phone'
import { istAddDays } from '@/lib/istDate'
import type { DeadReason, Segment, Stage, Temperature } from './board'
import { MAX_EMAIL, MAX_LOCATION, MAX_NAME, MAX_REQUIREMENT, type LeadSource } from './constants'

// Reading a ClickUp export and turning it into leads. Everything here runs in the browser and is pure: the Import screen
// shows the result before anything is saved, and import_sales_leads (20270526000100) still decides what is valid.
//
// ClickUp's columns differ from list to list, so a task is read by its column NAME, never by position. A file holds only
// the LATEST comment on each task: older comments are not in the export at all.

export type ClickupTask = Record<string, string>

/** A CSV reader for what ClickUp writes: quoted fields holding commas, doubled quotes and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const body = text.replace(/^﻿/, '')
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (quoted) {
      if (c !== '"') field += c
      else if (body[i + 1] === '"') { field += '"'; i++ } else quoted = false
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' } else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' } else if (c !== '\r') field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows
}

/** The tasks in one file, or null when it is not a ClickUp task export. */
export function readExport(text: string): ClickupTask[] | null {
  const [head, ...rows] = parseCsv(text)
  if (!head?.includes('Task ID') || !head.includes('Status') || !head.includes('Task Name')) return null
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])))
}

/** "Wednesday, July 30th 2025, 4:55:41 pm +05:30" or "Tuesday, September 16th 2025". Null for anything else. */
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const pad = (n: number) => String(n).padStart(2, '0')

export function parseClickupDate(value: string): { day: string; iso: string } | null {
  const m = /([A-Za-z]+) (\d{1,2})(?:st|nd|rd|th) (\d{4})(?:, (\d{1,2}):(\d{2}):(\d{2}) (am|pm) ([+-]\d{2}:\d{2}))?/.exec(value)
  if (!m) return null
  const month = MONTHS.indexOf(m[1].toLowerCase())
  if (month < 0) return null
  const day = `${m[3]}-${pad(month + 1)}-${pad(Number(m[2]))}`
  if (!m[4]) return { day, iso: `${day}T00:00:00+05:30` }
  const hour = (Number(m[4]) % 12) + (m[7] === 'pm' ? 12 : 0)
  return { day, iso: `${day}T${pad(hour)}:${m[5]}:${m[6]}${m[8]}` }
}

type StatusRule = { stage: Stage; temperature?: Temperature; segment?: Segment; step?: string }

/** "important bulk (ak)" and "important bulk (moh)" are one status: every salesperson had their own copy. */
export const statusFamily = (status: string) => status.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase()

// Important Bulk, Bulk, Important Residential and Overseas said what kind of lead it was, not how far it had come. The
// salesperson's own sorting is kept as Warm and Cold, and Overseas is already in the phone number.
const STATUS_RULES: Record<string, StatusRule> = {
  'new leads': { stage: 'new' },
  'under process': { stage: 'under_process' },
  'transferred leads': { stage: 'under_process' },
  'important bulk': { stage: 'under_process', segment: 'bulk' },
  bulk: { stage: 'under_process', segment: 'bulk', temperature: 'cold' },
  'important residential': { stage: 'under_process', segment: 'residential' },
  overseas: { stage: 'under_process' },
  'potential clients': { stage: 'potential' },
  'potential customers': { stage: 'potential' },
  'planned visit': { stage: 'potential', step: 'Meeting' },
  'follow up later on': { stage: 'follow_up_later' },
  'follow up later': { stage: 'follow_up_later' },
  'dead leads': { stage: 'dead' },
  'dead without reason': { stage: 'dead' },
}

/**
 * The stage a task belongs in, or null for a status nobody has decided about. The "All Dead Leads" lists hold three
 * statuses of their own (leads, live again, reference); being in that list is what makes them dead.
 */
export function ruleFor(task: ClickupTask): StatusRule | null {
  const family = statusFamily(task.Status)
  if (/dead/i.test(task.List ?? '') && !(family in STATUS_RULES)) return { stage: 'dead' }
  return STATUS_RULES[family] ?? null
}

const REASONS: Record<string, { reason: DeadReason; note?: string }> = {
  'no response': { reason: 'not_responding' },
  'no requirement': { reason: 'no_requirement' },
  'not relevant': { reason: 'not_relevant' },
  residential: { reason: 'retail_enquiry' },
  'ordered locally': { reason: 'chose_another_supplier' },
  'ordered via competitor': { reason: 'chose_another_supplier' },
  'low quantity': { reason: 'quantity_too_small' },
  'low budget': { reason: 'price_too_high' },
  'high price': { reason: 'price_too_high' },
  'time frame too short': { reason: 'delivery_time' },
  'project cancelled': { reason: 'project_cancelled' },
  'project postponed': { reason: 'project_cancelled' },
  'clash leads with team': { reason: 'other', note: 'Clash with the team' },
  'language problem': { reason: 'other', note: 'Language problem' },
}

export function deadReasonFor(reason: string): { reason: DeadReason; note: string | null } {
  const text = reason.trim()
  if (!text) return { reason: 'other', note: 'No reason recorded in ClickUp' }
  const known = REASONS[text.toLowerCase()]
  return known ? { reason: known.reason, note: known.note ?? null } : { reason: 'other', note: text.slice(0, 2000) }
}

const SOURCES: Record<string, LeadSource> = {
  website: 'website', whatsapp: 'whatsapp', instagram: 'instagram', 'insta promotion': 'insta_promo',
  'facebook promotion': 'facebook_promo', 'google ads': 'google_ads', reference: 'reference',
  'repeat customer': 'repeat_customer', 'fair invitation': 'campaign',
}
export const sourceFor = (source: string): LeadSource => SOURCES[source.trim().toLowerCase()] ?? 'others'

const SEGMENTS: Record<string, Segment> = { bulk: 'bulk', residential: 'residential', reseller: 'reseller' }
const CLIENT_TYPES: Record<string, string> = { 'restaurant consultant': 'restaurant', architect: 'other', others: 'other' }

/** Columns that only describe ClickUp itself, or that are empty on every task. */
const DROPPED = new Set(['Task Type', 'Space', 'Lists', 'Time In Status', 'Points Estimate Rolled Up', 'Subtask URL\'s'])
const rawOf = (task: ClickupTask) =>
  Object.fromEntries(Object.entries(task).filter(([k, v]) => !DROPPED.has(k) && v.trim() && !['[]', 'none', '0'].includes(v.trim())))

const phoneIn = (text: string) => normalizeLeadPhone(text.replace(/[^\d+]/g, ''))
const isPhoneLike = (name: string) => /^[+\d\s()-]{7,}$/.test(name.trim())
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** One lead as import_sales_leads takes it. */
export type ImportRow = {
  task_id: string
  phone: string
  name: string | null
  email: string | null
  location: string | null
  requirement: string | null
  source: LeadSource
  stage: Stage
  temperature: Temperature
  segment: string | null
  client_type: string | null
  dead_reason: DeadReason | null
  dead_note: string | null
  holder_id: string | null
  next_step: string | null
  next_due_on: string | null
  created_at: string
  updated_at: string
  comment_count: number
  latest_comment: string | null
  clickup_status: string
  raw: Record<string, string>
}

/** A task that became a lead, and what the plan needs to know about it that is not saved. */
export type PlannedLead = ImportRow & { folder: string; family: string; clickupDue: string | null }
export type Refused = { taskId: string; name: string; folder: string; status: string; why: string }

export function mapTask(task: ClickupTask): PlannedLead | Refused {
  const refused = (why: string): Refused => ({ taskId: task['Task ID'], name: task['Task Name'], folder: task.Folder, status: task.Status, why })
  const rule = ruleFor(task)
  if (!rule) return refused(`Status not known: ${task.Status}`)
  const phone = phoneIn(task['Phone (phone)'] ?? '') ?? phoneIn(task['Task Name'])
  if (!phone) return refused('No valid number')
  const created = parseClickupDate(task['Date Created'])
  const updated = parseClickupDate(task['Date Updated']) ?? created
  if (!created || !updated) return refused('No date')

  const tags = task.tags ?? ''
  const hot = ['URGENT', 'HIGH'].includes(task.Priority) || /\b(imp|urgent)\b/.test(tags)
  const type = (task['Customer Type (drop down)'] ?? '').trim().toLowerCase()
  const dead = rule.stage === 'dead' ? deadReasonFor(task['Reasons (drop down)'] ?? '') : null
  const email = (task['Email (email)'] ?? '').trim()
  const requirement = [task['Requirement (text)'], task['Task Content']].map(t => (t ?? '').trim()).filter(Boolean)
  const name = task['Task Name'].trim()
  const comment = task['Latest Comment'].trim()

  return {
    task_id: task['Task ID'],
    phone,
    name: name && !isPhoneLike(name) ? name.slice(0, MAX_NAME) : null,
    email: email.length <= MAX_EMAIL && EMAIL.test(email) ? email : null,
    location: (task['Location (short text)'] ?? '').trim().slice(0, MAX_LOCATION) || null,
    requirement: [...new Set(requirement)].join('\n').slice(0, MAX_REQUIREMENT) || null,
    source: sourceFor(task['Lead Source (drop down)'] ?? ''),
    stage: rule.stage,
    temperature: hot ? 'hot' : rule.temperature ?? 'warm',
    segment: SEGMENTS[type] ?? rule.segment ?? null,
    client_type: CLIENT_TYPES[type] ?? null,
    dead_reason: dead?.reason ?? null,
    dead_note: dead?.note ?? null,
    holder_id: null,
    next_step: rule.stage === 'dead' ? null : rule.step ?? 'Call back',
    next_due_on: null,
    created_at: created.iso,
    updated_at: updated.iso,
    comment_count: Number(task['Comment Count']) || 0,
    latest_comment: comment || null,
    clickup_status: task.Status,
    raw: rawOf(task),
    folder: task.Folder,
    family: statusFamily(task.Status),
    clickupDue: parseClickupDate(task['Due Date'] ?? '')?.day ?? null,
  }
}

const STAGE_ORDER: Record<string, number> = { negotiation: 0, potential: 1, under_process: 2, new: 3, follow_up_later: 4 }
const TEMPERATURE_ORDER: Record<Temperature, number> = { hot: 0, warm: 1, cold: 2 }
const isSunday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay() === 0

/** The next working day on or after `day`. */
export function workingDay(day: string): string {
  return isSunday(day) ? istAddDays(day, 1) : day
}

/**
 * Nobody should open BOE One to a wall of red. A follow-up that is still ahead keeps its date. One that is overdue, or
 * never had a date, gets a new one: a lead nobody has called first, then Hot, then the furthest along, then the most
 * recently touched, no more than `perDay` to a person on any working day.
 */
export function spreadFollowUps(leads: readonly PlannedLead[], perDay: number, today: string): PlannedLead[] {
  const out = leads.map(l => ({ ...l }))
  const open = out.filter(l => l.stage !== 'dead')
  const load = new Map<string, number>()
  const key = (folder: string, day: string) => `${folder}|${day}`
  for (const l of open) {
    if (l.clickupDue && l.clickupDue >= today) {
      l.next_due_on = l.clickupDue
      load.set(key(l.folder, l.clickupDue), (load.get(key(l.folder, l.clickupDue)) ?? 0) + 1)
    }
  }
  const waiting = open.filter(l => !l.next_due_on).sort((a, b) =>
    Number(a.comment_count > 0) - Number(b.comment_count > 0)
    || TEMPERATURE_ORDER[a.temperature] - TEMPERATURE_ORDER[b.temperature]
    || STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage]
    || b.updated_at.localeCompare(a.updated_at))
  const next = new Map<string, string>()
  for (const l of waiting) {
    let day = next.get(l.folder) ?? workingDay(today)
    while ((load.get(key(l.folder, day)) ?? 0) >= perDay) day = workingDay(istAddDays(day, 1))
    l.next_due_on = day
    load.set(key(l.folder, day), (load.get(key(l.folder, day)) ?? 0) + 1)
    next.set(l.folder, day)
  }
  return out
}

export type FolderPlan = { folder: string; open: number; dead: number; replanned: number; lastDay: string | null }
export type StatusPlan = { family: string; stage: Stage; temperature: Temperature; n: number }
export type ImportPlan = {
  /** Every lead to save, the one that survives for each number first. */
  rows: PlannedLead[]
  tasks: number
  /** Tasks that repeat in more than one file. */
  repeats: number
  /** Tasks that will become a note on another lead with the same number. */
  samePhone: number
  open: number
  dead: number
  refused: Refused[]
  folders: FolderPlan[]
  statuses: StatusPlan[]
}

/** Everything the Import screen shows, from the files as read. Holders are given by `withHolders` afterwards. */
export function buildPlan(files: readonly ClickupTask[][], perDay: number, today: string): ImportPlan {
  const byId = new Map<string, ClickupTask>()
  let all = 0
  for (const tasks of files) for (const t of tasks) {
    all++
    const seen = byId.get(t['Task ID'])
    const when = (x: ClickupTask) => parseClickupDate(x['Date Updated'])?.iso ?? ''
    if (!seen || when(t) > when(seen)) byId.set(t['Task ID'], t)
  }

  const leads: PlannedLead[] = []
  const refused: Refused[] = []
  for (const task of byId.values()) {
    const m = mapTask(task)
    if ('why' in m) refused.push(m)
    else leads.push(m)
  }

  // An open lead beats a dead one on the same number, then the one touched last. The rest go on it as notes.
  leads.sort((a, b) => Number(a.stage === 'dead') - Number(b.stage === 'dead') || b.updated_at.localeCompare(a.updated_at))
  const keep = new Set<string>()
  const first: PlannedLead[] = []
  const later: PlannedLead[] = []
  for (const l of leads) {
    if (keep.has(l.phone)) later.push(l)
    else { keep.add(l.phone); first.push(l) }
  }

  const planned = [...spreadFollowUps(first, perDay, today), ...later]
  const folders = new Map<string, FolderPlan>()
  for (const l of first) {
    const f = folders.get(l.folder) ?? { folder: l.folder, open: 0, dead: 0, replanned: 0, lastDay: null }
    if (l.stage === 'dead') f.dead++
    else f.open++
    folders.set(l.folder, f)
  }
  for (const l of planned.slice(0, first.length)) {
    if (l.stage === 'dead') continue
    const f = folders.get(l.folder)!
    if (l.clickupDue !== l.next_due_on) {
      f.replanned++
      if (!f.lastDay || (l.next_due_on ?? '') > f.lastDay) f.lastDay = l.next_due_on
    }
  }
  const statuses = new Map<string, StatusPlan>()
  for (const l of first) {
    const k = `${l.family}|${l.stage}|${l.temperature}`
    const s = statuses.get(k) ?? { family: l.family, stage: l.stage, temperature: l.temperature, n: 0 }
    s.n++
    statuses.set(k, s)
  }

  return {
    rows: planned,
    tasks: byId.size,
    repeats: all - byId.size,
    samePhone: later.length,
    open: first.filter(l => l.stage !== 'dead').length,
    dead: first.filter(l => l.stage === 'dead').length,
    refused,
    folders: [...folders.values()].sort((a, b) => b.open - a.open || a.folder.localeCompare(b.folder)),
    statuses: [...statuses.values()].sort((a, b) => b.n - a.n),
  }
}

/** The person a ClickUp folder most likely is: same first name, and only one such person. */
export function guessHolder(folder: string, people: readonly { id: string; full_name: string }[]): string | null {
  const firstName = (s: string) => s.trim().split(/\s+/)[0].toLowerCase()
  const same = people.filter(p => firstName(p.full_name) === firstName(folder))
  return same.length === 1 ? same[0].id : null
}

/** What goes to the database. A lead nobody holds has no date to keep. */
export function toSave(plan: ImportPlan, holders: Readonly<Record<string, string | null>>): ImportRow[] {
  return plan.rows.map(({ folder, family: _family, clickupDue: _clickupDue, ...row }) => {
    const holder = holders[folder] ?? null
    return { ...row, holder_id: holder, next_step: holder ? row.next_step : null, next_due_on: holder ? row.next_due_on : null }
  })
}
