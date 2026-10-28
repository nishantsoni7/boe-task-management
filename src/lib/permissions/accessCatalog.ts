import { isActionEnforced } from './enforcement'
import {
  entryActionForModule,
  isProtectedAction,
  standardActionsForLevel,
  actionDependencyChain,
  type PresetLevel,
} from './levels'
import { isSelfServiceModule } from '@/lib/moduleAccess'
import { PROTECTED_ACTION_WORDS, MODULE_SCOPED_ACTION_WORDS } from './accessControlChanges'

// ── The access catalogue: what the Control Center OFFERS, in plain words ─────
//
// The Access screens (People, Modules, Authorities) show an administrator two
// kinds of control per module:
//
//   a LEVEL    Off, or how much of the everyday work the person may do:
//              Viewer / Contributor / Manager. A level is a set of STANDARD
//              actions (view, create, edit, approve, export) — see levels.ts.
//   AUTHORITIES the decisions granted per person: every PROTECTED action the
//              module registers (levels.ts). Each is a chip with its meaning
//              written next to it.
//
// THE RULE THAT SHAPES BOTH: only a control that changes behaviour is offered.
// Which actions change behaviour is the enforcement map (enforcement.ts), the
// one place that answers that question and the one the tests pin to the code.
// So:
//
//   * a level is offered only when its ENFORCED standard actions differ from
//     the level below it. Orders registers `export`, but nothing reads it, so
//     Manager would add nothing over Contributor there — and is not offered.
//     Finance's Manager adds `approve` (payment verification), so it is.
//   * a module whose only enforced standard action is entry is a two-state
//     control (Off / On) rather than a ladder of identical rungs.
//   * an action that is registered but read by nothing is HIDDEN: never
//     drawn, never written by a level, and reported by hiddenActions() so the
//     dossier and the tests can say exactly what is withheld. Existing stored
//     grants of hidden actions are left untouched; nothing reads them.
//
// The WORDS below are the only hand-written part: a sentence per offered
// level, a label and meaning per authority. They are keyed by module and
// action so that a module's registration (modules.ts) and its words cannot
// drift apart silently — accessCatalog.test.ts fails when a protected,
// enforced action has no words, or when words name an action that is not
// enforced.
//
// Nothing here decides a permission. The resolver decides; these are the
// administrator's reading glasses.

export type OfferedLevel = Exclude<PresetLevel, 'no_access'>
export const OFFERED_LEVEL_ORDER: readonly OfferedLevel[] = ['viewer', 'contributor', 'manager']

export const OFFERED_LEVEL_LABELS: Record<OfferedLevel | 'off' | 'on', string> = {
  off: 'Off', on: 'On', viewer: 'Viewer', contributor: 'Contributor', manager: 'Manager',
}

export type AuthorityWords = {
  /** What the chip says. */
  label: string
  /** One sentence: what the holder can do that others cannot. */
  meaning: string
  /**
   * Granted per person even to an Administrator, because the database door has
   * no role branch (today: orders.approve_order). Mirrors ADMIN_EDITABLE_ACTIONS.
   */
  perPerson?: boolean
}

export type RelatedSetting = {
  /** The decision, in the administrator's words. */
  label: string
  /** Where it is changed. */
  where: string
  href: string
}

export type ModuleWords = {
  /** The Authorities register groups modules under these headings. */
  group: 'Orders' | 'Money' | 'Work' | 'Sales' | 'Sourcing' | 'People & assets'
  /** One line under the module name. */
  blurb: string
  /** A sentence per level that may be offered. The Off/On sentence lives under `on`. */
  levels: Partial<Record<OfferedLevel | 'on', string>>
  authorities: Record<string, AuthorityWords>
  /** Shown on the module header when the module keeps a second rule outside the engine. */
  note?: string
  /** Entry is on for everyone unless switched off (module_permission_actions.default_allowed). */
  defaultOn?: boolean
  /**
   * Offered only on an Administrator's sheet. The owner's decision of
   * 2026-10-29 for Employee Records: a non-admin grant opens a launcher card
   * onto a screen that refuses them, so it is withheld until it has something
   * to offer.
   */
  adminOnly?: boolean
  /** Settings elsewhere in the Control Center that decide something about this module. */
  related?: RelatedSetting[]
}

