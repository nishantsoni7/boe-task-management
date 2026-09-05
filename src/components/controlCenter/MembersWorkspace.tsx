'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Search, ArrowUpRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile, PasswordResetLogEntry } from '@/lib/types'
import { Avatar } from '@/components/ui/atoms'
import {
  cc, CcSection, CcToolbar, CcTable, CcBadge, CcEmpty, CcDialog, CcField,
} from '@/components/controlCenter/CcPrimitives'
import {
  useAdminMembers, useDeletedMembers, useDepartments, usePositions, useControlCenterCache,
  NO_MEMBERS, NO_DEPARTMENTS, NO_POSITIONS,
} from '@/hooks/queries/useControlCenterData'
import {
  DESIGNATION_LEVELS, DESIGNATION_LEVEL_LABELS,
  designationLevelLabel, employeeSubtitle,
} from '@/lib/users/designationLevels'

// ── Control Center › People › Employees ──────────────────────────────────────
//
// THE ONE PLACE EMPLOYEE ADMINISTRATION HAPPENS.
//
// Before this, the same person was administered in two disconnected screens:
// a read-only table here that could change a department and nothing else, and
// a separate Employee Records page under Task Management that could do
// everything else. An administrator changing somebody's department and their
// job title had to visit both. This screen is the consolidation — the list, and
// one dialog per person holding every operation that belongs to them.
//
// NOTHING NEW IS AUTHORIZED. Every write below is the API route the Employee
// Records page already called, unchanged, each one re-verifying from the bearer
// token that the caller is an admin:
//
//   /api/create-user              add
//   /api/update-member            name, email, department, designation, level, system role
//   /api/toggle-active            activate / deactivate
//   /api/delete-user              soft delete (30-day window)
//   /api/restore-user             restore
//   /api/permanently-delete-user  permanent delete
//   /api/reset-password           reset password
//
// FOUR SEPARATE FACTS, KEPT SEPARATE. Department (users.team) is the functional
// group, Designation (users.position) is the job title, Designation Level
// (users.designation_level) is the organisational rung, and System Access
// (users.role plus Access Control) is what the software lets them do. Only the
// last decides anything — see src/lib/users/designationLevels.ts.

const ROLE_OPTIONS = [
  { value: 'member',  label: 'Member',        hint: 'Standard access. Modules are granted individually in Access Control.' },
  { value: 'manager', label: 'Manager',       hint: 'Standard access plus team performance reporting.' },
  { value: 'admin',   label: 'Administrator', hint: 'Full system authority, including the Control Center. Grants every module.' },
] as const

type StatusFilter = '' | 'active' | 'inactive' | 'deleted'

