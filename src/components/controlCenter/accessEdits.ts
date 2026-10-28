'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { AccessMatrix, MatrixAction } from '@/hooks/queries/useControlCenterData'
import {
  changesBetween,
  choicesForDesired,
  initialChoices,
  type OverrideChange,
} from '@/lib/permissions/accessControlChanges'
import { isAdminEditableAction } from '@/lib/permissions/orderApproval'
import {
  authoritiesFor,
  detectOfferedLevel,
  levelLabel,
  moduleWords,
} from '@/lib/permissions/accessCatalog'

// ── Pending edits over the access matrix ─────────────────────────────────────
//
// Modules and Authorities both edit many people at once. This is their one
// pending-state model: a desired allow/deny map per person × module, kept
// apart from the matrix until Save, when each person's diff goes through the
// same per-employee PUT People uses — with the same shared write rule
// (choicesForDesired, changesBetween), so the three screens can never store
// different rows for the same intention.

export type PendingKey = `${string}:${string}`
export const pendingKey = (employeeId: string, moduleKey: string): PendingKey => `${employeeId}:${moduleKey}`

export function effectiveFromActions(actions: readonly MatrixAction[]): Record<string, boolean> {
  const map: Record<string, boolean> = {}
  for (const a of actions) map[a.actionKey] = a.allowed
  return map
}

function sameMap(a: Readonly<Record<string, boolean>>, b: Readonly<Record<string, boolean>>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if ((a[k] === true) !== (b[k] === true)) return false
  return true
}

export type AccessChange = { employeeId: string; employeeName: string; moduleKey: string; text: string }

/** One sentence per changed person × module, for the save bar. */
export function describeChange(
  moduleKey: string,
  moduleName: string,
  actionKeys: readonly string[],
  before: Readonly<Record<string, boolean>>,
  after: Readonly<Record<string, boolean>>,
): string {
  const parts: string[] = []
  const lb = detectOfferedLevel(moduleKey, actionKeys, before)
  const la = detectOfferedLevel(moduleKey, actionKeys, after)
  const name = (l: typeof lb) => l === 'custom' ? 'Custom mix' : levelLabel(moduleKey, actionKeys, l)
  if (lb !== la) parts.push(`${name(lb)} → ${name(la)}`)
  for (const a of authoritiesFor(moduleKey, actionKeys)) {
    const was = before[a.actionKey] === true, now = after[a.actionKey] === true
    if (!was && now) parts.push(`+ ${a.label}`)
    if (was && !now) parts.push(`− ${a.label}`)
  }
  return `${moduleName}: ${parts.join(' · ') || 'no visible change'}`
}

export function useAccessMatrixEdits(matrix: AccessMatrix | null | undefined) {
  const [pending, setPending] = useState<Map<PendingKey, Record<string, boolean>>>(new Map())
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const actionsOf = (employeeId: string, moduleKey: string): MatrixAction[] =>
    matrix?.employees.find(e => e.id === employeeId)?.modules[moduleKey] ?? []

  const baseOf = (employeeId: string, moduleKey: string) => effectiveFromActions(actionsOf(employeeId, moduleKey))

  /** The effective map with any pending edit folded in. */
  const effectiveOf = (employeeId: string, moduleKey: string): Record<string, boolean> =>
    pending.get(pendingKey(employeeId, moduleKey)) ?? baseOf(employeeId, moduleKey)

  const isDirty = (employeeId: string, moduleKey: string) => pending.has(pendingKey(employeeId, moduleKey))

  function setDesired(employeeId: string, moduleKey: string, desired: Record<string, boolean>) {
    setSaveError('')
    setPending(prev => {
      const next = new Map(prev)
      const key = pendingKey(employeeId, moduleKey)
      if (sameMap(desired, baseOf(employeeId, moduleKey))) next.delete(key)
      else next.set(key, desired)
      return next
    })
  }

  function discard() { setPending(new Map()); setSaveError('') }

  const changes = (): AccessChange[] => {
    if (!matrix) return []
    const out: AccessChange[] = []
    for (const [key, desired] of pending) {
      const [employeeId, moduleKey] = key.split(':') as [string, string]
      const emp = matrix.employees.find(e => e.id === employeeId)
      const mod = matrix.modules.find(m => m.moduleKey === moduleKey)
      if (!emp || !mod) continue
      const actionKeys = mod.actions.map(a => a.actionKey)
      out.push({
        employeeId, moduleKey, employeeName: emp.name,
        text: `${emp.name} · ${describeChange(moduleKey, mod.displayName, actionKeys, baseOf(employeeId, moduleKey), desired)}`,
      })
    }
    return out
  }

  /**
   * Saves every pending edit: one PUT per employee with every module's diff.
   * A system Administrator's authority is users.role, so for them only the
   * per-person actions (ADMIN_EDITABLE_ACTIONS) are sent — nothing else an
   * override could carry would decide anything.
   */
  async function save(onSaved: () => Promise<unknown> | void) {
    if (!matrix || pending.size === 0) return
    setSaving(true)
    setSaveError('')
    const { data: { session } } = await createClient().auth.getSession()
    if (!session) { setSaveError('Your session has expired. Sign in again.'); setSaving(false); return }
    const byEmployee = new Map<string, OverrideChange[]>()
    for (const [key, desired] of pending) {
      const [employeeId, moduleKey] = key.split(':') as [string, string]
      const emp = matrix.employees.find(e => e.id === employeeId)
      if (!emp) continue
      const actions = actionsOf(employeeId, moduleKey)
      let diff = changesBetween(moduleKey, actions, initialChoices(actions), choicesForDesired(actions, desired))
      if (emp.role === 'admin') diff = diff.filter(c => isAdminEditableAction(moduleKey, c.actionKey))
      if (diff.length === 0) continue
      byEmployee.set(employeeId, [...(byEmployee.get(employeeId) ?? []), ...diff])
    }
    const failures: string[] = []
    const savedEmployees = new Set<string>()
    await Promise.all([...byEmployee.entries()].map(async ([employeeId, list]) => {
      const emp = matrix.employees.find(e => e.id === employeeId)
      try {
        const res = await fetch(`/api/control-center/permissions/employees/${employeeId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ changes: list }),
        })
        const json = await res.json().catch(() => null)
        if (!res.ok) { failures.push(`${emp?.name ?? 'Employee'}: ${json?.error ?? 'Save failed'}`); return }
        savedEmployees.add(employeeId)
      } catch {
        failures.push(`${emp?.name ?? 'Employee'}: Save failed. Check your connection and try again.`)
      }
    }))
    // Employees that saved (or had nothing to send) leave the pending set; a
    // failed one keeps its pending state so nothing the administrator chose is lost.
    setPending(prev => {
      const next = new Map(prev)
      for (const key of prev.keys()) {
        const employeeId = key.split(':')[0]
        if (savedEmployees.has(employeeId) || !byEmployee.has(employeeId)) next.delete(key)
      }
      return next
    })
    if (failures.length > 0) setSaveError(failures.join(' · '))
    try { await onSaved() } finally { setSaving(false) }
  }

  return { pending, effectiveOf, baseOf, isDirty, setDesired, discard, changes, save, saving, saveError }
}

/** The catalogue's words for a module, or a quiet fallback for one it does not know. */
export function blurbFor(moduleKey: string, fallback: string | null | undefined): string {
  return moduleWords(moduleKey)?.blurb ?? fallback ?? ''
}
