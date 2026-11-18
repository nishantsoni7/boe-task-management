// The Control Center's map, as data.
//
// ONE REGISTRY, FOUR READERS. The sidebar, the Home directory, the page frame
// (breadcrumb, "affects", related settings) and the Find-anything search all
// read this list, so a setting is added once and appears in all four — and
// cannot be findable in one and missing from another.
//
// SIX AREAS, NAMED BY THE JOB. The sidebar used to offer nine groups, four of
// them holding one page each and named after the feature that had just arrived
// ("For you", "Reviews", "Day Close & Scoreboard"); two screens were both called
// "People"; WhatsApp Connection sat in the red Records & Data group. An
// administrator looking for "who can open Finance" or "the next Order number"
// had to guess a group first. An area is something an administrator manages
// ("People", "Orders", "Sales"), a setting lives in exactly ONE area, and the
// sidebar opens the pages of the area you are in, so there are no tabs above
// the page any more.
//
// WHAT IS NOT HERE: pending work (approvals, payments to allocate, change
// requests). It shows on the dashboard of the module that owns it, never in the
// Control Center.

// The main page (Home) still answers three ?tab= values: overview (Home itself) and the two retired
// screens that resolve to a real one (modules, people). Every other screen has its own route.
export type ControlCenterTab = 'overview' | 'people' | 'modules'

export const MAIN_PATH = '/admin/control-center'

const TABS: readonly ControlCenterTab[] = ['people', 'modules']

/** The section the main page shows for a ?tab= value. Anything unknown is Home. */
export function resolveControlCenterTab(tabParam: string | null): ControlCenterTab {
  return TABS.find(t => t === tabParam) ?? 'overview'
}

export type HubId = 'home' | 'people' | 'access' | 'orders' | 'sales' | 'staff' | 'data'

export type NavSection = {
  id: string
  label: string
  /** What the screen is for, in the words an administrator would use. Also the page's subtitle. */
  description: string
  /** The few words under the label on the Home directory. */
  short: string
  /** Who or what a change here touches, said under the title so the weight of a change is known first. */
  affects: string
  /** Other settings worth a look from here, by section id. */
  related: string[]
  href: string
  /** Set only on Home, which is the main page itself (?tab=overview is Home too). */
  tab?: ControlCenterTab
  /** Extra words the search matches — what people type when they do not know the label. */
  keywords: string[]
  /** The change cannot be undone: said in the warning colour. */
  irreversible?: boolean
}

export type NavHub = {
  id: HubId
  label: string
  /** One line under the area's name on the Home directory. */
  blurb: string
  /** Rendered apart from the everyday areas, in the warning colour. */
  danger?: boolean
  sections: NavSection[]
}