/** The one bearer token every admin route below verifies. */
async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await createClient().auth.getSession()
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${session?.access_token ?? ''}`,
  }
}

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(path, { method: 'POST', headers: await authHeaders(), body: JSON.stringify(body) })
    const data = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, error: data?.error ?? `Request failed (HTTP ${res.status})` }
    return { ok: true }
  } catch {
    return { ok: false, error: 'Network error — please check your connection and try again.' }
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function daysLeft(scheduledAt: string | null | undefined, nowMs: number): number | null {
  if (!scheduledAt) return null
  return Math.max(0, Math.ceil((new Date(scheduledAt).getTime() - nowMs) / 86_400_000))
}

export function MembersWorkspace() {
  // `nowMs` is read once so the "days left" countdown cannot differ between two
  // rows rendered in the same pass.
  const [nowMs] = useState(() => Date.now())

  const membersQuery = useAdminMembers()
  const deletedQuery = useDeletedMembers()
  const deptsQuery   = useDepartments()
  const positionsQuery = usePositions()
  const { setMembers, setDeletedMembers, refetchMembers } = useControlCenterCache()

  const members   = membersQuery.data   ?? NO_MEMBERS
  const deleted   = deletedQuery.data   ?? NO_MEMBERS
  const depts     = deptsQuery.data     ?? NO_DEPARTMENTS
  const positions = positionsQuery.data ?? NO_POSITIONS
  const loading = membersQuery.isPending || deletedQuery.isPending || deptsQuery.isPending

  const [search,       setSearch]       = useState('')
  const [deptFilter,   setDeptFilter]   = useState('')
  const [levelFilter,  setLevelFilter]  = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('')

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [adding,     setAdding]     = useState(false)
  const [banner,     setBanner]     = useState('')

  const activeDepts = useMemo(() => depts.filter(d => d.is_active), [depts])

  const deptLabel = (key: string | null | undefined) =>
    depts.find(d => d.department_key === key)?.department_name ?? key ?? '—'

  // One list. A deleted account is a status, not a different kind of record, so
  // it is filtered like any other rather than exiled to a side panel.
  const everyone = useMemo<UserProfile[]>(() => [...members, ...deleted], [members, deleted])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return everyone
      .filter(m => !q || m.full_name?.toLowerCase().includes(q) || m.email?.toLowerCase().includes(q))
      .filter(m => !deptFilter || m.team === deptFilter)
      .filter(m => !levelFilter || m.designation_level === levelFilter)
      .filter(m => {
        if (!statusFilter) return true
        if (statusFilter === 'deleted')  return !!m.is_deleted
        if (statusFilter === 'active')   return !m.is_deleted && m.is_active
        return !m.is_deleted && !m.is_active
      })
      .sort((a, b) => a.full_name.localeCompare(b.full_name))
  }, [everyone, search, deptFilter, levelFilter, statusFilter])

  const selected = selectedId ? everyone.find(m => m.id === selectedId) ?? null : null

  const showBanner = (message: string) => {
    setBanner(message)
    setTimeout(() => setBanner(''), 4000)
  }

  // ── Cache patches. Every one mirrors what the server has already confirmed,
  // so the list is correct without a refetch and stays correct if the operator
  // navigates away and back inside the stale window.
  const patchMember = (id: string, patch: Partial<UserProfile>) =>
    setMembers(prev => prev.map(m => (m.id === id ? { ...m, ...patch } : m)))

  const moveToDeleted = (member: UserProfile) => {
    // The server has already set both; these mirror it so the row reads
    // correctly without a refetch, and the next load replaces them with the
    // stored values.
    const now = new Date().toISOString()
    const scheduled = new Date(Date.parse(now) + 30 * 86_400_000).toISOString()
    setMembers(prev => prev.filter(m => m.id !== member.id))
    setDeletedMembers(prev => [
      { ...member, is_deleted: true, deleted_at: now, deletion_scheduled_at: scheduled },
      ...prev,
    ])
  }

  const moveToActiveList = (member: UserProfile) => {
    setDeletedMembers(prev => prev.filter(m => m.id !== member.id))
    setMembers(prev => [
      ...prev,
      { ...member, is_deleted: false, deleted_at: null, deleted_by: null, deletion_scheduled_at: null },
    ])
  }

  if (loading) {
    return <div className={cc.muted} style={{ fontSize: 12.5, padding: '8px 0' }}>Loading employees…</div>
  }

  // A failed read must SAY so. Falling through to an empty table would tell an
  // administrator the company has no employees, which is the one wrong answer.
  const loadError = membersQuery.error ?? deletedQuery.error ?? deptsQuery.error
  if (loadError) {
    return (
      <CcSection>
        <div className={cc.error} style={{ marginTop: 0 }}>
          Could not load employees: {loadError instanceof Error ? loadError.message : String(loadError)}
        </div>
      </CcSection>
    )
  }

  const activeCount   = members.filter(m => m.is_active).length
  const inactiveCount = members.filter(m => !m.is_active).length

  return (
    <CcSection>
      {banner && <div className={cc.note} style={{ marginBottom: 12 }}>{banner}</div>}

      <CcToolbar>
        <div className={cc.search}>
          <Search size={13} strokeWidth={2} />
          <input
            className={cc.control}
            placeholder="Search name or email"
            aria-label="Search employees"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select className={cc.control} aria-label="Department" value={deptFilter} onChange={e => setDeptFilter(e.target.value)}>
          <option value="">All departments</option>
          {depts.map(d => (
            <option key={d.department_key} value={d.department_key}>{d.department_name}</option>
          ))}
        </select>
        <select className={cc.control} aria-label="Designation level" value={levelFilter} onChange={e => setLevelFilter(e.target.value)}>
          <option value="">All levels</option>
          {DESIGNATION_LEVELS.map(l => (
            <option key={l} value={l}>{DESIGNATION_LEVEL_LABELS[l]}</option>
          ))}
        </select>
        <select
          className={cc.control}
          aria-label="Status"
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value as StatusFilter)}
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="deleted">Deleted</option>
        </select>
        <span className={cc.count}>
          {filtered.length} shown · {activeCount} active · {inactiveCount} inactive · {deleted.length} deleted
        </span>
        <span className={cc.toolbarGrow} />
        <button className="boe-btn boe-btn-primary" onClick={() => setAdding(true)}>Add Member</button>
      </CcToolbar>

      {filtered.length === 0 ? (
        <CcEmpty message="No employees match these filters." />
      ) : (
        <CcTable>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Department</th>
              <th>Designation</th>
              <th>Level</th>
              <th>Status</th>
              <th className={cc.right}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(member => {
              const level = designationLevelLabel(member.designation_level)
              return (
                <tr key={member.id}>
                  <td>
                    <div className={cc.person}>
                      <Avatar name={member.full_name} size={26} />
                      <div style={{ minWidth: 0 }}>
                        <div className={cc.personName}>{member.full_name}</div>
                        <div className={cc.personSub}>{member.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className={member.team ? undefined : cc.faint}>{deptLabel(member.team)}</td>
                  <td className={member.position ? cc.muted : cc.faint}>{member.position ?? '—'}</td>
                  <td className={level ? cc.muted : cc.faint}>{level ?? 'Not set'}</td>
                  <td>
                    {member.is_deleted
                      ? <CcBadge tone="red">Deleted</CcBadge>
                      : <CcBadge tone={member.is_active ? 'green' : 'gray'}>{member.is_active ? 'Active' : 'Inactive'}</CcBadge>}
                  </td>
                  <td className={cc.right}>
                    <button className={cc.linkBtn} onClick={() => setSelectedId(member.id)}>Manage</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </CcTable>
      )}

      {adding && (
        <AddMemberDialog
          departments={activeDepts.map(d => ({ key: d.department_key, name: d.department_name }))}
          positions={positions.map(p => p.name)}
          onClose={() => setAdding(false)}
          onCreated={async () => {
            setAdding(false)
            await refetchMembers()
            showBanner('Member added.')
          }}
        />
      )}

      {selected && (
        <MemberDialog
          key={selected.id}
          member={selected}
          nowMs={nowMs}
          departments={activeDepts.map(d => ({ key: d.department_key, name: d.department_name }))}
          positions={positions.map(p => p.name)}
          deptLabel={deptLabel}
          onClose={() => setSelectedId(null)}
          onSaved={patch => { patchMember(selected.id, patch); showBanner('Employee updated.') }}
          onToggledActive={isActive => {
            patchMember(selected.id, { is_active: isActive })
            showBanner(isActive ? 'Member activated.' : 'Member deactivated.')
          }}
          onDeleted={() => {
            moveToDeleted(selected)
            setSelectedId(null)
            showBanner('Member deleted. They can be restored within 30 days.')
          }}
          onRestored={() => {
            moveToActiveList(selected)
            showBanner('Member restored.')
          }}
          onPurged={() => {
            setDeletedMembers(prev => prev.filter(m => m.id !== selected.id))
            setSelectedId(null)
            showBanner('Member permanently deleted.')
          }}
        />
      )}
    </CcSection>
  )
}

// ── Add member ───────────────────────────────────────────────────────────────

function AddMemberDialog({
  departments, positions, onClose, onCreated,
}: {
  departments: { key: string; name: string }[]
  positions: string[]
  onClose: () => void
  onCreated: () => void
}) {
  const [fullName, setFullName] = useState('')
  const [email,    setEmail]    = useState('')
  const [phone,    setPhone]    = useState('')
  const [password, setPassword] = useState('')
  const [team,     setTeam]     = useState(departments[0]?.key ?? '')
  const [position, setPosition] = useState('')
  const [level,    setLevel]    = useState('')
  const [role,     setRole]     = useState<'member' | 'manager' | 'admin'>('member')
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState('')

  const submit = async () => {
    if (!fullName.trim() || !email.trim() || !password.trim()) {
      setError('Name, email and a temporary password are required.')
      return
    }
    if (!EMAIL_RE.test(email.trim())) { setError('Please enter a valid email address.'); return }
    setSaving(true)
    setError('')
    const res = await postJson('/api/create-user', {
      email: email.trim(),
      password: password.trim(),
      full_name: fullName.trim(),
      phone: phone.trim() || null,
      role,
      team,
      position: position || null,
      designation_level: level || null,
    })
    setSaving(false)
    if (!res.ok) { setError(res.error ?? 'Failed to create member'); return }
    onCreated()
  }

  return (
    <CcDialog
      title="Add member"
      subtitle="Creates the login and the employee record together."
      onClose={onClose}
      footer={
        <>
          <button className="boe-btn boe-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="boe-btn boe-btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Creating…' : 'Create member'}
          </button>
        </>
      }
    >
      <div className={cc.memberGrid}>
        <CcField label="Full name">
          <input className={cc.fieldControl} value={fullName} onChange={e => setFullName(e.target.value)} />
        </CcField>
        <CcField label="Email">
          <input className={cc.fieldControl} type="email" value={email} onChange={e => setEmail(e.target.value)} />
        </CcField>
        <CcField label="Phone (optional)">
          <input className={cc.fieldControl} type="tel" value={phone} onChange={e => setPhone(e.target.value)} />
        </CcField>
        <CcField label="Temporary password">
          <input className={cc.fieldControl} type="password" value={password} onChange={e => setPassword(e.target.value)} />
        </CcField>
      </div>

      <div className={cc.memberGroup}>
        <div className={cc.memberGroupTitle}>Employment</div>
        <div className={cc.memberGrid}>
          <CcField label="Department">
            <select className={cc.fieldControl} value={team} onChange={e => setTeam(e.target.value)}>
              {departments.map(d => <option key={d.key} value={d.key}>{d.name}</option>)}
            </select>
          </CcField>
          <CcField label="Designation">
            <select className={cc.fieldControl} value={position} onChange={e => setPosition(e.target.value)}>
              <option value="">— None —</option>
              {positions.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </CcField>
          <CcField label="Designation level">
            <select className={cc.fieldControl} value={level} onChange={e => setLevel(e.target.value)}>
              <option value="">— Not set —</option>
              {DESIGNATION_LEVELS.map(l => <option key={l} value={l}>{DESIGNATION_LEVEL_LABELS[l]}</option>)}
            </select>
          </CcField>
          <CcField label="System access" hint={ROLE_OPTIONS.find(r => r.value === role)?.hint}>
            <select className={cc.fieldControl} value={role} onChange={e => setRole(e.target.value as typeof role)}>
              {ROLE_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </CcField>
        </div>
      </div>

      {error && <div className={cc.error}>{error}</div>}
    </CcDialog>
  )
}

// ── One member ───────────────────────────────────────────────────────────────

type ConfirmKind = null | 'delete' | 'purge'

function MemberDialog({
  member, nowMs, departments, positions, deptLabel,
  onClose, onSaved, onToggledActive, onDeleted, onRestored, onPurged,
}: {
  member: UserProfile
  nowMs: number
  departments: { key: string; name: string }[]
  positions: string[]
  deptLabel: (key: string | null | undefined) => string
  onClose: () => void
  onSaved: (patch: Partial<UserProfile>) => void
  onToggledActive: (isActive: boolean) => void
  onDeleted: () => void
  onRestored: () => void
  onPurged: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const isDeleted = !!member.is_deleted

  const [name,     setName]     = useState(member.full_name)
  const [email,    setEmail]    = useState(member.email ?? '')
  const [team,     setTeam]     = useState(member.team ?? '')
  const [position, setPosition] = useState(member.position ?? '')
  const [level,    setLevel]    = useState(member.designation_level ?? '')
  const [role,     setRole]     = useState<'member' | 'manager' | 'admin'>(member.role)

  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')
  const [busy,    setBusy]    = useState('')
  const [confirm, setConfirm] = useState<ConfirmKind>(null)

  const [showReset,  setShowReset]  = useState(false)
  const [pw1,        setPw1]        = useState('')
  const [pw2,        setPw2]        = useState('')
  const [pwError,    setPwError]    = useState('')
  const [pwDone,     setPwDone]     = useState(false)
  const [history,    setHistory]    = useState<PasswordResetLogEntry[]>([])

  // The last few password resets on this account, so an administrator can see
  // whether somebody has already done what they are about to do.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const { data } = await supabase
        .from('password_reset_log')
        .select('id, target_id, actor_id, reset_at, ip_address, users:actor_id ( full_name )')
        .eq('target_id', member.id)
        .order('reset_at', { ascending: false })
        .limit(5)
      if (cancelled || !data) return
      type Row = PasswordResetLogEntry & { users: { full_name: string } | null }
      setHistory((data as unknown as Row[]).map(e => ({ ...e, actor_name: e.users?.full_name ?? null })))
    }
    void load()
    return () => { cancelled = true }
  }, [member.id, supabase])

  const dirty =
    name !== member.full_name ||
    email !== (member.email ?? '') ||
    team !== (member.team ?? '') ||
    position !== (member.position ?? '') ||
    level !== (member.designation_level ?? '') ||
    role !== member.role

  const save = async () => {
    if (!name.trim())  { setError('Full name is required.'); return }
    if (!email.trim()) { setError('Email is required.'); return }
    if (!EMAIL_RE.test(email.trim())) { setError('Please enter a valid email address.'); return }
    setSaving(true)
    setError('')
    const res = await postJson('/api/update-member', {
      userId: member.id,
      full_name: name.trim(),
      email: email.trim(),
      team,
      role,
      position: position || null,
      designation_level: level || null,
    })
    setSaving(false)
    if (!res.ok) { setError(res.error ?? 'Failed to update employee'); return }
    onSaved({
      full_name: name.trim(),
      email: email.trim(),
      team,
      role,
      position: position || null,
      designation_level: level || null,
    })
  }

  const toggleActive = async () => {
    setBusy('active')
    setError('')
    const next = !member.is_active
    const res = await postJson('/api/toggle-active', { userId: member.id, is_active: next })
    setBusy('')
    if (!res.ok) { setError(res.error ?? 'Failed to update status'); return }
    onToggledActive(next)
  }

  const softDelete = async () => {
    setBusy('delete')
    setError('')
    const res = await postJson('/api/delete-user', { userId: member.id })
    setBusy('')
    if (!res.ok) { setError(res.error ?? 'Failed to delete member'); return }
    onDeleted()
  }

  const restore = async () => {
    setBusy('restore')
    setError('')
    const res = await postJson('/api/restore-user', { userId: member.id })
    setBusy('')
    if (!res.ok) { setError(res.error ?? 'Failed to restore member'); return }
    onRestored()
  }

  const purge = async () => {
    setBusy('purge')
    setError('')
    const res = await postJson('/api/permanently-delete-user', { userId: member.id })
    setBusy('')
    if (!res.ok) { setError(res.error ?? 'Failed to permanently delete member'); return }
    onPurged()
  }

  const resetPassword = async () => {
    if (!pw1.trim())        { setPwError('New password is required.'); return }
    if (pw1.length < 6)     { setPwError('Password must be at least 6 characters.'); return }
    if (pw1 !== pw2)        { setPwError('Passwords do not match.'); return }
    setBusy('password')
    setPwError('')
    const res = await postJson('/api/reset-password', { userId: member.id, newPassword: pw1 })
    setBusy('')
    if (!res.ok) { setPwError(res.error ?? 'Failed to reset password'); return }
    setPw1(''); setPw2(''); setPwDone(true)
  }

  const remaining = daysLeft(member.deletion_scheduled_at, nowMs)

  return (
    <CcDialog
      title={member.full_name}
      subtitle={employeeSubtitle(member) || deptLabel(member.team)}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="boe-btn boe-btn-ghost" onClick={onClose} disabled={saving}>Close</button>
          {!isDeleted && (
            <button className="boe-btn boe-btn-primary" onClick={save} disabled={saving || !dirty}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          )}
        </>
      }
    >
      <div className={cc.memberHead}>
        <Avatar name={member.full_name} size={40} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className={cc.memberHeadName}>{member.full_name}</div>
          <div className={cc.memberHeadSub}>{member.email}</div>
        </div>
        {isDeleted
          ? <CcBadge tone="red">{remaining !== null ? `Deleted · ${remaining}d left` : 'Deleted'}</CcBadge>
          : <CcBadge tone={member.is_active ? 'green' : 'gray'}>{member.is_active ? 'Active' : 'Inactive'}</CcBadge>}
      </div>

      {isDeleted && (
        <div className={cc.note} style={{ marginTop: 10 }}>
          <span className={cc.noteTitle}>This account is deleted.</span>
          Its details cannot be edited. Restore it to make changes, or delete it permanently below.
        </div>
      )}

      {/* ── Employment ─────────────────────────────────────────────────── */}
      <div className={cc.memberGroup}>
        <div className={cc.memberGroupTitle}>Employment</div>
        <div className={cc.memberGrid}>
          <CcField label="Department">
            <select className={cc.fieldControl} value={team} disabled={isDeleted} onChange={e => setTeam(e.target.value)}>
              {/* A department that has since been deactivated is still this
                  person's department; offering it keeps the select honest
                  instead of silently reassigning them on save. */}
              {!departments.some(d => d.key === team) && team && (
                <option value={team}>{deptLabel(team)}</option>
              )}
              {departments.map(d => <option key={d.key} value={d.key}>{d.name}</option>)}
            </select>
          </CcField>
          <CcField label="Designation" hint="Their job title.">
            <select className={cc.fieldControl} value={position} disabled={isDeleted} onChange={e => setPosition(e.target.value)}>
              <option value="">— None —</option>
              {!positions.includes(position) && position && <option value={position}>{position}</option>}
              {positions.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </CcField>
          <CcField label="Designation level" hint="Where they sit in the organisation. Grants no system access on its own.">
            <select className={cc.fieldControl} value={level} disabled={isDeleted} onChange={e => setLevel(e.target.value)}>
              <option value="">— Not set —</option>
              {DESIGNATION_LEVELS.map(l => <option key={l} value={l}>{DESIGNATION_LEVEL_LABELS[l]}</option>)}
            </select>
          </CcField>
        </div>
      </div>

      {/* ── Account ────────────────────────────────────────────────────── */}
      <div className={cc.memberGroup}>
        <div className={cc.memberGroupTitle}>Account</div>
        <div className={cc.memberGrid}>
          <CcField label="Full name">
            <input className={cc.fieldControl} value={name} disabled={isDeleted} onChange={e => setName(e.target.value)} />
          </CcField>
          <CcField label="Email">
            <input className={cc.fieldControl} type="email" value={email} disabled={isDeleted} onChange={e => setEmail(e.target.value)} />
          </CcField>
        </div>

        {!isDeleted && (
          <div className={cc.memberActions} style={{ marginBottom: 12 }}>
            <button className="boe-btn boe-btn-ghost" onClick={toggleActive} disabled={busy === 'active'}>
              {busy === 'active' ? '…' : member.is_active ? 'Deactivate account' : 'Activate account'}
            </button>
            {!showReset && (
              <button className="boe-btn boe-btn-ghost" onClick={() => { setShowReset(true); setPwDone(false); setPwError('') }}>
                Reset password
              </button>
            )}
          </div>
        )}

        {!isDeleted && showReset && (
          <div className={cc.note} style={{ marginBottom: 12 }}>
            {pwDone ? (
              <>
                <span className={cc.success}>Password reset.</span>{' '}
                <button className={cc.linkBtn} onClick={() => { setShowReset(false); setPwDone(false) }}>Done</button>
              </>
            ) : (
              <>
                <div className={cc.memberGrid}>
                  <CcField label="New password">
                    <input className={cc.fieldControl} type="password" value={pw1} onChange={e => setPw1(e.target.value)} />
                  </CcField>
                  <CcField label="Confirm password">
                    <input className={cc.fieldControl} type="password" value={pw2} onChange={e => setPw2(e.target.value)} />
                  </CcField>
                </div>
                {pwError && <div className={cc.error} style={{ marginBottom: 8 }}>{pwError}</div>}
                <div className={cc.memberActions}>
                  <button className="boe-btn boe-btn-primary" onClick={resetPassword} disabled={busy === 'password'}>
                    {busy === 'password' ? 'Resetting…' : 'Confirm reset'}
                  </button>
                  <button className="boe-btn boe-btn-ghost" onClick={() => setShowReset(false)} disabled={busy === 'password'}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {history.length > 0 && (
          <div className={cc.memberHistory}>
            <strong>Recent password resets</strong>
            {history.map(entry => (
              <div key={entry.id}>
                {entry.actor_name ?? 'Unknown'} ·{' '}
                {new Date(entry.reset_at).toLocaleString('en-GB', {
                  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Access ─────────────────────────────────────────────────────── */}
      <div className={cc.memberGroup}>
        <div className={cc.memberGroupTitle}>Access</div>
        <div className={cc.memberGrid}>
          <CcField
            label="System role"
            hint={ROLE_OPTIONS.find(r => r.value === role)?.hint}
          >
            <select className={cc.fieldControl} value={role} disabled={isDeleted} onChange={e => setRole(e.target.value as typeof role)}>
              {ROLE_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </CcField>
          <CcField label="Module access" hint="Per-module permissions, including custom grants.">
            <Link
              className="boe-btn boe-btn-ghost"
              href={`/admin/control-center/permissions?employee=${member.id}`}
              style={{ justifyContent: 'center' }}
            >
              Manage access <ArrowUpRight size={12} />
            </Link>
          </CcField>
        </div>
        <div className={cc.note}>
          System role and module permissions are what decide access. Department, designation
          and designation level describe the organisation and grant nothing on their own.
        </div>
      </div>

      {/* ── Danger zone ────────────────────────────────────────────────── */}
      <div className={`${cc.memberGroup} ${cc.memberDangerGroup}`}>
        <div className={cc.memberGroupTitle}>Danger zone</div>

        {confirm === 'delete' && (
          <div className={cc.note} style={{ marginBottom: 10 }}>
            <span className={cc.noteTitle}>Delete {member.full_name}?</span>
            They move to Deleted and can be restored for 30 days.
            <div className={cc.memberActions} style={{ marginTop: 10 }}>
              <button className="boe-btn boe-btn-ghost" onClick={() => setConfirm(null)} disabled={busy === 'delete'}>Cancel</button>
              <button className="boe-btn boe-btn-ghost" style={{ color: '#B0364A' }} onClick={softDelete} disabled={busy === 'delete'}>
                {busy === 'delete' ? 'Deleting…' : 'Delete member'}
              </button>
            </div>
          </div>
        )}

        {confirm === 'purge' && (
          <div className={cc.note} style={{ marginBottom: 10 }}>
            <span className={cc.noteTitle}>Permanently delete {member.full_name}?</span>
            This removes the account and every linked task record, activity log, notification
            and password reset log. It cannot be undone.
            <div className={cc.memberActions} style={{ marginTop: 10 }}>
              <button className="boe-btn boe-btn-ghost" onClick={() => setConfirm(null)} disabled={busy === 'purge'}>Cancel</button>
              <button className="boe-btn boe-btn-ghost" style={{ color: '#B0364A' }} onClick={purge} disabled={busy === 'purge'}>
                {busy === 'purge' ? 'Deleting…' : 'Permanently delete'}
              </button>
            </div>
          </div>
        )}

        {!confirm && (
          <div className={cc.memberActions}>
            {isDeleted ? (
              <>
                <button className="boe-btn boe-btn-ghost" onClick={restore} disabled={busy === 'restore'}>
                  {busy === 'restore' ? 'Restoring…' : 'Restore member'}
                </button>
                <button className="boe-btn boe-btn-ghost" style={{ color: '#B0364A' }} onClick={() => setConfirm('purge')}>
                  Permanently delete
                </button>
              </>
            ) : member.is_active ? (
              // Deleting an active account is refused by /api/delete-user, so the
              // screen says why rather than offering a button that fails.
              <span className={cc.muted} style={{ fontSize: 12.5 }}>
                Deactivate this account before it can be deleted.
              </span>
            ) : (
              <button className="boe-btn boe-btn-ghost" style={{ color: '#B0364A' }} onClick={() => setConfirm('delete')}>
                Delete member
              </button>
            )}
          </div>
        )}
      </div>

      {error && <div className={cc.error}>{error}</div>}
    </CcDialog>
  )
}
