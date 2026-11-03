import type { createClient } from '@/lib/supabase/client'

// Control Center's Sales team tab: a person's job in Sales, in the owner's words, and the rights that job means. Rights
// are what the database checks; the job is only how they are chosen and shown.

type Supabase = ReturnType<typeof createClient>

export type SalesTeamMember = {
  id: string
  name: string
  is_admin: boolean
  /** Counts as a sales candidate: leads can be allotted to them. */
  candidate: boolean
  view: boolean
  view_all: boolean
  create: boolean
  edit: boolean
  assign: boolean
  juniors: string[]
  /** Leads can be given to them now (sales_lead_can_hold). */
  can_hold: boolean
  /** The choice made for them in Control Center; null follows their job. */
  hold_set: boolean | null
  /** Automatic allotment (20270602000000). Nobody placed yet is Manual only. */
  level: AllotLevel
  takes_export: boolean
  daily_limit: number
}

export const ALLOT_LEVELS = [
  { value: 'senior', label: 'Senior', hint: 'First for Premium leads; shares the rest.' },
  { value: 'mid', label: 'Mid', hint: 'Premium leads when the Seniors are full or away; shares the rest.' },
  { value: 'junior', label: 'Junior', hint: 'Premium leads only after Senior and Mid; shares the rest.' },
  { value: 'backup', label: 'Backup', hint: 'Only when everybody else is full or away.' },
  { value: 'manual', label: 'Manual only', hint: 'Never given a lead automatically.' },
] as const
export type AllotLevel = typeof ALLOT_LEVELS[number]['value']

export async function saveAllotPerson(s: Supabase, user: string, level: AllotLevel, takesExport: boolean, limit: number): Promise<void> {
  const { error } = await s.rpc('set_sales_allot_person', { p_user: user, p_level: level, p_export: takesExport, p_limit: limit })
  if (error) throw new Error('How leads are given to them could not be saved. Try again.')
}

/** The switch and the working days (1 Monday to 7 Sunday) and hours, in India, when website leads are given at once. */
export type AutoAllot = { is_on: boolean; days: number[]; starts: string; ends: string; open_now: boolean }

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

export async function fetchAutoAllot(s: Supabase): Promise<AutoAllot> {
  const { data, error } = await s.rpc('get_sales_auto_allot')
  if (error || !data) throw new Error('The automatic allotment settings could not be loaded.')
  return data as AutoAllot
}

export async function saveAutoAllot(s: Supabase, a: Omit<AutoAllot, 'open_now'>): Promise<AutoAllot> {
  const { data, error } = await s.rpc('set_sales_auto_allot', { p_on: a.is_on, p_days: a.days, p_starts: a.starts, p_ends: a.ends })
  if (error) throw new Error(error.message.startsWith('SALES_INVALID') ? error.message.replace(/^SALES_INVALID:\s*/, '') : 'The settings could not be saved. Try again.')
  return data as AutoAllot
}

export const SALES_ROLES = [
  { value: 'none', label: 'No access', hint: 'Sales does not open for them, and no lead can be given to them.' },
  { value: 'sales', label: 'Salesperson', hint: 'Sees and works their own leads. Can be given leads unless unticked.' },
  { value: 'manager', label: 'Manager', hint: 'Reads everyone\'s leads and the Team page. Works only their own. Given leads only if ticked.' },
  { value: 'lead_manager', label: 'Lead manager', hint: 'Adds, allots and works every lead, and runs imports. Given leads only if ticked.' },
] as const
export type SalesRole = typeof SALES_ROLES[number]['value']

export function roleOf(m: Pick<SalesTeamMember, 'view' | 'view_all' | 'assign'>): SalesRole {
  if (m.assign) return 'lead_manager'
  if (m.view_all) return 'manager'
  return m.view ? 'sales' : 'none'
}

export type RightChange = { moduleKey: 'sales'; actionKey: 'view' | 'view_all' | 'create' | 'edit' | 'assign'; allowed: boolean }

/** Only what differs from what the person holds now. */
export function rightsFor(m: SalesTeamMember, role: SalesRole, adds: boolean): RightChange[] {
  const lead = role === 'lead_manager'
  const wanted = {
    view: role !== 'none',
    view_all: role === 'manager',
    create: lead || (role !== 'none' && adds),
    edit: lead,
    assign: lead,
  }
  return (Object.keys(wanted) as (keyof typeof wanted)[])
    .filter(key => wanted[key] !== m[key])
    .map(key => ({ moduleKey: 'sales', actionKey: key, allowed: wanted[key] }))
}

/** What a job means for being given leads, when nobody has chosen otherwise: a Salesperson yes, everybody else no. */
export const holdsByDefault = (role: SalesRole) => role === 'sales'

/** The choice to keep: null when the tick says what the job means anyway, so a later job change still counts. */
export const holdChoice = (role: SalesRole, ticked: boolean): boolean | null =>
  role === 'none' || ticked === holdsByDefault(role) ? null : ticked

export async function saveHolding(s: Supabase, user: string, canHold: boolean | null): Promise<void> {
  const { error } = await s.rpc('set_sales_lead_holding', { p_user: user, p_can_hold: canHold })
  if (error) throw new Error('Whether leads can be given to them could not be saved. Try again.')
}

export async function fetchSalesTeam(s: Supabase): Promise<SalesTeamMember[]> {
  const { data, error } = await s.rpc('list_sales_team')
  if (error) throw new Error('The Sales team could not be loaded.')
  return (data ?? []) as SalesTeamMember[]
}

export async function saveJuniors(s: Supabase, viewer: string, juniors: string[]): Promise<void> {
  const { error } = await s.rpc('set_sales_lead_juniors', { p_viewer: viewer, p_juniors: juniors })
  if (error) throw new Error('Whose leads they can read could not be saved. Try again.')
}