const CC = '/admin/control-center'

export const MODULE_WORDS: Record<string, ModuleWords> = {
  orders: {
    group: 'Orders',
    blurb: 'PI Drafts, Confirmed Orders, production and dispatch.',
    levels: {
      viewer: 'Open the module and see the PI Drafts and Orders they are named on, plus their Order Visibility scope.',
      contributor: 'Viewer, plus import or create a PI Draft, submit it and revise it.',
    },
    authorities: {
      view_all: { label: 'See all company orders', meaning: 'Every Order and PI in the company, with their activity and amendments, not only the ones they are named on.' },
      approve_order: { label: 'Approve PI / Confirm Order', meaning: 'Review a submitted PI: send it back, reject it, or approve it into a numbered Order. Their own submissions approve themselves.', perPerson: true },
      approve_advance_exception: { label: 'Approve advance exception', meaning: 'Accept or refuse an advance below the standard 40%, on a PI or an Order.' },
      align_production: { label: 'Align a legacy order for production', meaning: 'Only for orders with no PI handoff. Orders with a handoff are aligned by the Operations reviewer.' },
      view_pi_commission: { label: 'See PI middleman commission', meaning: 'Who is paid and how much, on every PI they did not prepare or review.' },
      view_payment_plan: { label: 'See the Payment plan', meaning: 'How much more the client must pay before each dispatch, on a Confirmed Order.' },
      edit_payment_plan: { label: 'Change the Payment plan', meaning: 'Set and change the dispatch lots and their amounts. Changing a lot already marked dispatched stays Admin only.' },
      manage: { label: 'Amend or cancel any Confirmed Order', meaning: 'Change or cancel orders they do not own.' },
      train_customize_image: { label: 'Train Customize image', meaning: 'Review AI attempts, write house rules and approve examples for Edit PI.' },
      can_be_order_assignee: { label: 'Counts as a sales candidate', meaning: 'Treated like the Sales department for Order Visibility and the salesperson dashboards, while outside Sales. Sales members count without it.' },
    },
    related: [
      { label: 'Reviews PI handoffs for Operations', where: 'Order Setup › Operations Handoff', href: `${CC}?tab=operations-handoff` },
      { label: 'Whose orders each salesperson sees', where: 'Order Setup › Order Visibility (owner only)', href: `${CC}?tab=order-visibility` },
    ],
  },
  finance: {
    group: 'Money',
    blurb: 'Payments received, verification, allocations, payment requests, bank statements and cash custody.',
    levels: {
      viewer: 'Open Finance and see the payments and requests they are named on.',
      contributor: 'Viewer, plus record payments and expenses, and add a bank credit as a Confirmed Payment.',
      manager: 'Contributor, plus verify, reject or ask for clarification on a payment.',
    },
    authorities: {
      view_all: { label: 'See all company payments', meaning: 'Every payment, request and bank line in the company.' },
      allocate: { label: 'Allocate payments', meaning: 'Decide which PI or Order a verified payment belongs to.' },
      allocate_correct: { label: 'Correct allocations', meaning: 'Move or undo an allocation that has already been recorded.' },
      verify_own_payment: { label: 'Verify own payments', meaning: 'Record and verify a payment in one step, and decide payments they recorded themselves.' },
      reconcile: { label: 'Reconcile bank statements', meaning: 'Upload bank statements and match bank credits to payments.' },
      reimburse: { label: 'Reimburse expenses', meaning: 'Pay staff back for expenses and reverse a reimbursement; sees every reimbursement.' },
      manage: { label: 'Correct anyone’s payment records', meaning: 'Link, unlink and correct payment records entered by others, and edit or delete their expenses.' },
      delete: { label: 'Delete others’ unapproved requests', meaning: 'Remove another person’s payment request before it is verified. Deleting a confirmed payment stays Admin only.' },
    },
  },
  task_management: {
    group: 'Work',
    blurb: 'Create, assign and track tasks across the team.',
    levels: { on: 'Open Task Management and work the tasks assigned to them or created by them.' },
    authorities: {
      view_quotations: { label: 'See quotation requests and prices', meaning: 'Customer contact details and quoted commercial terms on quotation tasks.' },
      manage_quotations: { label: 'Submit quotation requests', meaning: 'Create and send quotation requests.' },
    },
  },
  meetings: {
    group: 'Work',
    blurb: 'Structured order-review meetings, SKU updates and follow-ups.',
    levels: {
      viewer: 'Open Meetings and see the meetings they lead, created or attended.',
      contributor: 'Viewer, plus create meetings, conduct and update any open meeting they can see, and import a PI workbook.',
    },
    authorities: {
      manage: { label: 'See and run every meeting', meaning: 'Every meeting in the company, and the authority to complete or reopen one.' },
      delete: { label: 'Delete meetings', meaning: 'Remove any draft meeting.' },
    },
  },
  vendors: {
    group: 'Sourcing',
    blurb: 'Outsourcing vendor base and a log of every visit, with photographs and location.',
    levels: {
      viewer: 'Open Vendors and read every vendor, visit, photograph and note.',
      contributor: 'Viewer, plus add vendors, log visits, edit profiles and move a vendor between Potential and Contacted.',
      manager: 'Contributor, plus decide the later stages, archive or restore, set the back-dating limit and see Visit Activity.',
    },
    authorities: {
      view_all: { label: 'See Visit Activity (read only)', meaning: 'The visit report, without the authority to decide anything.' },
    },
  },
  inventory: {
    group: 'Sourcing',
    blurb: 'Furniture stock for sale: stage, condition, availability and booking requests.',
    levels: {
      viewer: 'Open Inventory, see every product, request a booking and follow their own requests.',
      contributor: 'Viewer, plus add and edit products.',
      manager: 'Contributor, plus confirm, reject or reverse any booking request.',
    },
    authorities: {
      delete: { label: 'Delete products', meaning: 'Remove a product from stock (kept in history).' },
    },
  },
  exhibition_leads: {
    group: 'Sales',
    blurb: 'Capture visitors at an exhibition and follow them up afterwards.',
    levels: { on: 'Capture leads and work the ones they currently own; appear in the ranking.' },
    authorities: {
      view_all: { label: 'See every lead', meaning: 'Read-only sight of everyone’s leads and sheets; the holder is left out of the ranking.' },
    },
  },
  assets_access: {
    group: 'People & assets',
    blurb: 'Assigned devices and the access register.',
    defaultOn: true,
    levels: {
      viewer: 'On for everyone by default: see their own assets and access records, accept handovers, request a change to their own asset.',
      contributor: 'Viewer, plus add and edit asset records and see the whole company inventory.',
    },
    authorities: {
      assign: { label: 'Hand out assets', meaning: 'Give an available asset to an employee (and see the whole inventory).' },
      manage: { label: 'Return, transfer or write off assets', meaning: 'Transfer, return, mark lost or recovered, repair, retire or restore, and decide change requests.' },
      manage_access_records: { label: 'Manage the access register', meaning: 'Read, add and edit every employee’s login and credential records.' },
      manage_asset_catalogue: { label: 'Manage the asset catalogue', meaning: 'Add, rename and retire the categories and products assets are filed under.' },
      delete: { label: 'Delete asset records', meaning: 'Remove an asset that has no history yet. Purging one with history stays Admin only.' },
    },
  },
  performance: {
    group: 'People & assets',
    blurb: 'Daily performance scores, EOD reports and trends.',
    levels: { on: 'Personal Performance: their own score, month, daily history and EOD report.' },
    authorities: {
      view_team: { label: 'Team Performance', meaning: 'Scores, rankings and EOD discipline of the people in their department.' },
      view_all: { label: 'Every employee in Team Performance', meaning: 'The whole company, not only their own department.' },
    },
    related: [
      { label: 'Included in Performance (measured, not access)', where: 'People › Employee', href: `${CC}/people` },
    ],
  },
  sample_tracking: {
    group: 'Sourcing',
    blurb: 'Request catalogues, track dispatch and returns.',
    levels: { on: 'Open Sample Tracking, raise a sample request, and see and edit their own requests.' },
    authorities: {
      dispatch: { label: 'Dispatch samples', meaning: 'Move an approved request to Dispatched; also see every request.' },
      receive: { label: 'Receive samples back', meaning: 'Mark a dispatched sample Returned; also see every request.' },
      mark_lost: { label: 'Mark a sample lost', meaning: 'Mark a dispatched sample Lost; also see every request.' },
      close: { label: 'See every sample request', meaning: 'Widens the list to every request. There is no Close action today, whatever the key is called.' },
    },
  },
  customer_review_requests: {
    group: 'Sales',
    blurb: 'Draft reviews for customers; the candidate chooses the WhatsApp recipient.',
    levels: { on: 'Book review cards and run the workflow for a chosen recipient.' },
    authorities: {
      verify: { label: 'Verify reviews and generate drafts', meaning: 'Say a review was really checked, read other people’s tests, and hand one back.' },
    },
    note: 'Administrators hold this module through role rows, not the usual Admin short-circuit: a team “Blocked” rule would close it for an Admin in that team.',
  },
  image_editor: {
    group: 'Work',
    blurb: 'Turn factory photographs into catalogue studio images.',
    levels: {
      viewer: 'Open the Image Editor (download and re-encode only).',
      contributor: 'Viewer, plus generate studio images. Every run is billed.',
    },
    authorities: {},
  },
  showroom_qr: {
    group: 'Sales',
    blurb: 'QR-based showroom enquiries and quotations.',
    levels: { on: 'Open the Showroom admin screens.' },
    authorities: {},
    note: 'Two rules guard this door: this grant AND the Module Visibility rule (Sales department) that the Showroom admin screens still read. Retiring the second is a separate change.',
  },
  employee_records: {
    group: 'People & assets',
    blurb: 'Opens the Employees screen. Everything inside is Admin only.',
    adminOnly: true,
    levels: { on: 'Shows the launcher card; a non-admin is sent away from everything behind it.' },
    authorities: {},
  },
}