export const NAV_HUBS: readonly NavHub[] = [
  {
    id: 'home',
    label: 'Home',
    blurb: 'Find any setting in one step.',
    sections: [{
      id: 'home', label: 'Home', href: MAIN_PATH, tab: 'overview',
      description: 'Find any setting in one step.',
      short: 'Find any setting in one step.', affects: '', related: [],
      keywords: ['overview', 'dashboard', 'summary', 'all settings'],
    }],
  },
  {
    id: 'people',
    label: 'People',
    blurb: 'Who works here: accounts, departments and job titles.',
    sections: [
      {
        id: 'employees', label: 'Employees', href: `${MAIN_PATH}/people`,
        description: 'Add, edit, deactivate or remove an account; reset a password.',
        short: 'Accounts, passwords, status',
        affects: 'Everyone with a BOE account', related: ['departments', 'by-person'],
        keywords: ['staff', 'user', 'account', 'member', 'add employee', 'new employee', 'password', 'reset password',
          'deactivate', 'remove', 'delete employee', 'restore', 'role', 'level', 'designation level', 'email', 'phone'],
      },
      {
        id: 'departments', label: 'Departments', href: `${MAIN_PATH}/departments`,
        description: 'Create, rename, deactivate or delete a department.',
        short: 'Create, rename, retire',
        affects: 'Everyone assigned to a department', related: ['employees', 'designations'],
        keywords: ['team', 'add department', 'rename department', 'delete department', 'who is in'],
      },
      {
        id: 'designations', label: 'Designations', href: `${MAIN_PATH}/positions`,
        description: 'Job titles that can be chosen on an employee record.',
        short: 'Job titles on employee records',
        affects: 'Employee records', related: ['employees'],
        keywords: ['position', 'job title', 'title', 'role name'],
      },
    ],
  },
  {
    id: 'access',
    label: 'Access',
    blurb: 'Who can open what, and who makes which decisions.',
    sections: [
      {
        id: 'by-person', label: 'By person', href: `${MAIN_PATH}/permissions`,
        description: 'One person: what they can open, how much they can do inside, and which decisions are theirs.',
        short: 'What one person can open',
        affects: 'The person you pick', related: ['by-module', 'authorities'],
        keywords: ['permission', 'permissions', 'access control', 'grant', 'revoke', 'can see', 'cannot see', 'level',
          'by employee', 'by person', 'people', 'finance access', 'orders access', 'turn off access', 'remove access'],
      },
      {
        id: 'by-module', label: 'By module', href: `${MAIN_PATH}/permissions/modules`,
        description: 'One module across everyone: who can open it, at what level, and who holds its authorities.',
        short: 'Who can open one module',
        affects: 'Everyone, for one module', related: ['by-person', 'authorities'],
        keywords: ['who can open', 'who has access', 'by module', 'modules', 'module access', 'module visibility', 'launcher',
          'hide module', 'team access', 'department access'],
      },
      {
        id: 'authorities', label: 'Authorities', href: `${MAIN_PATH}/permissions/authorities`,
        description: 'Every decision granted to a named person, in one list: who can approve, see everything, or move money.',
        short: 'Who can approve or decide',
        affects: 'Named people', related: ['by-person', 'operations-handoff'],
        keywords: ['who can approve', 'approve pi', 'all payments', 'all orders', 'authority', 'authorities',
          'decisions', 'reconcile', 'allocate', 'verify', 'team performance', 'who decides'],
      },
    ],
  },
  {
    id: 'orders',
    label: 'Orders',
    blurb: 'How Confirmed Orders are numbered, announced and handed to production.',
    sections: [
      {
        id: 'order-numbering', label: 'Numbering', href: `${MAIN_PATH}/order-numbering`,
        description: 'The number the next Confirmed Order will be given.',
        short: 'The next Confirmed Order number',
        affects: 'Every new Confirmed Order', related: ['order-notifications'],
        keywords: ['order number', 'next order number', 'sequence', 'cycle', 'confirmed order'],
      },
      {
        id: 'order-notifications', label: 'Notifications', href: `${MAIN_PATH}/order-notifications`,
        description: 'Who is told when a Confirmed Order changes.',
        short: 'Who is told about changes',
        affects: 'People listed as recipients', related: ['order-numbering', 'operations-handoff'],
        keywords: ['order notifications', 'alerts', 'recipients', 'notify'],
      },
      {
        id: 'operations-handoff', label: 'Operations handoff', href: `${MAIN_PATH}/operations-handoff`,
        description: 'Who reviews each approved PI version for production.',
        short: 'Who reviews PIs for production',
        affects: 'Operations reviewers', related: ['authorities', 'order-notifications'],
        keywords: ['operations', 'reviewer', 'pi review', 'production', 'handoff'],
      },
      {
        id: 'order-visibility', label: 'Order visibility', href: `${MAIN_PATH}/order-visibility`,
        description: 'Whose orders each sales candidate can see.',
        short: 'Whose orders sales can see',
        affects: 'Sales candidates', related: ['sales-team'],
        keywords: ['sales', 'see orders', 'visibility', 'salesperson'],
      },
    ],
  },
  {
    id: 'sales',
    label: 'Sales',
    blurb: 'Who uses Sales, whose leads they can read, the company WhatsApp number, and price approval on quotations.',
    sections: [
      {
        id: 'sales-team', label: 'Sales team', href: `${MAIN_PATH}/sales-team`,
        description: 'Who uses Sales, who sees everyone, and whose leads a senior can read.',
        short: 'Who uses Sales and sees leads',
        affects: 'Sales users', related: ['order-visibility', 'by-module'],
        keywords: ['sales', 'leads', 'senior', 'junior', 'manager', 'lead board', 'lead access', 'salesperson', 'view all leads'],
      },
      {
        id: 'whatsapp-connection', label: 'WhatsApp connection', href: `${MAIN_PATH}/whatsapp-connection`,
        description: 'Connect the company WhatsApp number to the Lead Master. It stays on the phone.',
        short: 'Connect the company number',
        affects: 'The Lead Master', related: ['sales-team'],
        keywords: ['whatsapp', 'company number', 'coexistence', 'meta', 'connect number', 'leads'],
      },
      {
        id: 'quotation-price-approval', label: 'Quotation price approval', href: `${MAIN_PATH}/quotation-price-approval`,
        description: 'Price approval limits, who sees price suggestions, and the bank account and UPI QR printed on quotations.',
        short: 'Switch price approval on or off',
        affects: 'Every quotation, and the pricing desk', related: ['sales-team', 'by-module'],
        keywords: ['quotation', 'quotations', 'price approval', 'approve prices', 'pricing desk', 'discount limit',
          'switch off', 'disable', 'ask for price approval', 'price suggestions', 'payment details', 'bank account', 'upi', 'qr code'],
      },
    ],
  },
  {
    id: 'staff',
    label: 'Staff experience',
    blurb: 'What your team sees on their own screens.',
    sections: [
      {
        id: 'announcements', label: 'Announcements', href: `${MAIN_PATH}/announcements`,
        description: 'Publish a notice to chosen employees for a set of dates, and see who has read it.',
        short: 'Notices for chosen people',
        affects: 'Chosen employees', related: ['for-you'],
        keywords: ['notice', 'broadcast', 'message', 'publish', 'news', 'read receipts'],
      },
      {
        id: 'for-you', label: 'For you column', href: `${MAIN_PATH}/for-you`,
        description: 'Decide what can appear in the right-hand column on Modules. Keep it to what needs attention now.',
        short: 'Right-hand column on Modules',
        affects: 'Every employee, on Modules', related: ['announcements'],
        keywords: ['for you', 'right column', 'right side', 'side panel', 'modules panel', 'cards', 'urgent', 'immediate',
          'payment request', 'always on', 'customize'],
      },
      {
        id: 'review-rankings', label: 'Review leaderboard', href: `${MAIN_PATH}/review-rankings`,
        description: 'Show or hide the review leaderboard for every employee.',
        short: 'Show or hide the ranking',
        affects: 'Every employee', related: ['day-close-switch'],
        keywords: ['leaderboard', 'ranking', 'rankings', 'hide ranking', 'show ranking', 'review ranking', 'top reviewer',
          'points', 'customer reviews', 'who leads', 'reviews'],
      },
      {
        id: 'day-close-switch', label: 'Day Close & Scoreboard', href: `${MAIN_PATH}/day-close`,
        description: 'Switch Day Close and the Scoreboard on for the team when you have introduced them, or pause them.',
        short: 'Go live or pause for the team',
        affects: 'The whole team', related: ['review-rankings'],
        keywords: ['day close', 'scoreboard', 'score', 'strike', 'strikes', 'plan due', 'pause', 'hide', 'go live', 'introduce',
          'team today', 'close my day', 'proof', 'leave lock', 'red strip'],
      },
    ],
  },
  {
    id: 'data',
    label: 'Data & Safety',
    blurb: 'Removing test data and task records. Some of this cannot be undone.',
    danger: true,
    sections: [
      {
        id: 'test-data-cleanup', label: 'Test data cleanup', href: `${MAIN_PATH}/test-data-cleanup`,
        description: 'Remove one complete verified test transaction while the system is in testing.',
        short: 'Remove one test transaction',
        affects: 'One test transaction', related: ['data-management'],
        keywords: ['delete test order', 'remove test data', 'cleanup', 'purge', 'test order'],
      },
      {
        id: 'data-management', label: 'Data management', href: `${MAIN_PATH}/data-management`,
        description: 'Clear all operational Order and Finance data. Admin only, and never reversible.',
        short: 'Clear all Order and Finance data',
        affects: 'All Order and Finance data. Never reversible.', related: ['test-data-cleanup'],
        irreversible: true,
        keywords: ['reset', 'wipe', 'clear data', 'delete all', 'orders data', 'finance data'],
      },
      {
        id: 'task-records', label: 'Task records', href: '/super-admin',
        description: 'Member-wise task reporting and permanent task deletion.',
        short: 'Task reports and deletion',
        affects: 'Task history', related: ['data-management'],
        keywords: ['tasks', 'delete task', 'super admin', 'task report'],
      },
    ],
  },
]

