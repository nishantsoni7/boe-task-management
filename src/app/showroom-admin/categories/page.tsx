'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile, ShowroomCategory, ShowroomProduct } from '@/lib/types'
import { AlertBanner, EmptyState } from '@/components/ui/atoms'
import { ShowroomAdminLayout } from '@/components/layout/ShowroomAdminLayout'
import { colors, font } from '@/lib/tokens'
import { Tag, PlusCircle, Pencil, Trash2, Check, X } from 'lucide-react'
import { useViewAs } from '@/hooks/useViewAs'
import { canAccessModule, type ModuleVisibilityType } from '@/lib/moduleAccess'
import { useRefreshShowroomProductCounts } from '@/hooks/queries/useShowroomProductCounts'

type ModVisRow = { visibility_type: string; allowed_department: string[] | null }
const teamFallback = (team?: string | null) =>
  !!team && (team.toLowerCase().includes('sales') || team.toLowerCase().includes('showroom'))

export default function ShowroomCategoriesPage() {
  const [profile,     setProfile]     = useState<UserProfile | null>(null)
  const [categories,  setCategories]  = useState<ShowroomCategory[]>([])
  const [products,    setProducts]    = useState<ShowroomProduct[]>([])
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState('')
  const [notice,      setNotice]      = useState('')
  const [showroomMod, setShowroomMod] = useState<ModVisRow | null>(null)

  const [newName,     setNewName]     = useState('')
  const [adding,       setAdding]      = useState(false)

  const [editingId,   setEditingId]   = useState<string | null>(null)
  const [editName,    setEditName]    = useState('')
  const [savingEdit,  setSavingEdit]  = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<ShowroomCategory | null>(null)
  const [deleteBusy,   setDeleteBusy]   = useState(false)
  const [deleteError,  setDeleteError]  = useState('')

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { viewAsUserId, viewAsProfile } = useViewAs()
  // Adding, renaming or deleting a category changes the Product Master sidebar
  // entries — without this the badges stay stale until the query goes cold.
  const refreshNavCounts = useRefreshShowroomProductCounts()

  const loadData = async (token: string) => {
    const [catRes, prodRes] = await Promise.all([
      fetch('/api/showroom/admin/categories?all=1', { headers: { 'Authorization': `Bearer ${token}` } }),
      fetch('/api/showroom/admin/products', { headers: { 'Authorization': `Bearer ${token}` } }),
    ])
    const catData = await catRes.json()
    const prodData = await prodRes.json()
    if (Array.isArray(catData?.categories)) setCategories(catData.categories as ShowroomCategory[])
    if (Array.isArray(prodData?.products)) setProducts(prodData.products as ShowroomProduct[])
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const [{ data: p }, { data: mod }] = await Promise.all([
        supabase
          .from('users')
          .select('id, full_name, email, phone, role, team, position, is_active, created_at')
          .eq('id', session.user.id)
          .single(),
        supabase
          .from('app_modules')
          .select('visibility_type, allowed_department')
          .eq('module_key', 'showroom_qr')
          .single(),
      ])

      setShowroomMod(mod ?? null)
      const profile = p as UserProfile | null
      const hasAccess = !!profile && (profile.role === 'admin' ||
        canAccessModule(mod?.visibility_type as ModuleVisibilityType | undefined, mod?.allowed_department, profile, teamFallback(profile.team)))
      if (!hasAccess) { router.push('/modules'); return }
      setProfile(profile)

      await loadData(session.access_token)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!profile || !viewAsUserId || !viewAsProfile) return
    const effectiveHasAccess = viewAsProfile.role === 'admin' ||
      canAccessModule(showroomMod?.visibility_type as ModuleVisibilityType | undefined, showroomMod?.allowed_department, viewAsProfile, teamFallback(viewAsProfile.team))
    if (!effectiveHasAccess) router.replace('/modules')
  }, [profile, viewAsUserId, viewAsProfile, showroomMod, router])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const productCount = (name: string) => products.filter(p => p.category === name).length

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!newName.trim()) { setError('Category name is required'); return }

    setAdding(true)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push('/login'); return }

    const res = await fetch('/api/showroom/admin/categories', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim() }),
    })
    const data = await res.json()
    if (!res.ok) {
      setError(data.error ?? 'Failed to add category')
    } else {
      setNewName('')
      setNotice('Category added.')
      refreshNavCounts()
      await loadData(session.access_token)
    }
    setAdding(false)
  }

  const startEdit = (cat: ShowroomCategory) => {
    setEditingId(cat.id)
    setEditName(cat.name)
    setError('')
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditName('')
  }

  const saveEdit = async (cat: ShowroomCategory) => {
    setError('')
    if (!editName.trim()) { setError('Category name is required'); return }

    setSavingEdit(true)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push('/login'); return }

    const res = await fetch(`/api/showroom/admin/categories/${cat.id}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editName.trim() }),
    })
    const data = await res.json()
    if (!res.ok) {
      setError(data.error ?? 'Failed to update category')
      setSavingEdit(false)
      return
    }

    setEditingId(null)
    setEditName('')
    setNotice('Category updated.')
    setSavingEdit(false)
    refreshNavCounts()
    await loadData(session.access_token)
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleteBusy(true)
    setDeleteError('')

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push('/login'); return }

    const res = await fetch(`/api/showroom/admin/categories/${deleteTarget.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${session.access_token}` },
    })
    const data = await res.json()

    if (!res.ok) {
      setDeleteError(data.error ?? 'Failed to delete category')
      setDeleteBusy(false)
      return
    }

    setDeleteTarget(null)
    setDeleteBusy(false)
    setNotice('Category deleted.')
    refreshNavCounts()
    await loadData(session.access_token)
  }

  if (loading) {
    return (
      <ShowroomAdminLayout
        profile={profile}
        title="Categories"
        subtitle="Manage product categories used in Product Master."
        onSignOut={handleSignOut}
      >
        <CategoriesSkeleton />
      </ShowroomAdminLayout>
    )
  }

  return (
    <ShowroomAdminLayout
      profile={profile}
      title="Categories"
      subtitle="Manage product categories used in Product Master."
      onSignOut={handleSignOut}
    >
      {deleteTarget && (
        <DeleteConfirmModal
          category={deleteTarget}
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => { setDeleteTarget(null); setDeleteError('') }}
          onConfirm={handleDelete}
        />
      )}

      {error && (
        <div style={{ marginBottom: '16px' }}>
          <AlertBanner variant="red">{error}</AlertBanner>
        </div>
      )}
      {notice && (
        <div style={{ marginBottom: '16px' }}>
          <AlertBanner variant="green">{notice}</AlertBanner>
        </div>
      )}

      {/* Add category form */}
      <form
        onSubmit={handleAdd}
        style={{
          display: 'flex', gap: '10px', marginBottom: '24px',
          background: colors.base, border: `1.5px solid ${colors.border}`,
          borderRadius: '10px', padding: '14px 16px', alignItems: 'center',
        }}
      >
        <input
          value={newName}
          onChange={e => setNewName(e.target.value)}
          placeholder="New category name, e.g. Bar Chairs"
          style={inputStyle}
        />
        <button
          type="submit"
          disabled={adding}
          style={{
            display: 'flex', alignItems: 'center', gap: '7px',
            fontSize: '13px', fontWeight: 600,
            color: '#fff', background: '#1A2035',
            border: 'none', borderRadius: '8px',
            padding: '9px 16px', cursor: adding ? 'default' : 'pointer',
            opacity: adding ? 0.7 : 1, whiteSpace: 'nowrap', flexShrink: 0,
          }}
        >
          <PlusCircle size={15} strokeWidth={2} />
          {adding ? 'Adding…' : 'Add Category'}
        </button>
      </form>

      {categories.length === 0 ? (
        <EmptyState
          message="No categories yet"
          hint="Add your first category above."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {categories.map(cat => (
            <div
              key={cat.id}
              style={{
                display: 'flex', alignItems: 'center', gap: '14px',
                background: colors.base,
                border: `1.5px solid ${colors.border}`,
                borderRadius: '10px',
                padding: '12px 16px',
                opacity: cat.is_active ? 1 : 0.6,
              }}
            >
              <div style={{
                width: 32, height: 32, borderRadius: '8px', flexShrink: 0,
                background: colors.raised, border: `1px solid ${colors.border}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Tag size={15} color={colors.muted} strokeWidth={1.5} />
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                {editingId === cat.id ? (
                  <input
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    style={{ ...inputStyle, maxWidth: '320px' }}
                    autoFocus
                  />
                ) : (
                  <span style={{ fontSize: '13.5px', fontWeight: 600, color: colors.primary }}>
                    {cat.name}
                  </span>
                )}
              </div>

              <div style={{
                fontSize: '12px', color: colors.tertiary, whiteSpace: 'nowrap', flexShrink: 0,
                fontFamily: font.mono,
              }}>
                {productCount(cat.name)} product{productCount(cat.name) === 1 ? '' : 's'}
              </div>

              {editingId === cat.id ? (
                <>
                  <button
                    onClick={() => saveEdit(cat)}
                    disabled={savingEdit}
                    title="Save"
                    style={actionBtnStyle('green')}
                  >
                    <Check size={13} strokeWidth={2} />
                    Save
                  </button>
                  <button
                    onClick={cancelEdit}
                    disabled={savingEdit}
                    title="Cancel"
                    style={actionBtnStyle('neutral')}
                  >
                    <X size={13} strokeWidth={2} />
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => startEdit(cat)}
                    title="Edit category"
                    style={actionBtnStyle('neutral')}
                  >
                    <Pencil size={13} strokeWidth={1.8} />
                    Edit
                  </button>
                  <button
                    onClick={() => setDeleteTarget(cat)}
                    title="Delete category"
                    style={actionBtnStyle('red')}
                  >
                    <Trash2 size={13} strokeWidth={1.8} />
                    Delete
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </ShowroomAdminLayout>
  )
}

function CategoriesSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          style={{
            display: 'flex', alignItems: 'center', gap: '14px',
            background: colors.base,
            border: `1.5px solid ${colors.border}`,
            borderRadius: '10px',
            padding: '12px 16px',
          }}
        >
          <div style={{ width: 32, height: 32, borderRadius: '8px', background: colors.raised, flexShrink: 0 }} />
          <div style={{ width: 160, height: 14, borderRadius: '4px', background: colors.raised }} />
        </div>
      ))}
    </div>
  )
}