export function moduleWords(moduleKey: string): ModuleWords | null {
  return MODULE_WORDS[moduleKey] ?? null
}

/** Attendance and Payroll: self-service only, never granted here. */
export function isSelfServiceModuleKey(moduleKey: string): boolean {
  return isSelfServiceModule(moduleKey)
}

/** Whether this module appears on a person's sheet at all. */
export function isModuleOfferedTo(moduleKey: string, role: string | null | undefined): boolean {
  if (isSelfServiceModule(moduleKey)) return false
  if (MODULE_WORDS[moduleKey]?.adminOnly) return role === 'admin'
  return true
}

// ── Levels ───────────────────────────────────────────────────────────────────

/**
 * The actions a level really grants in this module: the preset's standard set
 * (levels.ts) plus the entry action, kept only where the enforcement map says
 * the action is read. `use` is the entry action of Review Workflow, which
 * registers no `view`, so entry is read off the module's own actions.
 */
export function enforcedActionsForLevel(
  moduleKey: string,
  moduleActionKeys: readonly string[],
  level: OfferedLevel,
): string[] {
  const entry = entryActionForModule(moduleActionKeys)
  const standard = new Set(standardActionsForLevel(level, moduleActionKeys))
  if (entry) standard.add(entry)
  return moduleActionKeys.filter(a => standard.has(a) && isActionEnforced(moduleKey, a))
}