/** Every section of every hub, flat, each remembering its hub. */
export const NAV_SECTIONS: readonly (NavSection & { hub: NavHub })[] =
  NAV_HUBS.flatMap(hub => hub.sections.map(s => ({ ...s, hub })))

/** The jobs done most often, straight to the screen. Home draws them; the empty search offers them too. */
export const COMMON_JOBS: readonly { id: string; label: string; href: string; sectionId: string }[] = [
  { id: 'add-employee', label: 'Add an employee', href: `${MAIN_PATH}/people?new=1`, sectionId: 'employees' },
  { id: 'reset-password', label: 'Reset a password', href: `${MAIN_PATH}/people`, sectionId: 'employees' },
  { id: 'change-access', label: 'Change someone’s access', href: `${MAIN_PATH}/permissions`, sectionId: 'by-person' },
  { id: 'announce', label: 'Publish an announcement', href: `${MAIN_PATH}/announcements`, sectionId: 'announcements' },
  { id: 'next-number', label: 'Set the next Order number', href: `${MAIN_PATH}/order-numbering`, sectionId: 'order-numbering' },
]

export function sectionById(id: string): (NavSection & { hub: NavHub }) | undefined {
  return NAV_SECTIONS.find(s => s.id === id)
}

/**
 * The six screens that used to be ?tab= views of the main page (before 2026-11-15 they had no address of
 * their own, so Back skipped them and none could be linked to). Each now has a route; the old address
 * still works because next.config.ts redirects it, reading THIS list so the two cannot drift. A section's
 * id is its old tab value.
 */
