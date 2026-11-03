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
