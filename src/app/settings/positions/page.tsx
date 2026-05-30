'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile, Position } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'

export default function PositionsPage() {
  const [profile, setProfile]       = useState<UserProfile | null>(null)
  const [loading, setLoading]       = useState(true)
  const [positions, setPositions]   = useState<Position[]>([])
  const [newName, setNewName]       = useState('')
  const [editId, setEditId]         = useState<string | null>(null)
  const [editName, setEditName]     = useState('')
  const [saving, setSaving]         = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      const { data } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, is_active, created_at')
        .eq('id', session.user.id)
        .single()
      if (data?.role !== 'admin') { router.push('/dashboard'); return }
      setProfile(data as UserProfile)
      await loadPositions()
      setLoading(false)
    }
    init()
  }, [])

  const loadPositions = async () => {
    const { data } = await supabase
      .from('positions')
      .select('id, name, created_at')
      .order('name', { ascending: true })
    setPositions((data as Position[]) ?? [])
  }

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

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  return (
    <DashboardLayout
      profile={profile}
      title="Positions"
      subtitle="Settings · Positions"
      onSignOut={handleSignOut}
    >
      <div style={{ maxWidth: 560, padding: '24px 0' }}>

        {/* Add position row */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          <input
            type="text"
            placeholder="New position name"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            style={{
              flex: 1,
              height: 38,
              padding: '0 12px',
              fontSize: 14,
              border: `1px solid ${colors.borderSoft}`,
              borderRadius: 8,
              outline: 'none',
              background: colors.base,
              color: colors.primary,
            }}
          />
          <button
            onClick={handleAdd}
            disabled={saving || !newName.trim()}
            style={{
              height: 38,
              padding: '0 16px',
              fontSize: 13,
              fontWeight: 600,
              background: colors.blue,
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              cursor: saving || !newName.trim() ? 'not-allowed' : 'pointer',
              opacity: saving || !newName.trim() ? 0.6 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            Add Position
          </button>
        </div>

        {/* Error */}
        {error && (
          <div style={{
            marginBottom: 14,
            padding: '10px 14px',
            background: colors.redTint,
            border: `1px solid ${colors.red}22`,
            borderRadius: 8,
            fontSize: 13,
            color: colors.red,
          }}>
            {error}
          </div>
        )}

        {/* Positions list */}
        {positions.length === 0 ? (
          <div style={{
            background: colors.base,
            border: `1px solid ${colors.border}`,
            borderRadius: 10,
            padding: '32px 24px',
            textAlign: 'center',
            color: colors.muted,
            fontSize: 13,
          }}>
            No positions yet. Add one above.
          </div>
        ) : (
          <div style={{
            background: colors.base,
            border: `1px solid ${colors.border}`,
            borderRadius: 10,
            overflow: 'hidden',
          }}>
            {positions.map((pos, i) => (
              <div
                key={pos.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '12px 16px',
                  borderTop: i === 0 ? 'none' : `1px solid ${colors.border}`,
                }}
              >
                {editId === pos.id ? (
                  <>
                    <input
                      autoFocus
                      type="text"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleEditSave(pos.id)
                        if (e.key === 'Escape') { setEditId(null); setEditName('') }
                      }}
                      style={{
                        flex: 1,
                        height: 32,
                        padding: '0 10px',
                        fontSize: 13,
                        border: `1px solid ${colors.blue}`,
                        borderRadius: 6,
                        outline: 'none',
                        background: colors.base,
                        color: colors.primary,
                      }}
                    />
                    <button
                      onClick={() => handleEditSave(pos.id)}
                      disabled={saving || !editName.trim()}
                      style={actionBtnStyle(colors.green)}
                    >
                      Save
                    </button>
                    <button
                      onClick={() => { setEditId(null); setEditName('') }}
                      style={actionBtnStyle(colors.muted)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <span style={{ flex: 1, fontSize: 14, color: colors.primary }}>
                      {pos.name}
                    </span>
                    <button
                      onClick={() => { setEditId(pos.id); setEditName(pos.name); setError(null) }}
                      style={actionBtnStyle(colors.secondary)}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(pos.id)}
                      disabled={saving}
                      style={actionBtnStyle(colors.red)}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}

function actionBtnStyle(color: string): React.CSSProperties {
  return {
    padding: '4px 10px',
    fontSize: 12,
    fontWeight: 500,
    color,
    background: 'transparent',
    border: `1px solid ${color}44`,
    borderRadius: 6,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  }
}
