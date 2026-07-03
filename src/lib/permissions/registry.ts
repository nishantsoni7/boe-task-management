import type { SupabaseClient } from '@supabase/supabase-js'
import type { PermissionModuleDefinition } from './types'

// In-process module registry. A module registers itself once — e.g. by
// calling registerModule() at the top of its own file — and the permission
// engine never needs to change to support it. This is what makes the
// engine modular: new modules plug into the existing hierarchy/resolver
// without touching resolver.ts or the migration.
const registry = new Map<string, PermissionModuleDefinition>()

export function registerModule(definition: PermissionModuleDefinition): void {
  registry.set(definition.moduleKey, definition)
}

export function getRegisteredModule(moduleKey: string): PermissionModuleDefinition | undefined {
  return registry.get(moduleKey)
}

export function getRegisteredModules(): PermissionModuleDefinition[] {
  return Array.from(registry.values())
}

// Upserts every module currently in the in-process registry into
// permission_modules / permission_actions / module_permission_actions.
// Safe to call repeatedly (idempotent upsert, not insert). Intended as a
// one-time setup step when a module is introduced, not a per-request call.
export async function syncPermissionRegistry(supabase: SupabaseClient): Promise<void> {
  for (const mod of registry.values()) {
    const { data: moduleRow, error: moduleError } = await supabase
      .from('permission_modules')
      .upsert(
        { module_key: mod.moduleKey, display_name: mod.displayName, description: mod.description ?? null },
        { onConflict: 'module_key' },
      )
      .select('id')
      .single()
    if (moduleError || !moduleRow) throw moduleError ?? new Error(`Failed to upsert module ${mod.moduleKey}`)

    for (const action of mod.actions) {
      const { data: actionRow, error: actionError } = await supabase
        .from('permission_actions')
        .upsert(
          { action_key: action.actionKey, display_name: action.displayName },
          { onConflict: 'action_key' },
        )
        .select('id')
        .single()
      if (actionError || !actionRow) throw actionError ?? new Error(`Failed to upsert action ${action.actionKey}`)

      const { error: linkError } = await supabase
        .from('module_permission_actions')
        .upsert(
          {
            module_id: moduleRow.id,
            action_id: actionRow.id,
            default_allowed: action.defaultAllowed ?? false,
          },
          { onConflict: 'module_id,action_id' },
        )
      if (linkError) throw linkError
    }
  }
}
