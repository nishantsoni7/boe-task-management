'use client'

import { useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import type { ModuleVisibilityType } from '@/lib/moduleAccess'
import { useControlCenterSession } from '@/components/layout/ControlCenterContext'
import type { ResolvedAction } from '@/lib/permissions/accessControlChanges'

// ── The Control Center's shared reference data ───────────────────────────────
//
// Three lists that more than one Control Center section reads, each behind the
// admin-only route it always came from:
//
//   admin members   /api/admin-members              Overview counts, People,
//                                                   Departments popup, Access Control directory
//   departments     /api/control-center/departments Departments, People, Access Control labels
//   app modules     /api/control-center/modules     Overview counts, Module Visibility
//
// Until now every section fetched its own copy into useState on mount, so
// Overview → Access Control → Overview paid for the directory three times and
// the reads were thrown away with the page. These are React Query entries
// instead: the first section to ask issues the request, every section within
// the stale window reads the cache, and a route change alone never refetches.
//
// WHAT DID NOT CHANGE. The routes, their bearer-token auth and their response
// shapes are exactly as before — this is a transport change. The keys carry the
// signed-in user's id, as usePermissionContext's do, so an entry can never be
// addressed by a different user even before the auth listener in Providers.tsx
// has cleared the cache. Mutations update the cache through
// useControlCenterCache below, with the same updater functions the pages used
// against local state.

export const CONTROL_CENTER_STALE_MS = 30_000

export const adminMembersKey = (userId: string) => ['control-center', 'admin-members', userId] as const
export const departmentsKey  = (userId: string) => ['control-center', 'departments',   userId] as const
export const appModulesKey   = (userId: string) => ['control-center', 'app-modules',   userId] as const

export type ControlCenterDepartment = {
  id: string
  department_key: string
  department_name: string
  is_active: boolean
  sort_order: number
}

export type ControlCenterAppModule = {
  id: string
  module_key: string
  module_name: string
  description: string | null
  route_path: string
  visibility_type: ModuleVisibilityType
  allowed_department: string[] | null
  allowed_user_ids: string[] | null
  sort_order: number
}

/** Stable empty defaults, so a memo keyed on the list does not churn while a query is pending. */
export const NO_MEMBERS: UserProfile[] = []
export const NO_DEPARTMENTS: ControlCenterDepartment[] = []
export const NO_APP_MODULES: ControlCenterAppModule[] = []

/**
 * One admin-gated GET. getSession() is a local read of the stored session, not
 * a round trip; the bearer token it yields is what every one of these routes
 * verifies server-side before reading anything.
 */
async function adminGet<T>(path: string, field: string): Promise<T[]> {
  const { data: { session } } = await createClient().auth.getSession()
  if (!session) throw new Error('Not signed in')
  const res = await fetch(path, { headers: { Authorization: `Bearer ${session.access_token}` } })
  if (!res.ok) throw new Error(`${path} failed (HTTP ${res.status})`)
  const body = await res.json()
  return Array.isArray(body?.[field]) ? (body[field] as T[]) : []
}

export function useAdminMembers() {
  const { userId } = useControlCenterSession()
  return useQuery<UserProfile[]>({
    queryKey: adminMembersKey(userId),
    queryFn: () => adminGet<UserProfile>('/api/admin-members', 'members'),
    staleTime: CONTROL_CENTER_STALE_MS,
  })
}

export function useDepartments() {
  const { userId } = useControlCenterSession()
  return useQuery<ControlCenterDepartment[]>({
    queryKey: departmentsKey(userId),
    queryFn: () => adminGet<ControlCenterDepartment>('/api/control-center/departments', 'departments'),
    staleTime: CONTROL_CENTER_STALE_MS,
  })
}

export function useAppModules() {
  const { userId } = useControlCenterSession()
  return useQuery<ControlCenterAppModule[]>({
    queryKey: appModulesKey(userId),
    queryFn: () => adminGet<ControlCenterAppModule>('/api/control-center/modules', 'modules'),
    staleTime: CONTROL_CENTER_STALE_MS,
  })
}

type Updater<T> = (prev: T[]) => T[]

/**
 * The write side. Each setter takes the same `prev => next` updater the pages
 * used to pass to useState, and applies it to the cached list — so a saved
 * department, a reassigned person or an edited module row is reflected in every
 * section at once, without a refetch. An updater is skipped when there is
 * nothing cached yet: there is nothing to patch, and the next read will fetch.
 */
export function useControlCenterCache() {
  const queryClient = useQueryClient()
  const { userId } = useControlCenterSession()

  return useMemo(() => ({
    setMembers: (update: Updater<UserProfile>) =>
      queryClient.setQueryData<UserProfile[]>(adminMembersKey(userId), prev => prev && update(prev)),
    setDepts: (update: Updater<ControlCenterDepartment>) =>
      queryClient.setQueryData<ControlCenterDepartment[]>(departmentsKey(userId), prev => prev && update(prev)),
    setModules: (update: Updater<ControlCenterAppModule>) =>
      queryClient.setQueryData<ControlCenterAppModule[]>(appModulesKey(userId), prev => prev && update(prev)),
  }), [queryClient, userId])
}

// ── Access Control reads ─────────────────────────────────────────────────────
//
// The registered modules (for the By Module list) and the per-module access
// matrix. Both are admin-gated GETs with the same bearer-token auth as above;
// the matrix is refetched after a save so a level shown is always the
// resolver's answer, never a guess.


export type PermissionModuleRef = {
  moduleKey: string
  displayName: string
  description: string | null
  actions: { actionKey: string; displayName: string }[]
}

export type ModuleMatrixEmployee = {
  id: string
  name: string
  email: string
  role: string
  team: string | null
  is_active: boolean
  actions: ResolvedAction[]
}

export type ModuleMatrix = {
  module: { moduleKey: string; displayName: string; actions: { actionKey: string; displayName: string }[] }
  employees: ModuleMatrixEmployee[]
}

export const permissionModulesKey = (userId: string) => ['control-center', 'permission-modules', userId] as const
export const moduleMatrixKey = (userId: string, moduleKey: string) =>
  ['control-center', 'module-matrix', userId, moduleKey] as const

export const NO_PERMISSION_MODULES: PermissionModuleRef[] = []

async function adminGetJson<T>(path: string): Promise<T> {
  const { data: { session } } = await createClient().auth.getSession()
  if (!session) throw new Error('Not signed in')
  const res = await fetch(path, { headers: { Authorization: `Bearer ${session.access_token}` } })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error ?? `${path} failed (HTTP ${res.status})`)
  return body as T
}

export function usePermissionModules() {
  const { userId } = useControlCenterSession()
  return useQuery<PermissionModuleRef[]>({
    queryKey: permissionModulesKey(userId),
    queryFn: () => adminGet<PermissionModuleRef>('/api/control-center/permissions/modules', 'modules'),
    staleTime: CONTROL_CENTER_STALE_MS,
  })
}

export function useModuleAccessMatrix(moduleKey: string | null) {
  const { userId } = useControlCenterSession()
  return useQuery<ModuleMatrix>({
    queryKey: moduleMatrixKey(userId, moduleKey ?? ''),
    enabled: !!moduleKey,
    queryFn: () => adminGetJson<ModuleMatrix>(`/api/control-center/permissions/modules/${moduleKey}/employees`),
    staleTime: CONTROL_CENTER_STALE_MS,
  })
}
