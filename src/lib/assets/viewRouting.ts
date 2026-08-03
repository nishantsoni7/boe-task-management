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
  return caps.canViewAssetInventory ? 'asset-inventory' : 'my-assets'
}
