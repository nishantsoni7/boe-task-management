'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { ControlCenterLayout } from '@/components/layout/ControlCenterLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useViewAs } from '@/hooks/useViewAs'

// ── Local types ───────────────────────────────────────────────────────────────

type VisibilityType = 'live' | 'admin_only' | 'department_only' | 'hidden'

type AppModule = {
  id: string
  module_key: string
  module_name: string
  description: string | null
  route_path: string
  visibility_type: VisibilityType
  allowed_department: string | null
  sort_order: number
}

type Department = {
  id: string
  department_key: string
  department_name: string
  is_active: boolean
  sort_order: number
}

// ── Style helpers ─────────────────────────────────────────────────────────────

const SECTION: React.CSSProperties = {
  marginBottom: 40,
}

const SECTION_LABEL: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.07em',
  color: '#8C94A6',
  textTransform: 'uppercase',
  marginBottom: 12,
}

const TABLE: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 13,
  color: '#111318',
}

const TH: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 12px',
  fontWeight: 600,
  fontSize: 11,
  color: '#8C94A6',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  borderBottom: '1.5px solid #E8EBF0',
}

const TD: React.CSSProperties = {
  padding: '11px 12px',
  borderBottom: '1px solid #F0F2F5',
  verticalAlign: 'middle',
}

const EDIT_BTN: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#5585E8',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: '3px 0',
}

const MODAL_OVERLAY: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.35)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
}

const MODAL_BOX: React.CSSProperties = {
  background: '#fff',
  borderRadius: 14,
  padding: '28px 28px 24px',
  width: 400,
  maxWidth: 'calc(100vw - 32px)',
  boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
}

const MODAL_TITLE: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  color: '#111318',
  marginBottom: 20,
}

const LABEL: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: '#4B5563',
  marginBottom: 6,
}

const SELECT: React.CSSProperties = {
  width: '100%',
  padding: '9px 11px',
  fontSize: 13,
  border: '1.5px solid #D1D5DB',
  borderRadius: 8,
  background: '#fff',
  color: '#111318',
  marginBottom: 16,
  outline: 'none',
}

const INPUT: React.CSSProperties = {
  width: '100%',
  padding: '9px 11px',
  fontSize: 13,
  border: '1.5px solid #D1D5DB',
  borderRadius: 8,
  background: '#fff',
  color: '#111318',
  marginBottom: 16,
  outline: 'none',
  boxSizing: 'border-box',
}

const BTN_ROW: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  justifyContent: 'flex-end',
  marginTop: 4,
}

const BTN_CANCEL: React.CSSProperties = {
  padding: '8px 18px',
  fontSize: 13,
  fontWeight: 600,
  color: '#6B7384',
  background: '#F3F4F6',
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
}

const BTN_SAVE: React.CSSProperties = {
  padding: '8px 18px',
  fontSize: 13,
  fontWeight: 600,
  color: '#fff',
  background: '#1A2035',
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
}

const ERROR_MSG: React.CSSProperties = {
  fontSize: 12,
  color: '#D94F4F',
  marginBottom: 12,
}

// ── Visibility badge ──────────────────────────────────────────────────────────

const VIS_META: Record<VisibilityType, { label: string; color: string; bg: string }> = {
  live:            { label: 'Live',       color: '#166534', bg: '#F0FDF4' },
  admin_only:      { label: 'Admin Only', color: '#1E40AF', bg: '#EFF6FF' },
  department_only: { label: 'Dept Only',  color: '#92400E', bg: '#FFFBEB' },
  hidden:          { label: 'Hidden',     color: '#4B5563', bg: '#F3F4F6' },
}

