import type { AssetsView } from '@/components/layout/AssetsLayout'
import type { AssetsAccessCapabilities } from '@/lib/permissions/assetsAccess'

// Which Assets & Access screen a visit lands on.
//
// The module is one page with five views, so its sub-pages (the asset detail
// route, the notifications route) and its notification deep links have to ask
// for a view by name: /assets-access?view=asset-requests.
//
// THE RULE: a URL is a request, not an authorization. Every requested view is
// checked against what this person may actually see, and anything unrecognised
// or unpermitted falls back to the normal landing view. Nothing here is a
// security boundary on its own — RLS is — but a page that renders a management
// screen for someone with no management rights is a bug even when every query
// on it comes back empty.

const ALL_VIEWS: readonly AssetsView[] = [
  'my-assets', 'my-access', 'asset-inventory', 'access-register', 'asset-requests',
]

export function isAssetsView(value: unknown): value is AssetsView {
  return typeof value === 'string' && (ALL_VIEWS as readonly string[]).includes(value)
}

/** May this person open this view at all? */
export function canOpenView(view: AssetsView, caps: AssetsAccessCapabilities): boolean {
  switch (view) {
    // Everyone in the module has their own records, and these two screens
    // ONLY ever show them: both queries are .eq('employee_id', <the signed-in
    // user>) and both are additionally scoped to auth.uid() by RLS. They are
    // also the terminal fallback for every unpermitted request below, so they
    // stay openable unconditionally — refusing them would leave an
    // unauthorized ?view= with nowhere to land.
    case 'my-assets':
    case 'my-access':
      return true
    case 'asset-inventory':
      return caps.canViewAssetInventory
    case 'access-register':
      return caps.canManageAccess
    case 'asset-requests':
      return caps.canReviewAssetRequests || caps.canRequestAssetChanges
  }
}

/**
 * The view to show on load.
 *
 * `inViewMode` is View As: while impersonating, the landing view is always the
 * impersonated person's own records, because that is the whole point of the
 * mode. A management view can still be requested explicitly — the capabilities
 * checked are always the SIGNED-IN user's, so View As never lends authority.
 */
export function resolveInitialView(
  requested: string | null | undefined,
  caps: AssetsAccessCapabilities,
  inViewMode: boolean,
): AssetsView {
  if (isAssetsView(requested) && canOpenView(requested, caps)) return requested
  if (inViewMode) return 'my-assets'
  if (caps.canViewAssetInventory) return 'asset-inventory'
  // Someone whose only grant is the Access Register would otherwise land on an
  // asset screen they hold nothing on. Deliberately checked AFTER the
  // inventory: a person holding both is here to manage assets.
  if (caps.canManageAccess) return 'access-register'
  return 'my-assets'
}

// ─── The two top-level areas ──────────────────────────────────────────────────
//
// The five views are two subjects wearing one navigation. `Assets` answers
// "what equipment exists and who holds it"; `Access Records` answers "which
// logins does each person have". They share nothing but the module.
//
// The area switch is the primary navigation and the sidebar is the detail
// within an area, so both have to agree on which area a view belongs to. That
// mapping is stated once, here, rather than inferred from a view name in the
// component — a screen highlighting the wrong tab is a small bug that reads as
// a broken app.

export type AssetsArea = 'assets' | 'access-records'

export const ASSETS_AREA_LABEL: Record<AssetsArea, string> = {
  'assets':         'Assets',
  'access-records': 'Access Records',
}

/** Which area a view lives in. Total: every view belongs to exactly one. */
export function areaForView(view: AssetsView): AssetsArea {
  return view === 'my-access' || view === 'access-register' ? 'access-records' : 'assets'
}

/**
 * The view to show when someone switches to an area.
 *
 * The strongest screen they may open in that area, falling back to their own
 * records — which everybody may always see, so this can never return a view
 * canOpenView() would refuse.
 */
export function defaultViewForArea(
  area: AssetsArea,
  caps: AssetsAccessCapabilities,
  inViewMode = false,
): AssetsView {
  if (area === 'access-records') {
    // While impersonating, the point is the other person's own records — a
    // management screen would show the signed-in user's authority over
    // everybody, which is not what View As is for.
    return !inViewMode && caps.canManageAccess ? 'access-register' : 'my-access'
  }
  return !inViewMode && caps.canViewAssetInventory ? 'asset-inventory' : 'my-assets'
}