export const LEGACY_TAB_SCREENS = [
  'departments', 'order-numbering', 'order-notifications', 'operations-handoff', 'order-visibility', 'sales-team',
] as const

export const LEGACY_TAB_REDIRECTS: readonly { tab: string; href: string }[] =
  LEGACY_TAB_SCREENS.map(tab => ({ tab, href: sectionById(tab)!.href }))

export type NavLocation = { pathname: string; tab: ControlCenterTab | null }

/** Is this section the one on screen? */
export function isSectionActive(section: NavSection, { pathname, tab }: NavLocation): boolean {
  if (section.tab) {
    if (pathname !== MAIN_PATH) return false
    if (section.tab === 'overview') return tab === null || tab === 'overview'
    return tab === section.tab
  }
  return pathname === section.href
}

/**
 * The section on show. Two retired ?tab= values still resolve: ?tab=modules is By module,
 * and ?tab=people lands on Employees. A screen outside the map answers null.
 */
export function activeSection(loc: NavLocation): (NavSection & { hub: NavHub }) | null {
  if (loc.pathname === MAIN_PATH && loc.tab === 'modules') return sectionById('by-module') ?? null
  if (loc.pathname === MAIN_PATH && loc.tab === 'people') return sectionById('employees') ?? null
  return NAV_SECTIONS.find(s => isSectionActive(s, loc)) ?? null
}

/** The hub holding the screen on show, or null for one outside the map. */
export function activeHub(loc: NavLocation): NavHub | null {
  return activeSection(loc)?.hub ?? null
}

/** Where a hub's sidebar entry goes: its first section. */
export function hubHref(hub: NavHub): string {
  return hub.sections[0].href
}

// ── Search ───────────────────────────────────────────────────────────────────


const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * Score one destination against a query. Every word of the query must appear
 * somewhere (label, hub, description or keywords), so "delete test" narrows
 * rather than widens; a label match outranks a keyword match, and a label that
 * starts with the query outranks one that merely contains it.
 */
export function scoreSection(section: NavSection & { hub: NavHub }, query: string): number {
  const q = norm(query)
  if (!q) return 0
  const label = norm(section.label)
  const hub = norm(section.hub.label)
  const keywords = section.keywords.map(norm)
  const description = norm(`${section.description} ${section.short}`)

  let total = 0
  for (const word of q.split(' ')) {
    let best = 0
    if (label.startsWith(word)) best = 100
    else if (label.includes(word)) best = 80
    else if (keywords.some(k => k.startsWith(word) || k.split(' ').some(w => w.startsWith(word)))) best = 60
    else if (hub.includes(word)) best = 40
    else if (description.includes(word)) best = 20
    if (best === 0) return 0
    total += best
  }
  return total
}

export function searchSections(query: string): (NavSection & { hub: NavHub })[] {
  return NAV_SECTIONS
    .map(s => ({ s, score: scoreSection(s, query) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(x => x.s)
}
