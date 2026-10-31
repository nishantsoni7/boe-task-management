// WHAT THE MODULES "FOR YOU" COLUMN CAN SHOW (owner, 2026-10-31).
//
// An administrator sets each item in Control Center: Off, Optional or Always on.
// Each person then turns Optional items off for themselves in Account Settings.
// Both are stored by key (20270513000000), and a key with no stored setting uses
// the default here, so a new item is one entry in this list. A brand-new kind of
// card still needs its own read and its own access rule: this list cannot create
// one, only offer the ones that exist.
//
// THESE SETTINGS NEVER WIDEN ACCESS. Every card reads its own data under the
// reader's own access, so Always on can only ever repeat what a person could
// open anyway. `itemApplies` below decides whose list an item belongs on; it is
// a display question and grants nothing.
//
// Pure, so the test runner can execute it.

export const FOR_YOU_MODES = ['off', 'optional', 'always'] as const
export type ForYouMode = (typeof FOR_YOU_MODES)[number]

export const FOR_YOU_MODE_LABEL: Record<ForYouMode, string> = {
  off: 'Off',
  optional: 'Optional',
  always: 'Always on',
}

export const FOR_YOU_MODE_MEANING: Record<ForYouMode, string> = {
  off: 'Nobody gets it, and it leaves everyone’s options.',
  optional: 'On by default. Each person can turn it off for themselves.',
  always: 'Nobody can turn it off. Use it only for what must not be missed.',
}

export type ForYouAccess = {
  /** The signed-in administrator, not previewing somebody else. */
  admin: boolean
  /** May open Finance. */
  finance: boolean
  /** May open Order Management. */
  orders: boolean
  /** May decide payments and read everyone's: the two are separate grants. */
  verifiesPayments: boolean
  /** May decide a payment they recorded themselves. */
  decidesOwnPayments: boolean
  /** May decide a submitted PI. */
  approvesPis: boolean
  /** Reads everyone's cash: admin, cash custodian or finance.view_all. */
  seesAllCash: boolean
}

export const NO_FOR_YOU_ACCESS: ForYouAccess = {
  admin: false,
  finance: false,
  orders: false,
  verifiesPayments: false,
  decidesOwnPayments: false,
  approvesPis: false,
  seesAllCash: false,
}

/** The panel's button: Account Settings, because the panel is gone when empty. */
export const FOR_YOU_SETTINGS_HREF = '/account?returnTo=%2Fmodules#for-you'

export type ForYouItem = {
  key: string
  label: string
  /** What it tells you, in one short line. */
  meaning: string
  /** Who can receive it, as Control Center says it. */
  audience: string
  /** The same, as Account Settings says it to somebody it does not apply to. */
  forWhom: string
  defaultMode: ForYouMode
  applies: (access: ForYouAccess) => boolean
}

const everyone = () => true

