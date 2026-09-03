'use client'

import { useEffect, useState, useMemo, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Position } from '@/lib/types'
import { cc, CcTable, CcToolbar, CcEmpty } from '@/components/controlCenter/CcPrimitives'

// The Positions editor, shared by Settings › Positions and the Control Center's
// People › Positions so there is one implementation. Queries and rules are
// unchanged; the presentation is the Control Center's, so a position row reads
// the same as a department row.

export function PositionsManager() {
  const [loading, setLoading]       = useState(true)
  const [positions, setPositions]   = useState<Position[]>([])
  const [newName, setNewName]       = useState('')
  const [editId, setEditId]         = useState<string | null>(null)
  const [editName, setEditName]     = useState('')
  const [saving, setSaving]         = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])

  const loadPositions = useCallback(async () => {
    const { data } = await supabase
      .from('positions')
      .select('id, name, created_at')
      .order('name', { ascending: true })
    setPositions((data as Position[]) ?? [])
    setLoading(false)
  }, [supabase])

  // A FETCH IS STARTED HERE; NO STATE IS SET HERE. Every setState inside
  // loadPositions runs after its first await.
  useEffect(() => {
    const startFetch = () => { void loadPositions() }
    startFetch()
  }, [loadPositions])

  const handleAdd = async () => {
    const name = newName.trim()
    if (!name) return
    setSaving(true)
    setError(null)
    const { error: err } = await supabase.from('positions').insert({ name })
    if (err) {
      setError(err.message.includes('unique') ? 'A position with that name already exists.' : err.message)
    } else {
      setNewName('')
      await loadPositions()
    }
    setSaving(false)
  }

  const handleEditSave = async (id: string) => {
    const name = editName.trim()
    if (!name) return
    setSaving(true)
    setError(null)
    const { error: err } = await supabase.from('positions').update({ name }).eq('id', id)
    if (err) {
      setError(err.message.includes('unique') ? 'A position with that name already exists.' : err.message)
    } else {
      setEditId(null)
      setEditName('')
      await loadPositions()
    }
    setSaving(false)
  }

  const handleDelete = async (id: string) => {
    setSaving(true)
    setError(null)
    await supabase.from('positions').delete().eq('id', id)
    await loadPositions()
    setSaving(false)
  }

  if (loading) {
    return <div className={cc.muted} style={{ fontSize: 12.5, padding: '8px 0' }}>Loading…</div>
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <CcToolbar>
        <input
          type="text"
          className={cc.control}
          style={{ flex: '1 1 240px' }}
          placeholder="New position name"
          aria-label="New position name"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
        />
        <button
          className="boe-btn boe-btn-primary"
          onClick={handleAdd}
          disabled={saving || !newName.trim()}
        >
          Add Position
        </button>
        <span className={cc.count}>{positions.length} {positions.length === 1 ? 'position' : 'positions'}</span>
      </CcToolbar>

      {error && <div className={cc.error} style={{ marginTop: 0, marginBottom: 12 }}>{error}</div>}

      {positions.length === 0 ? (
        <CcEmpty message="No positions yet." hint="Add one above; it becomes available on employee records." />
      ) : (
        <CcTable>
          <thead>
            <tr>
              <th>Position</th>
              <th className={cc.right}></th>
            </tr>
          </thead>
          <tbody>
            {positions.map(pos => (
              <tr key={pos.id}>
                {editId === pos.id ? (
                  <>
                    <td>
                      <input
                        autoFocus
                        type="text"
                        className={cc.control}
                        style={{ width: '100%', maxWidth: 360 }}
                        aria-label="Position name"
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleEditSave(pos.id)
                          if (e.key === 'Escape') { setEditId(null); setEditName('') }
                        }}
                      />
                    </td>
                    <td className={cc.right}>
                      <span className={cc.rowActions}>
                        <button className={cc.linkBtn} onClick={() => handleEditSave(pos.id)} disabled={saving || !editName.trim()}>
                          Save
                        </button>
                        <button className={`${cc.linkBtn} ${cc.linkBtnMuted}`} onClick={() => { setEditId(null); setEditName('') }}>
                          Cancel
                        </button>
                      </span>
                    </td>
                  </>
                ) : (
                  <>
                    <td style={{ fontWeight: 600 }}>{pos.name}</td>
                    <td className={cc.right}>
                      <span className={cc.rowActions}>
                        <button className={cc.linkBtn} onClick={() => { setEditId(pos.id); setEditName(pos.name); setError(null) }}>
                          Edit
                        </button>
                        <button className={`${cc.linkBtn} ${cc.linkBtnMuted}`} onClick={() => handleDelete(pos.id)} disabled={saving}>
                          Delete
                        </button>
                      </span>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </CcTable>
      )}
    </div>
  )
}