/**
 * The levels worth offering for this module, lowest first: each one adds at
 * least one enforced action over the level before it. A result of one level
 * means the control is Off / On.
 */
export function offeredLevels(moduleKey: string, moduleActionKeys: readonly string[]): OfferedLevel[] {
  const out: OfferedLevel[] = []
  let previous = ''
  for (const level of OFFERED_LEVEL_ORDER) {
    const key = [...enforcedActionsForLevel(moduleKey, moduleActionKeys, level)].sort().join(',')
    if (key === '' || key === previous) continue
    out.push(level)
    previous = key
  }
  return out
}

/** True when the only level worth offering is entry: the control reads Off / On. */
export function isEntryOnly(moduleKey: string, moduleActionKeys: readonly string[]): boolean {
  return offeredLevels(moduleKey, moduleActionKeys).length <= 1
}

/** What the control calls a level in this module: "On" for an entry-only module. */
export function levelLabel(moduleKey: string, moduleActionKeys: readonly string[], level: OfferedLevel | 'off'): string {
  if (level === 'off') return OFFERED_LEVEL_LABELS.off
  if (isEntryOnly(moduleKey, moduleActionKeys)) return OFFERED_LEVEL_LABELS.on
  return OFFERED_LEVEL_LABELS[level]
}

/** The sentence under a module row for the level the person holds. */
export function levelSentence(moduleKey: string, moduleActionKeys: readonly string[], level: OfferedLevel | 'off' | 'custom'): string {
  const words = MODULE_WORDS[moduleKey]
  if (level === 'off') return 'Cannot open this module.'
  if (level === 'custom') return 'A hand-picked mix of permissions. Choose a level to tidy it.'
  if (!words) return ''
  if (isEntryOnly(moduleKey, moduleActionKeys)) return words.levels.on ?? words.levels.viewer ?? ''
  return words.levels[level] ?? ''
}

