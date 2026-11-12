import type { SupabaseClient } from '@supabase/supabase-js'

/** The Control Center visibility row for Showroom QR (who may manage it). */
export type ShowroomModuleRow = { visibility_type: string; allowed_department: string[] | null; allowed_user_ids: string[] | null }

/**
 * One read of the showroom_qr row per page load, shared by the Showroom QR frame
 * (ShowroomAdminLayout) and the page inside it, which each used to read it (2026-11-12).
 * A failed or missing row is null, as before: resolveModuleAccess then decides on its fallback.
 */
export function showroomModuleQuery(supabase: SupabaseClient) {
  return {
    queryKey: ['app-module', 'showroom_qr'] as const,
    queryFn: async (): Promise<ShowroomModuleRow | null> => {
      const { data } = await supabase
        .from('app_modules')
        .select('visibility_type, allowed_department, allowed_user_ids')
        .eq('module_key', 'showroom_qr')
        .single()
      return (data as ShowroomModuleRow | null) ?? null
    },
    staleTime: 30_000,
  }
}
