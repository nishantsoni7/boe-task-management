// Reusable, module-agnostic permission actions. Every module gets these
// for free; a module may also define custom actions beyond this set
// (e.g. 'dispatch', 'reconcile') via PermissionActionDefinition in ./types.

export const SYSTEM_PERMISSION_ACTIONS = [
  'view',
  'create',
  'edit',
  'delete',
  'approve',
  'export',
  'manage',
  'admin',
] as const

export type SystemPermissionAction = (typeof SYSTEM_PERMISSION_ACTIONS)[number]

// Widened so modules can register custom action keys while system actions
// still get editor autocomplete.
export type PermissionAction = SystemPermissionAction | (string & {})