/** Every standard action any offered level grants — the actions a level write may touch. */
export function offeredStandardActions(moduleKey: string, moduleActionKeys: readonly string[]): string[] {
  const union = new Set<string>()
  for (const level of offeredLevels(moduleKey, moduleActionKeys)) {
    for (const a of enforcedActionsForLevel(moduleKey, moduleActionKeys, level)) union.add(a)
  }
  return moduleActionKeys.filter(a => union.has(a))
}

// ── Authorities ──────────────────────────────────────────────────────────────

export type CatalogAuthority = {
  actionKey: string
  label: string
  meaning: string
  /** The label of the authority this one needs, or "Open" when it needs module entry only. */
  needs: string
  perPerson: boolean
}

/**
 * The per-person decisions this module offers: every PROTECTED action the
 * module registers that the app really reads, in the catalogue's order. An
 * enforced protected action without words still appears (with the shared
 * wording from accessControlChanges.ts), so a new authority is never silently
 * invisible — the test asks for words anyway.
 */
export function authoritiesFor(moduleKey: string, moduleActionKeys: readonly string[]): CatalogAuthority[] {
  const words = MODULE_WORDS[moduleKey]?.authorities ?? {}
  const keys = moduleActionKeys.filter(a => isProtectedAction(a) && isActionEnforced(moduleKey, a))
  const ordered = [...Object.keys(words).filter(k => keys.includes(k)), ...keys.filter(k => !(k in words))]
  return ordered.map(actionKey => {
    const w = words[actionKey]
    const scoped = MODULE_SCOPED_ACTION_WORDS[moduleKey]?.[actionKey]
    const label = w?.label ?? scoped ?? PROTECTED_ACTION_WORDS[actionKey] ?? actionKey
    const meaning = w?.meaning ?? scoped ?? PROTECTED_ACTION_WORDS[actionKey] ?? ''
    const parent = actionDependencyChain(actionKey).find(p => moduleActionKeys.includes(p))
    const needs = parent && isProtectedAction(parent)
      ? (words[parent]?.label ?? PROTECTED_ACTION_WORDS[parent] ?? parent)
      : (parent && parent !== entryActionForModule(moduleActionKeys) && !isProtectedAction(parent)
          ? OFFERED_LEVEL_LABELS.manager
          : 'Open')
    return { actionKey, label, meaning, needs, perPerson: w?.perPerson === true }
  })
}

/**
 * Registered actions that are neither entry, nor granted by an offered level,
 * nor an authority: stored by the database, read by nothing, offered to nobody.
 */
export function hiddenActions(moduleKey: string, moduleActionKeys: readonly string[]): string[] {
  const offered = new Set([
    ...offeredStandardActions(moduleKey, moduleActionKeys),
    ...authoritiesFor(moduleKey, moduleActionKeys).map(a => a.actionKey),
  ])
  return moduleActionKeys.filter(a => !offered.has(a))
}

// ── Reading and writing a person's state for one module ─────────────────────

export type DetectedLevel = OfferedLevel | 'off' | 'custom'

