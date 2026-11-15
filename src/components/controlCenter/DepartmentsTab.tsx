'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { ControlCenterSkeleton } from '@/components/layout/ControlCenterSkeleton'
import { Avatar } from '@/components/ui/atoms'
import {
  cc, CcSection, CcToolbar, CcTable, ActiveBadge, CcEmpty, CcDialog, CcField,
} from '@/components/controlCenter/CcPrimitives'
import {
  useAdminMembers, useDepartments, useControlCenterCache, NO_MEMBERS, NO_DEPARTMENTS,
  type ControlCenterDepartment,
} from '@/hooks/queries/useControlCenterData'

// Control Center › People › Departments (moved out of the main page file, 2026-11-15, when the screen got
// an address of its own: /admin/control-center/departments).
//
// The list is the shared department cache; every save patches that cache, so Employees, Access and Home
// see a rename or a new department without a reload. Deleting is refused while people are assigned (the
// route repeats the check). The bearer token is the signed-in administrator's, read once for the routes
// below; the admin gate itself is control-center/layout.tsx's.

type Department = ControlCenterDepartment

export function DepartmentsTab() {
  const supabase = useMemo(() => createClient(), [])
  const [token, setToken] = useState('')

  const membersQuery = useAdminMembers()
  const deptsQuery   = useDepartments()
  const { setMembers, setDepts } = useControlCenterCache()
  const members = membersQuery.data ?? NO_MEMBERS
  const depts   = deptsQuery.data   ?? NO_DEPARTMENTS

  // ── Department modal (edit or add) ───────────────────────────────────────
  const [editDept,   setEditDept]   = useState<Department | null>(null)
  const [addingDept, setAddingDept] = useState(false)
  const [deptName,   setDeptName]   = useState('')
  const [deptActive, setDeptActive] = useState(true)
  const [deptSaving, setDeptSaving] = useState(false)
  const [deptError,  setDeptError]  = useState('')

  // ── Department delete modal ───────────────────────────────────────────────
  const [deleteDept,   setDeleteDept]   = useState<Department | null>(null)
  const [deleteSaving, setDeleteSaving] = useState(false)
  const [deleteError,  setDeleteError]  = useState('')

  // ── Department people popup ───────────────────────────────────────────────
  const [peopleDept, setPeopleDept] = useState<Department | null>(null)

  // ── Inline row edit (department popup) ────────────────────────────────────
  const [editingPersonId,    setEditingPersonId]    = useState<string | null>(null)
  const [editingPersonTeam,  setEditingPersonTeam]  = useState('')
  const [editingPersonSaving,setEditingPersonSaving]= useState(false)
  const [editingPersonError, setEditingPersonError] = useState('')

  useEffect(() => {
    const init = async () => {
      // Identity and the admin check are owned by control-center/layout.tsx,
      // which renders this page only for an admitted administrator. The stored
      // session is read here solely for the bearer token the save handlers
      // below need; the lists themselves come from the shared queries above.
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      setToken(session.access_token)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activeDepts = depts.filter(d => d.is_active)

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

  function closeDeptModal() {
    setEditDept(null)
    setAddingDept(false)
  }

  function openDeleteDept(dept: Department) {
    setDeleteDept(dept)
    setDeleteError('')
  }

  function closeDeleteDept() {
    setDeleteDept(null)
    setDeleteError('')
  }

  function openPeopleDept(dept: Department) {
    setPeopleDept(dept)
    setEditingPersonId(null)
    setEditingPersonError('')
  }

  function closePeopleDept() {
    setPeopleDept(null)
    setEditingPersonId(null)
    setEditingPersonError('')
  }

  function startEditPerson(person: UserProfile) {
    setEditingPersonId(person.id)
    setEditingPersonTeam(person.team ?? '')
    setEditingPersonError('')
  }

  function cancelEditPerson() {
    setEditingPersonId(null)
    setEditingPersonError('')
  }

  // ── Save handlers ──────────────────────────────────────────────────────────

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

  async function confirmDeleteDept() {
    if (!deleteDept) return
    setDeleteSaving(true); setDeleteError('')
    try {
      const res = await fetch(`/api/control-center/departments/${deleteDept.department_key}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const json = await res.json()
      if (!res.ok) { setDeleteError(json.error ?? 'Delete failed'); return }
      setDepts(prev => prev.filter(d => d.department_key !== deleteDept.department_key))
      setDeleteDept(null)
    } finally {
      setDeleteSaving(false)
    }
  }

  async function saveEditPerson(person: UserProfile) {
    setEditingPersonSaving(true); setEditingPersonError('')
    try {
      const res = await fetch('/api/update-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          userId:    person.id,
          full_name: person.full_name,
          team:      editingPersonTeam,
          role:      person.role,
          position:  person.position ?? null,
        }),
      })
      const json = await res.json()
      if (!res.ok) { setEditingPersonError(json.error ?? 'Save failed'); return }
      setMembers(prev => prev.map(m =>
        m.id === person.id ? { ...m, team: editingPersonTeam } : m
      ))
      setEditingPersonId(null)
    } catch {
      setEditingPersonError('Save failed. Check your connection and try again.')
    } finally {
      setEditingPersonSaving(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (membersQuery.isPending || deptsQuery.isPending) return <ControlCenterSkeleton />

  const deptLabel = (key: string | null | undefined) => {
    if (!key) return '—'
    return depts.find(d => d.department_key === key)?.department_name ?? key
  }

  // members is already loaded pre-filtered to non-deleted users (see
  // /api/admin-members), so this is exactly "people currently assigned to
  // this department" — the same set that blocks a department delete.
  const peopleInDept = (key: string) =>
    members.filter(m => m.team === key).length

  return (
    <>
      <CcSection>
        <CcToolbar>
          <span className={cc.count}>
            {activeDepts.length} active · {depts.length - activeDepts.length} inactive
          </span>
          <span className={cc.toolbarGrow} />
          <button className="boe-btn boe-btn-primary" onClick={openAddDept}>Add Department</button>
        </CcToolbar>

        {depts.length === 0 ? (
          <CcEmpty message="No departments yet." hint="Add a department to start assigning people to it." />
        ) : (
          <CcTable>
            <thead>
              <tr>
                <th>Department</th>
                <th>People</th>
                <th>Status</th>
                <th className={cc.right}></th>
              </tr>
            </thead>
            <tbody>
              {depts.map(dept => (
                <tr key={dept.department_key}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{dept.department_name}</div>
                    <div className={cc.mono}>{dept.department_key}</div>
                  </td>
                  <td>
                    <button
                      className={cc.countBtn}
                      onClick={() => openPeopleDept(dept)}
                      title="See who is in this department"
                    >
                      {peopleInDept(dept.department_key)}
                    </button>
                  </td>
                  <td><ActiveBadge active={dept.is_active} /></td>
                  <td className={cc.right}>
                    <span className={cc.rowActions}>
                      <button className={cc.linkBtn} onClick={() => openEditDept(dept)}>Edit</button>
                      <button className={`${cc.linkBtn} ${cc.linkBtnMuted}`} onClick={() => openDeleteDept(dept)}>Delete</button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </CcTable>
        )}
      </CcSection>

      {/* ── Department dialog (add / edit) ────────────────────────────────── */}
      {(editDept || addingDept) && (
        <CcDialog
          title={addingDept ? 'Add Department' : editDept!.department_name}
          subtitle={addingDept ? 'A short key is generated automatically from the name.' : 'Rename the department or change whether it is active.'}
          onClose={closeDeptModal}
          footer={
            <>
              <button className="boe-btn boe-btn-ghost" onClick={closeDeptModal}>Cancel</button>
              <button className="boe-btn boe-btn-primary" onClick={saveDept} disabled={deptSaving}>
                {deptSaving ? 'Saving…' : 'Save'}
              </button>
            </>
          }
        >
          <CcField label="Department name">
            <input
              className={cc.fieldControl}
              value={deptName}
              onChange={e => setDeptName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !deptSaving) void saveDept() }}
              placeholder="e.g. Business Development"
              autoFocus
            />
          </CcField>

          {!addingDept && (
            <label className={cc.check}>
              <input
                type="checkbox"
                checked={deptActive}
                onChange={e => setDeptActive(e.target.checked)}
              />
              Active
            </label>
          )}

          {deptError && <div className={cc.error}>{deptError}</div>}
        </CcDialog>
      )}

      {/* ── Department delete dialog ──────────────────────────────────────── */}
      {deleteDept && (
        peopleInDept(deleteDept.department_key) > 0 ? (
          <CcDialog
            title={`Delete ${deleteDept.department_name}`}
            onClose={closeDeleteDept}
            footer={<button className="boe-btn boe-btn-primary" onClick={closeDeleteDept}>OK</button>}
          >
            <div style={{ fontSize: 13 }}>
              This department has people assigned. Move them before deleting.
            </div>
          </CcDialog>
        ) : (
          <CcDialog
            title={`Delete ${deleteDept.department_name}`}
            onClose={closeDeleteDept}
            footer={
              <>
                <button className="boe-btn boe-btn-ghost" onClick={closeDeleteDept}>Cancel</button>
                <button className="boe-btn boe-btn-danger" onClick={confirmDeleteDept} disabled={deleteSaving}>
                  {deleteSaving ? 'Deleting…' : 'Delete department'}
                </button>
              </>
            }
          >
            <div style={{ fontSize: 13 }}>
              Delete <strong>{deleteDept.department_name}</strong>? This cannot be undone.
            </div>
            {deleteError && <div className={cc.error}>{deleteError}</div>}
          </CcDialog>
        )
      )}

      {/* ── Department people dialog ──────────────────────────────────────── */}
      {peopleDept && (
        <CcDialog
          title={`People in ${peopleDept.department_name}`}
          subtitle="Reassign anyone here without leaving the list."
          onClose={closePeopleDept}
          wide
          footer={<button className="boe-btn boe-btn-ghost" onClick={closePeopleDept}>Close</button>}
        >
          {(() => {
            const people = members.filter(m => !m.is_deleted && m.team === peopleDept.department_key)
            if (people.length === 0) {
              return <div className={cc.muted} style={{ fontSize: 13 }}>No people are assigned to this department.</div>
            }
            return (
              <CcTable>
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Role</th>
                    <th>Department</th>
                    <th>Status</th>
                    <th className={cc.right}></th>
                  </tr>
                </thead>
                <tbody>
                  {people.map(person => {
                    const isEditing = editingPersonId === person.id
                    return (
                      <tr key={person.id}>
                        <td>
                          <div className={cc.person}>
                            <Avatar name={person.full_name} size={26} />
                            <div style={{ minWidth: 0 }}>
                              <div className={cc.personName}>{person.full_name}</div>
                              <div className={cc.personSub}>{person.email}</div>
                            </div>
                          </div>
                        </td>
                        <td className={`${cc.muted} ${cc.cap}`}>{person.role}</td>
                        <td>
                          {isEditing ? (
                            <>
                              <select
                                className={`${cc.control} ${cc.inlineSelect}`}
                                value={editingPersonTeam}
                                onChange={e => setEditingPersonTeam(e.target.value)}
                                disabled={editingPersonSaving}
                              >
                                {activeDepts.map(d => (
                                  <option key={d.department_key} value={d.department_key}>
                                    {d.department_name}
                                  </option>
                                ))}
                              </select>
                              {editingPersonError && (
                                <div className={cc.error} style={{ marginTop: 4 }}>{editingPersonError}</div>
                              )}
                            </>
                          ) : (
                            <span className={person.team ? undefined : cc.faint}>{deptLabel(person.team)}</span>
                          )}
                        </td>
                        <td><ActiveBadge active={person.is_active} /></td>
                        <td className={cc.right}>
                          {isEditing ? (
                            <span className={cc.rowActions}>
                              <button className={cc.linkBtn} onClick={() => saveEditPerson(person)} disabled={editingPersonSaving}>
                                {editingPersonSaving ? 'Saving…' : 'Save'}
                              </button>
                              <button className={`${cc.linkBtn} ${cc.linkBtnMuted}`} onClick={cancelEditPerson} disabled={editingPersonSaving}>
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button className={cc.linkBtn} onClick={() => startEditPerson(person)}>Change department</button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </CcTable>
            )
          })()}
        </CcDialog>
      )}
    </>
  )
}