export const FOR_YOU_ITEMS = [
  {
    key: 'payment_request',
    label: 'New payment request',
    meaning: 'A payment is waiting to be verified.',
    audience: 'People who verify payments',
    forWhom: 'for people who verify payments',
    defaultMode: 'optional',
    applies: a => a.verifiesPayments,
  },
  {
    // Always on by default (owner, 2026-10-31): cash can sit unaccepted otherwise.
    key: 'cash_handed_to_you',
    label: 'Cash handed to you',
    meaning: 'Someone handed you cash and you have not accepted it.',
    audience: 'The person receiving it',
    forWhom: 'for the person receiving it',
    defaultMode: 'always',
    applies: everyone,
  },
  {
    key: 'pi_returned',
    label: 'PI returned to you',
    meaning: 'A PI came back and is waiting for you.',
    audience: 'Its salesperson or creator',
    forWhom: 'for its salesperson or creator',
    defaultMode: 'optional',
    applies: a => a.orders,
  },
  {
    key: 'machine_stopped',
    label: 'Attendance machine stopped',
    meaning: 'No punch has reached BOE today.',
    audience: 'Admins',
    forWhom: 'for admins',
    defaultMode: 'optional',
    applies: a => a.admin,
  },
  {
    key: 'leave_late',
    label: 'Leave and late arrival',
    meaning: 'A request is waiting for a decision.',
    audience: 'Admins',
    forWhom: 'for admins',
    defaultMode: 'optional',
    applies: a => a.admin,
  },
  {
    key: 'cash_not_with_company',
    label: 'Cash not with the company',
    meaning: 'Who is holding company cash, by person.',
    audience: 'Admins, custodian, all-payments access',
    forWhom: 'for admins and Finance',
    defaultMode: 'optional',
    applies: a => a.seesAllCash,
  },
  {
    key: 'handover_waiting',
    label: 'Your handover not accepted',
    meaning: 'Cash you gave has not been accepted yet.',
    audience: 'The person who gave it',
    forWhom: 'for the person who gave it',
    defaultMode: 'optional',
    applies: everyone,
  },
  {
    key: 'cash_you_hold',
    label: 'Cash you hold',
    meaning: 'Cash with you, not handed on yet.',
    audience: 'The person holding it',
    forWhom: 'for the person holding it',
    defaultMode: 'optional',
    applies: everyone,
  },
  {
    key: 'announcement',
    label: 'New announcement',
    meaning: 'The newest announcement you have not read.',
    audience: 'The people it was sent to',
    forWhom: 'for the people it was sent to',
    defaultMode: 'optional',
    applies: everyone,
  },
  {
    key: 'pi_waiting_approval',
    label: 'PI waiting for approval',
    meaning: 'A submitted PI needs a decision.',
    audience: 'People who approve PIs',
    forWhom: 'for people who approve PIs',
    defaultMode: 'off',
    applies: a => a.approvesPis,
  },
  {
    key: 'payment_sent_back',
    label: 'Payment sent back to you',
    meaning: 'Finance asked a question about your payment.',
    audience: 'The person who recorded it',
    forWhom: 'for the person who recorded it',
    defaultMode: 'off',
    applies: a => a.finance,
  },
  {
    // Admins only: the Order page offers the review to an acting admin alone.
    key: 'order_change_request',
    label: 'Order change request',
    meaning: 'A change or cancellation is waiting for review.',
    audience: 'Admins',
    forWhom: 'for admins',
    defaultMode: 'off',
    applies: a => a.admin,
  },
  {
    key: 'pi_waiting_operations',
    label: 'PI waiting for Operations',
    meaning: 'A new PI version needs your review.',
    audience: 'The assigned reviewer',
    forWhom: 'for the assigned reviewer',
    defaultMode: 'off',
    applies: a => a.orders,
  },
] as const satisfies readonly ForYouItem[]

export type ForYouItemKey = (typeof FOR_YOU_ITEMS)[number]['key']

/** The company's settings, by key. A key with no entry uses its default. */
export type ForYouModes = Partial<Record<ForYouItemKey, ForYouMode>>

const ITEM_BY_KEY = new Map<string, ForYouItem>(FOR_YOU_ITEMS.map(item => [item.key, item]))

/** Whether a stored string names an item of this list. */
export function isForYouItemKey(key: unknown): key is ForYouItemKey {
  return typeof key === 'string' && ITEM_BY_KEY.has(key)
}

function isForYouMode(mode: unknown): mode is ForYouMode {
  return typeof mode === 'string' && (FOR_YOU_MODES as readonly string[]).includes(mode)
}

/** Stored rows to settings. A row naming no current item or mode is ignored. */
export function readForYouModes(rows: unknown): ForYouModes {
  const modes: ForYouModes = {}
  if (!Array.isArray(rows)) return modes
  for (const row of rows as { item_key?: unknown; mode?: unknown }[]) {
    if (isForYouItemKey(row?.item_key) && isForYouMode(row?.mode)) modes[row.item_key] = row.mode
  }
  return modes
}

/** A stored list to the items it names, without repeats. */
export function readHiddenItems(raw: unknown): ForYouItemKey[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter(isForYouItemKey))]
}

/** The company's setting for one item. */
export function modeOf(modes: ForYouModes, key: ForYouItemKey): ForYouMode {
  return modes[key] ?? ITEM_BY_KEY.get(key)!.defaultMode
}

/** Whether a person who qualifies gets this item. */
export function isItemOn(key: ForYouItemKey, modes: ForYouModes, hidden: readonly ForYouItemKey[]): boolean {
  const mode = modeOf(modes, key)
  if (mode === 'off') return false
  return mode === 'always' || !hidden.includes(key)
}

/** The item is on the person's own list, or under "Not part of your work". */
export function itemApplies(key: ForYouItemKey, access: ForYouAccess): boolean {
  return ITEM_BY_KEY.get(key)!.applies(access)
}

/** The hidden list with one item turned off or back on. */
export function withItemHidden(
  hidden: readonly ForYouItemKey[],
  key: ForYouItemKey,
  hide: boolean,
): ForYouItemKey[] {
  const rest = hidden.filter(k => k !== key)
  return hide ? [...rest, key] : rest
}
