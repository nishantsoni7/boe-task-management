import type { EffectivePermission } from './types'

/** One spelling of the module key, shared by the routes, the guard and the page. */
export const IMAGE_EDITOR_MODULE_KEY = 'image_editor'

// Image Editor capability derivation.
//
// Two capabilities, two actions, and one rule between them.
//
//   view    → OPEN the module: see its launcher card and load /image-editor.
//   create  → GENERATE: upload a photograph and spend two billable provider
//             requests on it.
//
// THE RULE THIS FILE EXISTS TO STATE: `create` is dormant without `view`.
//
// Control Center lets an administrator leave a child action stored while the
// parent gate is closed — the toggles are not coupled, and turning `view` back
// on restores whatever `create` was. That is the house convention (see
// MODULE_ENTRY_ACTION in the permissions page: "They are dormant, and they come
// back the moment view does"). What it means here is that the stored pair
// (view = false, create = true) is REACHABLE, and must grant nothing.
//
// Elsewhere that gate is applied by RESTRICTIVE row-level security —
// module_entry_open() in 20260905000000, AND-ed with every policy on a module's
// tables. THE IMAGE EDITOR HAS NO TABLES. It stores nothing: no bucket, no
// rows, no history. So there is no RLS to inherit the gate from, and
// resolve_permission() does not apply it either — it returns the raw effective
// value for the action it was asked about, nothing more.
//
// Which is why `canGenerate` below reads BOTH actions rather than just
// `create`. It is not belt-and-braces; without it the dormant-child state would
// be a way to spend money on a module you cannot open.
//
// Note this deliberately does NOT follow deriveMeetingsCapabilities, which
// widens entry (`view || manage || edit || create`) so a stronger grant implies
// the weaker one. That is right for a module whose rows are separately gated.
// Here it would defeat the parent gate outright.
//
// Admins bypass the engine entirely, matching every other cut-over module.

export type ImageEditorCapabilities = {
  /** May see the launcher card and open /image-editor. */
  canOpen: boolean
  /** May upload a photograph and start a generation. Implies canOpen. */
  canGenerate: boolean
}

export const NO_IMAGE_EDITOR_CAPABILITIES: ImageEditorCapabilities = {
  canOpen: false,
  canGenerate: false,
}

export function deriveImageEditorCapabilities(
  role: string | null | undefined,
  permissions: readonly EffectivePermission[],
): ImageEditorCapabilities {
  if (role === 'admin') return { canOpen: true, canGenerate: true }

  // A missing role means the profile read failed, not that the caller is an
  // ordinary employee. Fail closed, exactly as canAccessManagementModule does.
  if (!role) return NO_IMAGE_EDITOR_CAPABILITIES

  const allowed = (actionKey: string) =>
    permissions.some(p => p.actionKey === actionKey && p.allowed)

  const canOpen = allowed('view')
  return {
    canOpen,
    // The parent gate, in one expression.
    canGenerate: canOpen && allowed('create'),
  }
}
