// ── The one Back control: where it goes ──────────────────────────────────────
//
// Every module header carries the same Back button (PageBackButton), left of the
// page title. It answers one question: from THIS page, where does Back go? The
// answer is the same on every page, so it lives here and not in each screen.
//
//   1. This document has pushed an entry of its own  →  POP (router.back()).
//      The reader walked here, so the entry behind us is one of ours: same page,
//      same filters, the list's scroll restored, Forward still works. This is
//      what Task Detail already did; see appHistory.ts for why history.length
//      alone cannot be trusted.
//   2. Nothing of ours behind us (a notification opened in a new window, a
//      bookmark, a pasted link)  →  GO to a named place, because popping would
//      do nothing or leave BOE. That place is the `returnTo` the opener attached
//      (validated by safeReturnPath, never off-site), else one level up.
//
// "One level up" is the path with its last segment dropped, a module's home goes
// to /modules, and /modules itself has nothing further back, so it shows no
// button. A few places need a nudge (PARENT_OVERRIDES) because their parent
// folder is not a page. backTarget.test.ts walks every page in src/app and fails
// if a parent it produces does not exist, so a new route cannot silently get a
// dead Back.

import { returnLabelFor, returnPathFrom } from './recordReturn'

export const MODULES_PATH = '/modules'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

// Where a page goes up to when the plain "drop the last segment" is wrong or
// lands on a folder that is not a page. First match wins; `$1` is a capture.
const PARENT_OVERRIDES: ReadonlyArray<readonly [RegExp, string]> = [
  // An Order's own list is Confirmed Orders, not the Orders dashboard.
  [new RegExp(`^/orders/${UUID}$`, 'i'), '/orders/all'],
  [new RegExp(`^/orders/(${UUID})/dispatch/[^/]+$`, 'i'), '/orders/$1'],
  // Task Detail's own default list; every other Tasks list goes up to the Tasks home.
  [new RegExp(`^/tasks/${UUID}$`, 'i'), '/tasks/my'],
  [/^\/tasks\/[^/]+$/, '/dashboard'],
  // Folders that hold pages but are not pages themselves.
  [/^\/admin\/[^/]+$/, MODULES_PATH],
  [/^\/handover\/[^/]+$/, '/finance'],
  [/^\/payroll\/results\/[^/]+$/, '/payroll'],
  [/^\/samples\/dispatch\/[^/]+$/, '/samples'],
  [/^\/showroom-admin\/inquiry\/[^/]+$/, '/showroom-admin'],
  [/^\/showroom-admin\/products\/[^/]+\/edit$/, '/showroom-admin/products'],
  [/^\/super-admin\/view-user\/[^/]+$/, '/super-admin'],
]

/** The page one level above `pathname`, or null where there is nothing further back (/modules, /). */
export function parentPathFor(pathname: string): string | null {
  const segments = pathname.split('?')[0].split('#')[0].split('/').filter(Boolean)
  if (segments.length === 0) return null
  const bare = `/${segments.join('/')}`
  if (bare === MODULES_PATH) return null
  for (const [pattern, parent] of PARENT_OVERRIDES) if (pattern.test(bare)) return bare.replace(pattern, parent)
  if (segments.length === 1) return MODULES_PATH
  return `/${segments.slice(0, -1).join('/')}`
}

export type BackTarget =
  | { kind: 'history'; label: string }
  | { kind: 'path'; path: string; label: string }

/**
 * Where Back goes from here, or null when this page shows no Back button.
 * `label` is what the button's tooltip says: "Back to Confirmed Orders" when the
 * place is known, plain "Back" when it is not (a popped entry carries no name).
 */
export function backTarget(opts: {
  pathname: string
  search: string
  /** hasInAppHistory() — see appHistory.ts. */
  inAppHistory: boolean
}): BackTarget | null {
  const parent = parentPathFor(opts.pathname)
  if (parent === null) return null
  const returnTo = returnPathFrom(opts.search)
  if (opts.inAppHistory) return { kind: 'history', label: returnTo ? returnLabelFor(returnTo) : 'Back' }
  const path = returnTo ?? parent
  return { kind: 'path', path, label: returnLabelFor(path) }
}
