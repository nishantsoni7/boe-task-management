// The Control Center's map, as data.
//
// ONE REGISTRY, THREE READERS. The sidebar, the section tabs above each page
// and the Find-anything search all read this list, so a destination is added
// once and appears in all three — and cannot be findable in one and missing
// from another. The sidebar offers the HUBS (six entries); a hub with more than
// one section shows those sections as tabs above its page.
//
// WHY HUBS. The sidebar used to list every screen: fourteen entries, eight of
// them unrelated items under one "System" heading. An administrator looking for
// "who can open Finance" or "the next Order number" had to scan the whole list
// and guess. A hub is a task area ("People", "Access", "Order Setup"), and the
// screens inside it are one click away and visible together.

export type ControlCenterTab =
  'overview' | 'departments' | 'people' | 'modules' | 'order-numbering' | 'order-notifications'
  | 'operations-handoff' | 'order-visibility'

export const MAIN_PATH = '/admin/control-center'

const TABS: readonly ControlCenterTab[] = [
  'departments', 'people', 'modules', 'order-numbering', 'order-notifications',
  'operations-handoff', 'order-visibility',
]

/** The section the main page shows for a ?tab= value. Anything unknown is Home. */
export function resolveControlCenterTab(tabParam: string | null): ControlCenterTab {
  return TABS.find(t => t === tabParam) ?? 'overview'
}

export type HubId = 'home' | 'people' | 'access' | 'orders' | 'announcements' | 'records'

export type NavSection = {
  id: string
  label: string
  /** What the screen is for, in the words an administrator would use. */
  description: string
  href: string
  /** Set when the section is a ?tab= of the main page. */
  tab?: ControlCenterTab
  /** Extra words the search matches — what people type when they do not know the label. */
  keywords: string[]
}

export type NavHub = {
  id: HubId
  label: string
  /** Shown above the page title; omitted when it would only repeat the title. */
  eyebrow?: string
  /** Rendered apart from the everyday hubs, in the warning colour. */
  danger?: boolean
  sections: NavSection[]
}

const tabHref = (t: ControlCenterTab) => `${MAIN_PATH}?tab=${t}`

export const NAV_HUBS: readonly NavHub[] = [
  {
    id: 'home',
    label: 'Home',
    sections: [{
      id: 'home', label: 'Home', href: tabHref('overview'), tab: 'overview',
      description: 'What is waiting on you, what needs attention, and the common jobs.',
      keywords: ['overview', 'dashboard', 'summary', 'attention', 'pending', 'queue'],
    }],
  },
  {
    id: 'people',
    label: 'People',
    sections: [
      {
        id: 'employees', label: 'Employees', href: `${MAIN_PATH}/people`,
        description: 'Add, edit, deactivate or remove an account; reset a password.',
        keywords: ['staff', 'user', 'account', 'member', 'add employee', 'new employee', 'password', 'reset password',
          'deactivate', 'remove', 'delete employee', 'restore', 'role', 'level', 'designation level', 'email', 'phone'],
      },
      {
        id: 'departments', label: 'Departments', href: tabHref('departments'), tab: 'departments',
        description: 'Create, rename, deactivate or delete a department.',
        keywords: ['team', 'add department', 'rename department', 'delete department', 'who is in'],
      },
      {
        id: 'designations', label: 'Designations', href: `${MAIN_PATH}/positions`,
        description: 'Job titles available on employee records.',
        keywords: ['position', 'job title', 'title', 'role name'],
      },
    ],
  },
  {
    id: 'access',
    label: 'Access',
    sections: [
      {
        id: 'by-employee', label: 'By Employee', href: `${MAIN_PATH}/permissions`,
        description: 'What one person can open and do, module by module.',
        keywords: ['permission', 'permissions', 'access control', 'grant', 'revoke', 'can see', 'cannot see', 'level',
          'finance access', 'orders access'],
      },
      {
        id: 'by-module', label: 'By Module', href: `${MAIN_PATH}/permissions/modules`,
        description: 'One module across everyone: who can open it, at what level.',
        keywords: ['who can open', 'who has access', 'module access', 'module visibility', 'launcher', 'hide module'],
      },
    ],
  },
  {
    id: 'orders',
    label: 'Order Setup',
    sections: [
      {
        id: 'order-numbering', label: 'Numbering', href: tabHref('order-numbering'), tab: 'order-numbering',
        description: 'The number the next Confirmed Order will be given.',
        keywords: ['order number', 'next order number', 'sequence', 'cycle', 'confirmed order'],
      },
      {
        id: 'order-notifications', label: 'Notifications', href: tabHref('order-notifications'), tab: 'order-notifications',
        description: 'Who is told when a Confirmed Order changes.',
        keywords: ['order notifications', 'alerts', 'recipients', 'notify'],
      },
      {
        id: 'operations-handoff', label: 'Operations Handoff', href: tabHref('operations-handoff'), tab: 'operations-handoff',
        description: 'Who reviews each approved PI version for production.',
        keywords: ['operations', 'reviewer', 'pi review', 'production', 'handoff'],
      },
      {
        id: 'order-visibility', label: 'Order Visibility', href: tabHref('order-visibility'), tab: 'order-visibility',
        description: 'Whose orders each sales candidate can see.',
        keywords: ['sales', 'see orders', 'visibility', 'salesperson'],
      },
    ],
  },
  {
    id: 'announcements',
    label: 'Announcements',
    sections: [{
      id: 'announcements', label: 'Announcements', href: `${MAIN_PATH}/announcements`,
      description: 'Publish a notice to chosen employees and see who has read it.',
      keywords: ['notice', 'broadcast', 'message', 'publish', 'news', 'read receipts'],
    }],
  },
  {
    id: 'records',
    label: 'Records & Data',
    danger: true,
    sections: [
      {
        id: 'test-data-cleanup', label: 'Test Data Cleanup', href: `${MAIN_PATH}/test-data-cleanup`,
        description: 'Remove one verified test transaction.',
        keywords: ['delete test order', 'remove test data', 'cleanup', 'purge', 'test order'],
      },
      {
        id: 'data-management', label: 'Data Management', href: `${MAIN_PATH}/data-management`,
        description: 'Clear all operational Order and Finance data. Never reversible.',
        keywords: ['reset', 'wipe', 'clear data', 'delete all', 'orders data', 'finance data'],
      },
      {
        id: 'task-records', label: 'Task Records', href: '/super-admin',
        description: 'Member-wise task reporting and permanent task deletion.',
        keywords: ['tasks', 'delete task', 'super admin', 'task report'],
      },
    ],
  },
]

/** Every section of every hub, flat, each remembering its hub. */
export const NAV_SECTIONS: readonly (NavSection & { hub: NavHub })[] =
  NAV_HUBS.flatMap(hub => hub.sections.map(s => ({ ...s, hub })))

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

/** The hub holding the screen on show, or null for one outside the map (Action Queue). */
export function activeHub(loc: NavLocation): NavHub | null {
  // The retired ?tab=modules URL still resolves; it belongs with By Module.
  if (loc.pathname === MAIN_PATH && loc.tab === 'modules') return NAV_HUBS.find(h => h.id === 'access') ?? null
  if (loc.pathname === MAIN_PATH && loc.tab === 'people') return NAV_HUBS.find(h => h.id === 'people') ?? null
  return NAV_HUBS.find(h => h.sections.some(s => isSectionActive(s, loc))) ?? null
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
  const description = norm(section.description)

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
