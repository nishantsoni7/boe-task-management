import type { SupabaseClient } from '@supabase/supabase-js'
import type { PermissionAction } from './constants'
import type { EffectivePermission, PermissionLevel } from './types'

// Central permission check: hasPermission(userId, moduleId, action).
// Delegates to the resolve_permission() SQL function so every caller
// (API routes, future RLS policies, server code) shares one precedence
// implementation: Employee Override > Department > Role > System Default.
export async function hasPermission(
  supabase: SupabaseClient,
  userId: string,
  moduleKey: string,
  action: PermissionAction,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('resolve_permission', {
    p_user_id: userId,
    p_module_key: moduleKey,
    p_action_key: action,
  })
  if (error) throw error
  return data === true
}

// Effective permission resolver: merges all 4 levels for every action the
// module supports, reporting which level ("source") decided each one.
export async function getEffectivePermissions(
  supabase: SupabaseClient,
  userId: string,
  moduleKey: string,
): Promise<EffectivePermission[]> {
  const { data, error } = await supabase.rpc('resolve_effective_permissions', {
    p_user_id: userId,
    p_module_key: moduleKey,
  })
  if (error) throw error

  return (data ?? []).map((row: { action_key: string; allowed: boolean; source: string }) => ({
    actionKey: row.action_key,
    allowed: row.allowed,
    source: row.source as PermissionLevel,
  }))
}

// Bulk effective-permission resolver: same precedence merge as
// getEffectivePermissions, but across every active module in one round
// trip. Used by the Permission Management UI, which needs one employee's
// full permission tree at once — looping getEffectivePermissions per
// module would be N+1 RPC calls.
export async function getEffectivePermissionsForUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<Map<string, EffectivePermission[]>> {
  const { data, error } = await supabase.rpc('resolve_effective_permissions_for_user', {
    p_user_id: userId,
  })
  if (error) throw error

  const byModule = new Map<string, EffectivePermission[]>()
  for (const row of (data ?? []) as { module_key: string; action_key: string; allowed: boolean; source: string }[]) {
    const list = byModule.get(row.module_key) ?? []
    list.push({ actionKey: row.action_key, allowed: row.allowed, source: row.source as PermissionLevel })
    byModule.set(row.module_key, list)
  }
  return byModule
}
