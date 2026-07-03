'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { ControlCenterLayout } from '@/components/layout/ControlCenterLayout'
import { LoadingScreen, EmptyState } from '@/components/ui/atoms'
import { useViewAs } from '@/hooks/useViewAs'

// ── Local types ───────────────────────────────────────────────────────────────

type Department = {
  id: string
  department_key: string
  department_name: string
  is_active: boolean
}

type PermissionSource = 'system_default' | 'role' | 'department' | 'employee_override'

type ActionState = {
  actionKey: string
  displayName: string
  allowed: boolean
  source: PermissionSource
  sourceLabel: string
}

type ModuleState = {
  moduleKey: string
  displayName: string
  actions: ActionState[]
}

type EmployeePermissionTree = {
  employee: { id: string; name: string; role: string; department: string | null }
  modules: ModuleState[]
}

// override choice per "moduleKey:actionKey" — 'inherit' means no employee override
type OverrideChoice = 'inherit' | 'allow' | 'deny'

// ── Style helpers (matches src/app/admin/control-center/page.tsx) ──────────────

const SECTION_LABEL: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.07em',
  color: '#8C94A6',
  textTransform: 'uppercase',
  marginBottom: 12,
}

const INPUT: React.CSSProperties = {
  width: '100%',
  padding: '9px 11px',
  fontSize: 13,
  border: '1.5px solid #D1D5DB',
  borderRadius: 8,
  background: '#fff',
  color: '#111318',
  outline: 'none',
  boxSizing: 'border-box',
}

const CARD: React.CSSProperties = {
  border: '1px solid #E8EBF0',
  borderRadius: 10,
  overflow: 'hidden',
  marginBottom: 10,
}

const MODULE_HEADER: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '13px 16px',
  background: '#FAFBFC',
  cursor: 'pointer',
  userSelect: 'none',
}

const ACTION_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '11px 16px',
  borderTop: '1px solid #F0F2F5',
  gap: 12,
  flexWrap: 'wrap',
}

function overrideKey(moduleKey: string, actionKey: string) {
  return `${moduleKey}:${actionKey}`
}

function choiceFromAction(action: ActionState): OverrideChoice {
  if (action.source !== 'employee_override') return 'inherit'
  return action.allowed ? 'allow' : 'deny'
}

// ── Badges ───────────────────────────────────────────────────────────────────

function EffectiveBadge({ choice, action }: { choice: OverrideChoice; action: ActionState }) {
  if (choice === 'inherit') {
    if (action.source !== 'employee_override') {
      return (
        <span style={{ fontSize: 12, color: action.allowed ? '#166534' : '#B0364A' }}>
          {action.allowed ? 'Allowed' : 'Denied'}
          <span style={{ color: '#8C94A6' }}> · Inherited from {action.sourceLabel}</span>
        </span>
      )
    }
    return <span style={{ fontSize: 12, color: '#8C94A6' }}>Will inherit (recalculated on save)</span>
  }
  const allowed = choice === 'allow'
  return (
    <span style={{ fontSize: 12, color: allowed ? '#166534' : '#B0364A' }}>
      {allowed ? 'Allowed' : 'Denied'}
      <span style={{ color: '#8C94A6' }}> · Employee Override</span>
    </span>
  )
}