function VisBadge({ type }: { type: VisibilityType }) {
  const m = VIS_META[type] ?? VIS_META.live
  return (
    <span style={{
      fontSize: 11, fontWeight: 700,
      color: m.color, background: m.bg,
      borderRadius: 5, padding: '2px 8px',
    }}>
      {m.label}
    </span>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ControlCenterPage() {
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { viewAsUserId, exitViewMode } = useViewAs()

  const [profile,  setProfile]  = useState<UserProfile | null>(null)
  const [token,    setToken]    = useState('')
  const [loading,  setLoading]  = useState(true)
  const [modules,  setModules]  = useState<AppModule[]>([])
  const [depts,    setDepts]    = useState<Department[]>([])
  const [members,  setMembers]  = useState<UserProfile[]>([])

  // ── Module edit modal ────────────────────────────────────────────────────
  const [editMod,       setEditMod]       = useState<AppModule | null>(null)
  const [modVisType,    setModVisType]    = useState<VisibilityType>('live')
  const [modAllowedDept,setModAllowedDept]= useState('')
  const [modSaving,     setModSaving]     = useState(false)
  const [modError,      setModError]      = useState('')

  // ── Department modal (edit or add) ───────────────────────────────────────
  const [editDept,   setEditDept]   = useState<Department | null>(null)
  const [addingDept, setAddingDept] = useState(false)
  const [deptName,   setDeptName]   = useState('')
  const [deptActive, setDeptActive] = useState(true)
  const [deptSaving, setDeptSaving] = useState(false)
  const [deptError,  setDeptError]  = useState('')

  // ── User department modal ─────────────────────────────────────────────────
  const [editUser,   setEditUser]   = useState<UserProfile | null>(null)
  const [userTeam,   setUserTeam]   = useState('')
  const [userSaving, setUserSaving] = useState(false)
  const [userError,  setUserError]  = useState('')

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

      const [modsRes, deptsRes, membersRes] = await Promise.all([
        fetch('/api/control-center/modules',     { headers: hdrs }).then(r => r.json()),
        fetch('/api/control-center/departments', { headers: hdrs }).then(r => r.json()),
        fetch('/api/admin-members',              { headers: hdrs }).then(r => r.json()),
      ])

      if (Array.isArray(modsRes?.modules))      setModules(modsRes.modules)
      if (Array.isArray(deptsRes?.departments)) setDepts(deptsRes.departments)
      if (Array.isArray(membersRes?.members))   setMembers(membersRes.members)

      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Helpers ───────────────────────────────────────────────────────────────

  const activeDepts = depts.filter(d => d.is_active)

  function openEditMod(mod: AppModule) {
    setEditMod(mod)
    setModVisType(mod.visibility_type)
    setModAllowedDept(mod.allowed_department ?? '')
    setModError('')
  }

  function openEditDept(dept: Department) {
    setEditDept(dept)
    setDeptName(dept.department_name)
    setDeptActive(dept.is_active)
    setDeptError('')
  }

  function openAddDept() {
    setAddingDept(true)
    setDeptName('')
    setDeptActive(true)
    setDeptError('')
  }

  function openEditUser(user: UserProfile) {
    setEditUser(user)
    setUserTeam(user.team ?? '')
    setUserError('')
  }

  // ── Save handlers ──────────────────────────────────────────────────────────

  async function saveModule() {
    if (!editMod) return
    if (modVisType === 'department_only' && !modAllowedDept) {
      setModError('Select a department.'); return
    }
    setModSaving(true); setModError('')
    try {
      const res = await fetch(`/api/control-center/modules/${editMod.module_key}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ visibility_type: modVisType, allowed_department: modAllowedDept || null }),
      })
      const json = await res.json()
      if (!res.ok) { setModError(json.error ?? 'Save failed'); return }

      setModules(prev => prev.map(m =>
        m.module_key === editMod.module_key
          ? { ...m, visibility_type: modVisType, allowed_department: modVisType === 'department_only' ? modAllowedDept : null }
          : m
      ))
      setEditMod(null)
    } finally {
      setModSaving(false)
    }
  }

  async function saveDept() {
    if (!deptName.trim()) { setDeptError('Name cannot be empty.'); return }
    setDeptSaving(true); setDeptError('')
    try {
      if (addingDept) {
        const res = await fetch('/api/control-center/departments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ department_name: deptName }),
        })
        const json = await res.json()
        if (!res.ok) { setDeptError(json.error ?? 'Save failed'); return }
        setDepts(prev => [...prev, json.department])
      } else if (editDept) {
        const res = await fetch(`/api/control-center/departments/${editDept.department_key}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ department_name: deptName, is_active: deptActive }),
        })
        const json = await res.json()
        if (!res.ok) { setDeptError(json.error ?? 'Save failed'); return }
        setDepts(prev => prev.map(d =>
          d.department_key === editDept.department_key
            ? { ...d, department_name: deptName, is_active: deptActive }
            : d
        ))
      }
      setEditDept(null); setAddingDept(false)
    } finally {
      setDeptSaving(false)
    }
  }

  async function saveUserDept() {
    if (!editUser) return
    setUserSaving(true); setUserError('')
    try {
      const res = await fetch('/api/update-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          userId:    editUser.id,
          full_name: editUser.full_name,
          team:      userTeam,
          role:      editUser.role,
          position:  editUser.position ?? null,
        }),
      })
      const json = await res.json()
      if (!res.ok) { setUserError(json.error ?? 'Save failed'); return }
      setMembers(prev => prev.map(m =>
        m.id === editUser.id ? { ...m, team: userTeam } : m
      ))
      setEditUser(null)
    } finally {
      setUserSaving(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) return <LoadingScreen />

  const deptLabel = (key: string | null | undefined) => {
    if (!key) return '—'
    return depts.find(d => d.department_key === key)?.department_name ?? key
  }

  const activeMembersIn = (key: string) =>
    members.filter(m => m.team === key && m.is_active !== false).length

  return (
    <ControlCenterLayout
      profile={profile}
      title="Control Center"
      subtitle="Module visibility · Departments · People"
      onSignOut={async () => { await supabase.auth.signOut(); router.replace('/login') }}
    >
      <div style={{ maxWidth: 900 }}>

        {/* ── Section 1: Modules ───────────────────────────────────────────── */}
        <div style={SECTION}>
          <div style={SECTION_LABEL}>Modules</div>
          <table style={TABLE}>
            <thead>
              <tr>
                <th style={TH}>Module</th>
                <th style={TH}>Visibility</th>
                <th style={TH}>Allowed Dept</th>
                <th style={TH}>Route</th>
                <th style={{ ...TH, width: 60 }}></th>
              </tr>
            </thead>
            <tbody>
              {modules.map(mod => (
                <tr key={mod.module_key}>
                  <td style={TD}>
                    <span style={{ fontWeight: 600 }}>{mod.module_name}</span>
                  </td>
                  <td style={TD}><VisBadge type={mod.visibility_type} /></td>
                  <td style={{ ...TD, color: mod.allowed_department ? '#111318' : '#B0B8C8' }}>
                    {mod.visibility_type === 'department_only'
                      ? deptLabel(mod.allowed_department)
                      : '—'}
                  </td>
                  <td style={{ ...TD, color: '#6B7384', fontFamily: 'monospace', fontSize: 12 }}>
                    {mod.route_path}
                  </td>
                  <td style={TD}>
                    <button style={EDIT_BTN} onClick={() => openEditMod(mod)}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── Section 2: Departments ───────────────────────────────────────── */}
        <div style={SECTION}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={SECTION_LABEL}>Departments</div>
            <button
              onClick={openAddDept}
              style={{
                fontSize: 12, fontWeight: 600,
                color: '#fff', background: '#1A2035',
                border: 'none', borderRadius: 7,
                padding: '5px 14px', cursor: 'pointer',
              }}
            >
              + Add
            </button>
          </div>
          <table style={TABLE}>
            <thead>
              <tr>
                <th style={TH}>Department</th>
                <th style={TH}>Key</th>
                <th style={TH}>Active Members</th>
                <th style={TH}>Status</th>
                <th style={{ ...TH, width: 60 }}></th>
              </tr>
            </thead>
            <tbody>
              {depts.map(dept => (
                <tr key={dept.department_key}>
                  <td style={{ ...TD, fontWeight: 600 }}>{dept.department_name}</td>
                  <td style={{ ...TD, color: '#6B7384', fontFamily: 'monospace', fontSize: 12 }}>
                    {dept.department_key}
                  </td>
                  <td style={{ ...TD, color: '#6B7384' }}>{activeMembersIn(dept.department_key)}</td>
                  <td style={TD}>
                    <span style={{
                      fontSize: 11, fontWeight: 700,
                      color: dept.is_active ? '#166534' : '#4B5563',
                      background: dept.is_active ? '#F0FDF4' : '#F3F4F6',
                      borderRadius: 5, padding: '2px 8px',
                    }}>
                      {dept.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td style={TD}>
                    <button style={EDIT_BTN} onClick={() => openEditDept(dept)}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── Section 3: People ────────────────────────────────────────────── */}
        <div style={SECTION}>
          <div style={SECTION_LABEL}>People</div>
          <table style={TABLE}>
            <thead>
              <tr>
                <th style={TH}>Name</th>
                <th style={TH}>Role</th>
                <th style={TH}>Department</th>
                <th style={TH}>Status</th>
                <th style={{ ...TH, width: 60 }}></th>
              </tr>
            </thead>
            <tbody>
              {members.filter(m => !m.is_deleted).map(member => (
                <tr key={member.id}>
                  <td style={{ ...TD, fontWeight: 600 }}>{member.full_name}</td>
                  <td style={{ ...TD, color: '#6B7384', textTransform: 'capitalize' }}>{member.role}</td>
                  <td style={{ ...TD, color: member.team ? '#111318' : '#B0B8C8' }}>
                    {deptLabel(member.team)}
                  </td>
                  <td style={TD}>
                    <span style={{
                      fontSize: 11, fontWeight: 700,
                      color: member.is_active ? '#166534' : '#4B5563',
                      background: member.is_active ? '#F0FDF4' : '#F3F4F6',
                      borderRadius: 5, padding: '2px 8px',
                    }}>
                      {member.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td style={TD}>
                    <button style={EDIT_BTN} onClick={() => openEditUser(member)}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Module edit modal ─────────────────────────────────────────────── */}
      {editMod && (
        <div style={MODAL_OVERLAY} onClick={() => setEditMod(null)}>
          <div style={MODAL_BOX} onClick={e => e.stopPropagation()}>
            <div style={MODAL_TITLE}>Edit — {editMod.module_name}</div>

            <label style={LABEL}>Visibility</label>
            <select
              style={SELECT}
              value={modVisType}
              onChange={e => setModVisType(e.target.value as VisibilityType)}
            >
              <option value="live">Live — visible to everyone</option>
              <option value="admin_only">Admin Only</option>
              <option value="department_only">Department Only</option>
              <option value="hidden">Hidden — not shown in launcher</option>
            </select>

            {modVisType === 'department_only' && (
              <>
                <label style={LABEL}>Allowed Department</label>
                <select
                  style={SELECT}
                  value={modAllowedDept}
                  onChange={e => setModAllowedDept(e.target.value)}
                >
                  <option value="">— Select department —</option>
                  {activeDepts.map(d => (
                    <option key={d.department_key} value={d.department_key}>
                      {d.department_name}
                    </option>
                  ))}
                </select>
              </>
            )}

            {modError && <div style={ERROR_MSG}>{modError}</div>}

            <div style={BTN_ROW}>
              <button style={BTN_CANCEL} onClick={() => setEditMod(null)}>Cancel</button>
              <button style={BTN_SAVE} onClick={saveModule} disabled={modSaving}>
                {modSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Department modal (add / edit) ─────────────────────────────────── */}
      {(editDept || addingDept) && (
        <div style={MODAL_OVERLAY} onClick={() => { setEditDept(null); setAddingDept(false) }}>
          <div style={MODAL_BOX} onClick={e => e.stopPropagation()}>
            <div style={MODAL_TITLE}>
              {addingDept ? 'Add Department' : `Edit — ${editDept!.department_name}`}
            </div>

            <label style={LABEL}>Department Name</label>
            <input
              style={INPUT}
              value={deptName}
              onChange={e => setDeptName(e.target.value)}
              placeholder="e.g. Business Development"
            />

            {!addingDept && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', marginBottom: 16 }}>
                <input
                  type="checkbox"
                  checked={deptActive}
                  onChange={e => setDeptActive(e.target.checked)}
                />
                Active
              </label>
            )}

            {deptError && <div style={ERROR_MSG}>{deptError}</div>}

            <div style={BTN_ROW}>
              <button style={BTN_CANCEL} onClick={() => { setEditDept(null); setAddingDept(false) }}>
                Cancel
              </button>
              <button style={BTN_SAVE} onClick={saveDept} disabled={deptSaving}>
                {deptSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── User department modal ─────────────────────────────────────────── */}
      {editUser && (
        <div style={MODAL_OVERLAY} onClick={() => setEditUser(null)}>
          <div style={MODAL_BOX} onClick={e => e.stopPropagation()}>
            <div style={MODAL_TITLE}>Edit — {editUser.full_name}</div>

            <label style={LABEL}>Department</label>
            <select
              style={SELECT}
              value={userTeam}
              onChange={e => setUserTeam(e.target.value)}
            >
              <option value="">— No department —</option>
              {activeDepts.map(d => (
                <option key={d.department_key} value={d.department_key}>
                  {d.department_name}
                </option>
              ))}
            </select>

            {userError && <div style={ERROR_MSG}>{userError}</div>}

            <div style={BTN_ROW}>
              <button style={BTN_CANCEL} onClick={() => setEditUser(null)}>Cancel</button>
              <button style={BTN_SAVE} onClick={saveUserDept} disabled={userSaving}>
                {userSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ControlCenterLayout>
  )
}