function actionBtnStyle(variant: 'neutral' | 'red' | 'green'): React.CSSProperties {
  const palette = {
    neutral: { color: colors.secondary, background: colors.float, border: colors.border },
    red:     { color: colors.red,       background: colors.redTint, border: 'rgba(217,79,79,0.2)' },
    green:   { color: colors.green,     background: colors.greenTint, border: 'rgba(69,168,112,0.2)' },
  }[variant]
  return {
    display: 'flex', alignItems: 'center', gap: '5px',
    fontSize: '12px', fontWeight: 500,
    color: palette.color, background: palette.background,
    border: `1px solid ${palette.border}`,
    borderRadius: '6px', padding: '6px 10px',
    cursor: 'pointer', flexShrink: 0,
  }
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 11px',
  height: '36px',
  fontSize: '13px',
  color: '#111318',
  background: '#fff',
  border: '1.5px solid rgba(0,0,0,0.13)',
  borderRadius: '7px',
  outline: 'none',
  boxSizing: 'border-box',
  fontFamily: 'var(--font-body, DM Sans, sans-serif)',
}

// ── Delete Confirm Modal ──────────────────────────────────────────────────────

function DeleteConfirmModal({
  category, busy, error, onCancel, onConfirm,
}: {
  category: ShowroomCategory
  busy: boolean
  error: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '20px',
      }}
    >
      <div style={{ background: '#fff', borderRadius: '14px', width: '100%', maxWidth: 400, padding: '28px 28px 24px', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
          <div style={{ width: 36, height: 36, borderRadius: '9px', background: colors.redTint, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Trash2 size={16} strokeWidth={2.2} color={colors.red} />
          </div>
          <span style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>Delete Category</span>
        </div>
        <p style={{ fontSize: '13.5px', color: colors.secondary, marginBottom: '20px', lineHeight: 1.55 }}>
          Are you sure you want to delete <strong style={{ color: colors.primary }}>{category.name}</strong>?
        </p>
        {error && (
          <div style={{ fontSize: '13px', color: colors.red, background: colors.redTint, padding: '8px 12px', borderRadius: '7px', marginBottom: '14px' }}>{error}</div>
        )}
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} disabled={busy}
            style={{ background: colors.float, color: colors.secondary, border: `1.5px solid ${colors.border}`, borderRadius: '8px', padding: '9px 18px', fontSize: '13.5px', fontWeight: 600, cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={onConfirm} disabled={busy}
            style={{ background: colors.red, color: '#fff', border: 'none', borderRadius: '8px', padding: '9px 18px', fontSize: '13.5px', fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.65 : 1, display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Trash2 size={13} strokeWidth={2.5} />
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