function OverrideControl({
  value, onChange,
}: {
  value: OverrideChoice
  onChange: (v: OverrideChoice) => void
}) {
  const OPTIONS: { key: OverrideChoice; label: string }[] = [
    { key: 'inherit', label: 'Inherit' },
    { key: 'allow', label: 'Allow' },
    { key: 'deny', label: 'Deny' },
  ]
  return (
    <div style={{ display: 'flex', border: '1.5px solid #D1D5DB', borderRadius: 8, overflow: 'hidden' }}>
      {OPTIONS.map((opt, i) => {
        const active = value === opt.key
        const activeColor = opt.key === 'allow' ? '#166534' : opt.key === 'deny' ? '#B0364A' : '#1A2035'
        const activeBg = opt.key === 'allow' ? '#F0FDF4' : opt.key === 'deny' ? '#FDF1F3' : '#EEF0F4'
        return (
          <button
            key={opt.key}
            onClick={() => onChange(opt.key)}
            style={{
              padding: '5px 12px',
              fontSize: 12,
              fontWeight: 600,
              border: 'none',
              borderLeft: i > 0 ? '1.5px solid #D1D5DB' : 'none',
              background: active ? activeBg : '#fff',
              color: active ? activeColor : '#6B7384',
              cursor: 'pointer',
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PermissionsPage() {
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { viewAsUserId, exitViewMode } = useViewAs()

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [token,   setToken]   = useState('')
  const [loading, setLoading] = useState(true)

  const [members, setMembers] = useState<UserProfile[]>([])
  const [depts,   setDepts]   = useState<Department[]>([])

  const [search,             setSearch]             = useState('')
  const [selectorOpen,       setSelectorOpen]       = useState(false)
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null)

  const [tree,        setTree]        = useState<EmployeePermissionTree | null>(null)
  const [treeLoading,  setTreeLoading] = useState(false)
  const [treeError,    setTreeError]   = useState('')

  const [overrides,      setOverrides]      = useState<Map<string, OverrideChoice>>(new Map())
  const [initialOverrides, setInitialOverrides] = useState<Map<string, OverrideChoice>>(new Map())
  const [expanded,       setExpanded]       = useState<Set<string>>(new Set())

  const [saving,   setSaving]   = useState(false)
  const [saveError, setSaveError] = useState('')

  // ── Init ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: p } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, is_active, created_at')
        .eq('id', session.user.id)
        .single()

      if (p?.role !== 'admin') { router.push('/dashboard'); return }
      if (viewAsUserId) { exitViewMode(); router.push('/dashboard'); return }

      setProfile(p as UserProfile)
      setToken(session.access_token)

      const hdrs = { Authorization: `Bearer ${session.access_token}` }

      const [membersRes, deptsRes] = await Promise.all([
        fetch('/api/admin-members',              { headers: hdrs }).then(r => r.json()),
        fetch('/api/control-center/departments', { headers: hdrs }).then(r => r.json()),
      ])

      if (Array.isArray(membersRes?.members))   setMembers(membersRes.members)
      if (Array.isArray(deptsRes?.departments)) setDepts(deptsRes.departments)

      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Employee search results ─────────────────────────────────────────────
  const deptLabel = (key: string | null | undefined) => {
    if (!key) return '—'
    return depts.find(d => d.department_key === key)?.department_name ?? key
  }

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    const pool = members.filter(m => !m.is_deleted)
    if (!q) return pool.slice(0, 20)
    return pool.filter(m =>
      m.full_name?.toLowerCase().includes(q) ||
      m.email?.toLowerCase().includes(q) ||
      deptLabel(m.team).toLowerCase().includes(q) ||
      m.role?.toLowerCase().includes(q)
    ).slice(0, 20)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, members, depts])

  // ── Load an employee's permission tree ──────────────────────────────────
  async function selectEmployee(id: string) {
    setSelectedEmployeeId(id)
    setSelectorOpen(false)
    setSearch('')
    setSaveError('')
    await loadTree(id)
  }

  async function loadTree(id: string) {
    setTreeLoading(true)
    setTreeError('')
    try {
      const res = await fetch(`/api/control-center/permissions/employees/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const json = await res.json()
      if (!res.ok) { setTreeError(json.error ?? 'Failed to load permissions'); setTree(null); return }

      const data = json as EmployeePermissionTree
      setTree(data)

      const initial = new Map<string, OverrideChoice>()
      for (const mod of data.modules) {
        for (const action of mod.actions) {
          initial.set(overrideKey(mod.moduleKey, action.actionKey), choiceFromAction(action))
        }
      }
      setInitialOverrides(initial)
      setOverrides(new Map(initial))
      setExpanded(new Set())
    } finally {
      setTreeLoading(false)
    }
  }

  function changeOverride(moduleKey: string, actionKey: string, choice: OverrideChoice) {
    setOverrides(prev => {
      const next = new Map(prev)
      next.set(overrideKey(moduleKey, actionKey), choice)
      return next
    })
  }

  function toggleModule(moduleKey: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(moduleKey)) next.delete(moduleKey)
      else next.add(moduleKey)
      return next
    })
  }

  const overrideCount = (mod: ModuleState) =>
    mod.actions.filter(a => overrides.get(overrideKey(mod.moduleKey, a.actionKey)) !== 'inherit').length

  const dirty = useMemo(() => {
    for (const [key, choice] of overrides) {
      if (initialOverrides.get(key) !== choice) return true
    }
    return false
  }, [overrides, initialOverrides])

  // ── Save ─────────────────────────────────────────────────────────────────
  async function save() {
    if (!selectedEmployeeId || !tree) return

    const changes: { moduleKey: string; actionKey: string; allowed: boolean | null }[] = []
    for (const mod of tree.modules) {
      for (const action of mod.actions) {
        const key = overrideKey(mod.moduleKey, action.actionKey)
        const choice = overrides.get(key)
        if (!choice || choice === initialOverrides.get(key)) continue
        changes.push({
          moduleKey: mod.moduleKey,
          actionKey: action.actionKey,
          allowed: choice === 'inherit' ? null : choice === 'allow',
        })
      }
    }
    if (changes.length === 0) return

    setSaving(true)
    setSaveError('')
    try {
      const res = await fetch(`/api/control-center/permissions/employees/${selectedEmployeeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ changes }),
      })
      const json = await res.json()
      if (!res.ok) { setSaveError(json.error ?? 'Save failed'); return }

      await loadTree(selectedEmployeeId)
    } finally {
      setSaving(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) return <LoadingScreen />

  return (
    <ControlCenterLayout
      profile={profile}
      title="Permissions"
      subtitle="Manage employee access, module by module"
      onSignOut={async () => { await supabase.auth.signOut(); router.replace('/login') }}
    >
      <div style={{ maxWidth: 720 }}>

        {/* ── Employee selector ────────────────────────────────────────────── */}
        <div style={{ marginBottom: 28, position: 'relative' }}>
          <div style={SECTION_LABEL}>Employee</div>
          {tree && !selectorOpen ? (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 14px', border: '1.5px solid #E8EBF0', borderRadius: 10, background: '#fff',
            }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#111318' }}>{tree.employee.name}</div>
                <div style={{ fontSize: 12, color: '#6B7384', marginTop: 2 }}>
                  {tree.employee.department ?? '—'} · <span style={{ textTransform: 'capitalize' }}>{tree.employee.role}</span>
                </div>
              </div>
              <button
                onClick={() => setSelectorOpen(true)}
                style={{ fontSize: 12, fontWeight: 600, color: '#5585E8', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                style={INPUT}
                placeholder="Search by name, department, or role…"
                value={search}
                onFocus={() => setSelectorOpen(true)}
                onChange={e => { setSearch(e.target.value); setSelectorOpen(true) }}
              />
              {selectorOpen && (
                <div style={{
                  position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
                  marginTop: 4, background: '#fff', border: '1.5px solid #E8EBF0', borderRadius: 10,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.10)', maxHeight: 320, overflowY: 'auto',
                }}>
                  {searchResults.length === 0 && (
                    <div style={{ padding: '14px', fontSize: 13, color: '#8C94A6' }}>No matches.</div>
                  )}
                  {searchResults.map(m => (
                    <div
                      key={m.id}
                      onClick={() => selectEmployee(m.id)}
                      style={{
                        padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid #F0F2F5',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#FAFBFC' }}
                      onMouseLeave={e => { e.currentTarget.style.background = '#fff' }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>{m.full_name}</span>
                      <span style={{ fontSize: 12, color: '#8C94A6' }}>
                        {deptLabel(m.team)} · <span style={{ textTransform: 'capitalize' }}>{m.role}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Empty state ──────────────────────────────────────────────────── */}
        {!selectedEmployeeId && (
          <EmptyState message="Select an employee to manage their permissions." />
        )}

        {/* ── Permission tree ──────────────────────────────────────────────── */}
        {selectedEmployeeId && treeLoading && <LoadingScreen message="Loading permissions…" />}

        {selectedEmployeeId && !treeLoading && treeError && (
          <div style={{ fontSize: 13, color: '#B0364A' }}>{treeError}</div>
        )}

        {selectedEmployeeId && !treeLoading && tree && (
          <>
            <div style={SECTION_LABEL}>Modules</div>
            {tree.modules.map(mod => {
              const isOpen = expanded.has(mod.moduleKey)
              const count = overrideCount(mod)
              return (
                <div key={mod.moduleKey} style={CARD}>
                  <div style={MODULE_HEADER} onClick={() => toggleModule(mod.moduleKey)}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#111318' }}>{mod.displayName}</span>
                      {count > 0 && (
                        <span style={{
                          fontSize: 10, fontWeight: 700, color: '#1E40AF', background: '#EFF6FF',
                          borderRadius: 5, padding: '2px 7px',
                        }}>
                          {count} override{count > 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    <span style={{ fontSize: 12, color: '#8C94A6' }}>{isOpen ? '▲' : '▼'}</span>
                  </div>

                  {isOpen && mod.actions.map(action => {
                    const key = overrideKey(mod.moduleKey, action.actionKey)
                    const choice = overrides.get(key) ?? 'inherit'
                    return (
                      <div key={action.actionKey} style={ACTION_ROW}>
                        <div style={{ minWidth: 140 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>{action.displayName}</div>
                          <EffectiveBadge choice={choice} action={action} />
                        </div>
                        <OverrideControl value={choice} onChange={v => changeOverride(mod.moduleKey, action.actionKey, v)} />
                      </div>
                    )
                  })}
                </div>
              )
            })}

            {/* ── Save bar ──────────────────────────────────────────────────── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 20 }}>
              <button
                onClick={save}
                disabled={!dirty || saving}
                style={{
                  padding: '9px 20px', fontSize: 13, fontWeight: 600, color: '#fff',
                  background: dirty ? '#1A2035' : '#C7CBD4',
                  border: 'none', borderRadius: 8, cursor: dirty ? 'pointer' : 'default',
                }}
              >
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
              {dirty && !saving && (
                <span style={{ fontSize: 12, color: '#8C94A6' }}>Unsaved changes</span>
              )}
              {saveError && <span style={{ fontSize: 12, color: '#B0364A' }}>{saveError}</span>}
            </div>
          </>
        )}
      </div>
    </ControlCenterLayout>
  )
}
