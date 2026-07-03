import type { PermissionAction } from './constants'

// Which level of the hierarchy decided an effective permission.
// Precedence (lowest → highest): system_default < role < department < employee_override.
export type PermissionLevel = 'system_default' | 'role' | 'department' | 'employee_override'

export interface PermissionActionDefinition {
  actionKey: PermissionAction
  displayName: string
  /** System Default level: allowed when no role/department/employee override says otherwise. Defaults to false (deny). */
  defaultAllowed?: boolean
}

// What a module declares when it registers with the permission engine.
export interface PermissionModuleDefinition {
  moduleKey: string
  displayName: string
  description?: string
  actions: PermissionActionDefinition[]
}

export interface EffectivePermission {
  actionKey: string
  allowed: boolean
  source: PermissionLevel
}

// ─── DB row shapes (mirrors supabase/migrations/20260660_create_permission_engine.sql) ──

export type PermissionModuleRow = {
  id: string
  module_key: string
  display_name: string
  description: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export type PermissionActionRow = {
  id: string
  action_key: string
  display_name: string
  is_system: boolean
  created_at: string
}

export type ModulePermissionActionRow = {
  id: string
  module_id: string
  action_id: string
  default_allowed: boolean
  created_at: string
}

export type RolePermissionRow = {
  id: string
  role: string
  module_id: string
  action_id: string
  allowed: boolean
  created_at: string
  updated_at: string
}

export type DepartmentPermissionRow = {
  id: string
  department_id: string
  module_id: string
  action_id: string
  allowed: boolean
  created_at: string
  updated_at: string
}

export type EmployeePermissionOverrideRow = {
  id: string
  user_id: string
  module_id: string
  action_id: string
  allowed: boolean
  granted_by: string
  granted_at: string
  revoked_by: string | null
  revoked_at: string | null
}