/**
 * The level a person's effective permissions amount to, judged on the OFFERED
 * standard actions only. Authorities are chips of their own and never make a
 * level "custom"; a hand-picked mix of standard actions does.
 */
export function detectOfferedLevel(
  moduleKey: string,
  moduleActionKeys: readonly string[],
  effective: Readonly<Record<string, boolean>>,
): DetectedLevel {
  const entry = entryActionForModule(moduleActionKeys)
  if (!entry || effective[entry] !== true) return 'off'
  const offered = offeredStandardActions(moduleKey, moduleActionKeys)
  const held = offered.filter(a => effective[a] === true).sort().join(',')
  for (const level of [...offeredLevels(moduleKey, moduleActionKeys)].reverse()) {
    const granted = [...enforcedActionsForLevel(moduleKey, moduleActionKeys, level)].sort().join(',')
    if (granted === held) return level
  }
  return 'custom'
}

/**
 * The complete allow/deny map a level choice writes for one module.
 *
 *   a level   every offered standard action set to the level's set; every
 *             AUTHORITY and every hidden action carried through unchanged.
 *             Changing a level keeps the authorities — the owner's decision of
 *             2026-10-29 — because the row shows both and the level is no
 *             longer asked to be the whole truth.
 *   off       every registered action false, hidden ones included, so a grant
 *             nobody reads today cannot come alive in a later cutover for a
 *             person who was switched off (the 2026-07-16 Assets incident).
 *
 * Pure: `current` is read, never written to.
 */
export function desiredForLevel(
  moduleKey: string,
  moduleActionKeys: readonly string[],
  level: OfferedLevel | 'off',
  current: Readonly<Record<string, boolean>>,
): Record<string, boolean> {
  const map: Record<string, boolean> = {}
  if (level === 'off') {
    for (const a of moduleActionKeys) map[a] = false
    return map
  }
  const granted = new Set(enforcedActionsForLevel(moduleKey, moduleActionKeys, level))
  const offered = new Set(offeredStandardActions(moduleKey, moduleActionKeys))
  for (const a of moduleActionKeys) map[a] = offered.has(a) ? granted.has(a) : current[a] === true
  return map
}

/**
 * The map after giving or taking one authority. Giving pulls its dependency
 * chain in (an authority needs somewhere to act, including module entry);
 * taking removes every authority that depended on it. Pure.
 */
export function desiredWithAuthority(
  moduleKey: string,
  moduleActionKeys: readonly string[],
  actionKey: string,
  on: boolean,
  current: Readonly<Record<string, boolean>>,
): Record<string, boolean> {
  const map: Record<string, boolean> = {}
  for (const a of moduleActionKeys) map[a] = current[a] === true
  if (on) {
    map[actionKey] = true
    for (const dep of actionDependencyChain(actionKey)) if (moduleActionKeys.includes(dep)) map[dep] = true
    // Entry comes with the first authority: a chip on a closed module decides nothing.
    const entry = entryActionForModule(moduleActionKeys)
    if (entry && isActionEnforced(moduleKey, entry)) map[entry] = true
    return map
  }
  map[actionKey] = false
  let changed = true
  while (changed) {
    changed = false
    for (const a of moduleActionKeys) {
      if (map[a] && actionDependencyChain(a).some(dep => moduleActionKeys.includes(dep) && !map[dep])) {
        map[a] = false
        changed = true
      }
    }
  }
  return map
}

/** The authorities a person holds in a module, in catalogue order. */
export function heldAuthorities(
  moduleKey: string,
  moduleActionKeys: readonly string[],
  effective: Readonly<Record<string, boolean>>,
): CatalogAuthority[] {
  return authoritiesFor(moduleKey, moduleActionKeys).filter(a => effective[a.actionKey] === true)
}

/** The authorities switching a module Off would take away — what the confirmation names. */
export function authoritiesClearedByOff(
  moduleKey: string,
  moduleActionKeys: readonly string[],
  effective: Readonly<Record<string, boolean>>,
): string[] {
  return heldAuthorities(moduleKey, moduleActionKeys, effective).map(a => a.label)
}

/** Join labels the way a sentence does: "A, B and C". */
export function joinWords(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}
