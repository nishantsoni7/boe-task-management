// Shared visibility check for app_modules-gated routes.
// Mirrors the Control Center visibility model: live / admin_only / department_only / hidden.

export type ModuleVisibilityType = 'live' | 'admin_only' | 'department_only' | 'hidden'

type AccessProfile = { role: string; team?: string | null } | null

export function canAccessModule(
  visibilityType: ModuleVisibilityType | undefined,
  allowedDepartment: string | null | undefined,
  profile: AccessProfile,
  fallback: boolean,
): boolean {
  if (!visibilityType || !profile) return fallback
  const isAdmin = profile.role === 'admin'
  switch (visibilityType) {
    case 'hidden':          return false
    case 'admin_only':      return isAdmin
    case 'department_only': return isAdmin || (profile.team?.toLowerCase() === allowedDepartment?.toLowerCase())
    default:                return true // 'live'
  }
}
