'use client'

import { useEffect, useState, useMemo, useRef, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import type { ShowroomProduct } from '@/lib/types'
import { AlertBanner, EmptyState, LoadingScreen } from '@/components/ui/atoms'
import { ShowroomAdminLayout } from '@/components/layout/ShowroomAdminLayout'
import { colors, font } from '@/lib/tokens'
import { Package, PlusCircle, Pencil, QrCode, X, Printer, Trash2, Download } from 'lucide-react'
import { useViewAs } from '@/hooks/useViewAs'
import { QRCodeSVG, QRCodeCanvas } from 'qrcode.react'
import { canAccessModule, type ModuleVisibilityType } from '@/lib/moduleAccess'
import { useToast, Toast } from '@/components/ui/toast'
import {
  CategoryChips,
  ProductToolbar,
  ProductPagination,
  PRODUCTS_PER_PAGE,
  SORT_OPTIONS,
  STATUS_OPTIONS,
  type CategoryCount,
  type SortValue,
  type StatusValue,
} from '@/components/ui/ProductCatalogControls'
import {
  downloadPlainQrImage,
  productQrFileNameFor,
  QR_EXPORT_MARGIN_MODULES,
  QR_PLAIN_CODE_SIZE,
  type QrImageFormat,
} from '@/lib/qrExport'

type ModVisRow = { visibility_type: string; allowed_department: string[] | null }
const teamFallback = (team?: string | null) =>
  !!team && (team.toLowerCase().includes('sales') || team.toLowerCase().includes('showroom'))

const LIST_PATH = '/showroom-admin/products'
const DEFAULT_SORT: SortValue = 'code_asc'
const SEARCH_DEBOUNCE_MS = 220

const isSort   = (v: string | null): v is SortValue   => SORT_OPTIONS.some(o => o.value === v)
const isStatus = (v: string | null): v is StatusValue => STATUS_OPTIONS.some(o => o.value === v)

// useSearchParams opts the tree into client-side rendering, so the catalog lives
// below a Suspense boundary (same pattern as /tasks/all).
export default function ShowroomProductsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <ShowroomProductsContent />
    </Suspense>
  )
}

function ShowroomProductsContent() {
  const [profile,   setProfile]   = useState<UserProfile | null>(null)
  const [products,  setProducts]  = useState<ShowroomProduct[]>([])
  const [total,         setTotal]         = useState(0)
  const [allCount,      setAllCount]      = useState(0)
  const [catalogTotal,  setCatalogTotal]  = useState(0)
  const [inactiveTotal, setInactiveTotal] = useState(0)
  const [categories,    setCategories]    = useState<CategoryCount[]>([])
  const [loading,   setLoading]   = useState(true)
  const [fetching,  setFetching]  = useState(false)
  const [error,     setError]     = useState('')
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [qrProduct, setQrProduct] = useState<ShowroomProduct | null>(null)
  const [showroomMod, setShowroomMod] = useState<ModVisRow | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ShowroomProduct | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [notice, setNotice] = useState<{ text: string; variant: 'green' | 'amber' } | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const router       = useRouter()
  const searchParams = useSearchParams()
  const supabase     = useMemo(() => createClient(), [])
  const { viewAsUserId, viewAsProfile } = useViewAs()

  const resultsRef = useRef<HTMLDivElement>(null)
  const reqSeq     = useRef(0)

  // ── Catalog state lives in the URL, so refresh, back/forward and returning
  // from the edit page all restore the same view. ──
  const rawSort   = searchParams.get('sort')
  const rawStatus = searchParams.get('status')
  const q        = searchParams.get('q') ?? ''
  const category = searchParams.get('category') ?? ''
  const sort     = isSort(rawSort) ? rawSort : DEFAULT_SORT
  // No `status` param (the clean Product Master URL) means Active — inactive
  // products are opt-in via the dropdown, not shown by default.
  const status   = isStatus(rawStatus) ? rawStatus : 'active'
  const page     = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1)

  const [searchInput, setSearchInput] = useState(q)

  // Keep the input in step when `q` changes from outside typing (back/forward,
  // Clear filters) — adjust during render rather than in an effect.
  const [prevQ, setPrevQ] = useState(q)
  if (q !== prevQ) {
    setPrevQ(q)
    setSearchInput(q)
  }

  const updateParams = useCallback((
    patch: Record<string, string | null>,
    history: 'push' | 'replace' = 'push',
  ) => {
    const next = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') next.delete(key)
      else next.set(key, value)
    }
    const qs = next.toString()
    // scroll:false keeps the viewport where it is; the results panel handles its
    // own scrolling on page change.
    router[history](qs ? `${LIST_PATH}?${qs}` : LIST_PATH, { scroll: false })
  }, [router, searchParams])

  // Debounce typing into `q`, and replace (not push) so each keystroke pause
  // doesn't add a history entry. Clearing to empty (the X button, or
  // backspacing to nothing) skips the debounce — there's nothing left to
  // wait out, so it should feel instant.
  useEffect(() => {
    const trimmed = searchInput.trim()
    if (trimmed === q) return
    if (trimmed === '') {
      updateParams({ q: null, page: null }, 'replace')
      return
    }
    const timer = setTimeout(() => updateParams({ q: trimmed || null, page: null }, 'replace'), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput, q, updateParams])

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
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Redirect when viewing as a user without showroom access
  useEffect(() => {
    if (!profile || !viewAsUserId || !viewAsProfile) return
    const effectiveHasAccess = viewAsProfile.role === 'admin' ||
      canAccessModule(showroomMod?.visibility_type as ModuleVisibilityType | undefined, showroomMod?.allowed_department, viewAsProfile, teamFallback(viewAsProfile.team))
    if (!effectiveHasAccess) router.replace('/modules')
  }, [profile, viewAsUserId, viewAsProfile, showroomMod, router])

  // Category chips, the "All Products" count and the active/inactive split
  // depend only on search + status (never on which category tab, sort order,
  // or page is selected) and change again after a mutation (reload()). So a
  // request that only changes category/sort/page tells the API to skip
  // recomputing that block (`meta=0`) and this component just keeps the
  // values it already has, instead of paying for it on every request.
  const metaKeyRef = useRef<string | null>(null)

  // Fetch the current page whenever the profile is confirmed or any catalog
  // control changes. A sequence guard plus abort means a slow earlier response
  // can never overwrite a newer one.
  useEffect(() => {
    if (!profile) return
    const seq = ++reqSeq.current
    const controller = new AbortController()
    const metaKey = `${q}|${status}|${refreshKey}`
    const skipMeta = metaKeyRef.current === metaKey

    const run = async () => {
      setFetching(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const params = new URLSearchParams({ page: String(page), sort })
      if (q)                   params.set('q', q)
      if (category)            params.set('category', category)
      if (status !== 'active') params.set('status', status)
      if (skipMeta)            params.set('meta', '0')

      try {
        const res = await fetch(`/api/showroom/admin/products?${params.toString()}`, {
          headers: { 'Authorization': `Bearer ${session.access_token}` },
          signal: controller.signal,
        })
        const data = await res.json()
        if (seq !== reqSeq.current) return

        if (!res.ok) {
          setError(data.error ?? 'Failed to load products')
        } else {
          setProducts(Array.isArray(data.products) ? data.products as ShowroomProduct[] : [])
          setTotal(data.total ?? 0)
          // Omitted (meta was skipped) means the previous values still hold —
          // only overwrite when the server actually recomputed this block.
          if (Array.isArray(data.categories)) {
            setAllCount(data.allCount ?? 0)
            setCatalogTotal(data.catalogTotal ?? 0)
            setInactiveTotal(data.inactiveTotal ?? 0)
            setCategories(data.categories as CategoryCount[])
            metaKeyRef.current = metaKey
          }
          setError('')
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        if (seq === reqSeq.current) setError('Failed to load products')
      } finally {
        if (seq === reqSeq.current) {
          setFetching(false)
          setLoading(false)
        }
      }
    }

    run()
    return () => controller.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, q, category, status, sort, page, refreshKey])

  const lastPage = Math.max(1, Math.ceil(total / PRODUCTS_PER_PAGE))

  // A deletion (or a narrower filter) can strand the user past the last page —
  // fall back to the last valid one instead of showing an empty table.
  useEffect(() => {
    if (loading || fetching) return
    if (page > lastPage) updateParams({ page: lastPage > 1 ? String(lastPage) : null }, 'replace')
  }, [page, lastPage, loading, fetching, updateParams])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const reload = () => setRefreshKey(k => k + 1)

  const handleToggleActive = async (product: ShowroomProduct) => {
    setTogglingId(product.id)
    setError('')

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push('/login'); return }

    const res = await fetch(`/api/showroom/admin/products/${product.product_code}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ is_active: !product.is_active }),
    })

    if (!res.ok) {
      const d = await res.json()
      setError(d.error ?? 'Failed to update product')
    } else {
      reload()
    }
    setTogglingId(null)
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleteBusy(true)
    setDeleteError('')

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push('/login'); return }

    const res = await fetch(`/api/showroom/admin/products/${deleteTarget.product_code}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${session.access_token}` },
    })
    const data = await res.json()

    if (!res.ok) {
      setDeleteError(data.error ?? 'Failed to delete product')
      setDeleteBusy(false)
      return
    }

    setDeleteTarget(null)
    setDeleteBusy(false)
    setNotice(data.deactivated
      ? { text: data.message, variant: 'amber' }
      : { text: 'Product deleted.', variant: 'green' })
    reload()
  }

  const goToPage = (next: number) => {
    updateParams({ page: next > 1 ? String(next) : null })
    // Only pull the results back into view when they've scrolled off the top;
    // otherwise leave the viewport untouched.
    const top = resultsRef.current?.getBoundingClientRect().top ?? 0
    if (top < 0) resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const filtersActive = !!q || !!category || status !== 'active' || sort !== DEFAULT_SORT

  if (loading) {
    return (
      <ShowroomAdminLayout profile={profile} title="Product Master" onSignOut={handleSignOut}>
        <TableSkeleton />
      </ShowroomAdminLayout>
    )
  }

  const firstRow = total === 0 ? 0 : (page - 1) * PRODUCTS_PER_PAGE + 1
  const lastRow  = Math.min(page * PRODUCTS_PER_PAGE, total)
  const emptyCatalog = catalogTotal === 0

  return (
    <ShowroomAdminLayout
      profile={profile}
      title="Product Master"
      subtitle={`${catalogTotal - inactiveTotal} active · ${inactiveTotal} inactive`}
      onSignOut={handleSignOut}
    >
      {qrProduct && (
        <QrPrintModal product={qrProduct} onClose={() => setQrProduct(null)} />
      )}
      {deleteTarget && (
        <DeleteConfirmModal
          product={deleteTarget}
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => { setDeleteTarget(null); setDeleteError('') }}
          onConfirm={handleDelete}
        />
      )}
      {/* Header row — title/subtitle already sit above in ShowroomAdminLayout's
          sticky header, so this row is just the primary action, right-aligned.
          Kept tight to the category tabs below it — this row's own height
          already reads as the section break; it doesn't need extra margin too. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: '6px' }}>
        <button
          onClick={() => router.push('/showroom-admin/products/new')}
          className="boe-btn boe-btn-primary"
        >
          <PlusCircle size={15} strokeWidth={2} />
          Add Product
        </button>
      </div>

      {error && (
        <div style={{ marginBottom: '16px' }}>
          <AlertBanner variant="red">{error}</AlertBanner>
        </div>
      )}

      {notice && (
        <div style={{ marginBottom: '16px' }}>
          <AlertBanner variant={notice.variant}>{notice.text}</AlertBanner>
        </div>
      )}

      {emptyCatalog ? (
        <EmptyState
          message="No products yet"
          hint="Click Add Product to add your first showroom product."
        />
      ) : (
        <>
          <CategoryChips
            categories={categories}
            selected={category}
            allCount={allCount}
            disabled={fetching}
            onSelect={next => updateParams({ category: next || null, page: null })}
          />

          <ProductToolbar
            searchInput={searchInput}
            status={status}
            sort={sort}
            filtersActive={filtersActive}
            disabled={fetching}
            onSearchChange={setSearchInput}
            onStatusChange={next => updateParams({ status: next === 'active' ? null : next, page: null })}
            onSortChange={next => updateParams({ sort: next === DEFAULT_SORT ? null : next, page: null })}
            onClear={() => updateParams({ q: null, category: null, status: null, sort: null, page: null })}
          />

          <div ref={resultsRef} style={{ scrollMarginTop: '16px' }}>
            {total === 0 ? (
              <EmptyState
                message="No products match your filters"
                hint="Try a different search term, category or status — or clear the filters."
              />
            ) : (
              <>
                <ProductTable
                  products={products}
                  fetching={fetching}
                  togglingId={togglingId}
                  onEdit={code => router.push(`/showroom-admin/products/${code}/edit`)}
                  onToggle={handleToggleActive}
                  onPrintQr={setQrProduct}
                  onDelete={setDeleteTarget}
                />

                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  flexWrap: 'wrap', gap: '8px', marginTop: '12px',
                }}>
                  <div style={{ fontSize: '12px', color: colors.tertiary }}>
                    Showing {firstRow}–{lastRow} of {total} product{total === 1 ? '' : 's'}
                  </div>
                  <div style={{ fontSize: '12px', color: colors.muted }}>
                    Page {page} of {lastPage}
                  </div>
                </div>

                <ProductPagination
                  page={page}
                  lastPage={lastPage}
                  busy={fetching}
                  onPageChange={goToPage}
                />
              </>
            )}
          </div>
        </>
      )}
    </ShowroomAdminLayout>
  )
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function TableSkeleton() {
  return (
    <div style={{
      background: colors.base,
      border: `1.5px solid ${colors.border}`,
      borderRadius: '10px',
      overflow: 'hidden',
    }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          style={{
            display: 'flex', alignItems: 'center', gap: '16px',
            padding: '10px 16px',
            borderBottom: i < 5 ? `1px solid ${colors.border}` : 'none',
          }}
        >
          <div style={{ width: 56, height: 56, borderRadius: '8px', background: colors.raised, flexShrink: 0 }} />
          <div style={{ width: 90, height: 14, borderRadius: '4px', background: colors.raised }} />
          <div style={{ width: 160, height: 14, borderRadius: '4px', background: colors.raised }} />
          <div style={{ width: 100, height: 14, borderRadius: '4px', background: colors.raised }} />
          <div style={{ width: 70, height: 14, borderRadius: '4px', background: colors.raised, marginLeft: 'auto' }} />
        </div>
      ))}
    </div>
  )
}

// ── Product table ─────────────────────────────────────────────────────────────

function ProductTable({
  products, fetching, togglingId, onEdit, onToggle, onPrintQr, onDelete,
}: {
  products: ShowroomProduct[]
  fetching: boolean
  togglingId: string | null
  onEdit: (code: string) => void
  onToggle: (p: ShowroomProduct) => void
  onPrintQr: (p: ShowroomProduct) => void
  onDelete: (p: ShowroomProduct) => void
}) {
  if (products.length === 0) return null

  return (
    <div>
      {/* The previous rows stay on screen while the next page loads — dimmed and
          inert rather than replaced by a skeleton, so the table never blanks. */}
      <div style={{
        background: colors.base,
        border: `1.5px solid ${colors.border}`,
        borderRadius: '10px',
        overflow: 'hidden',
        opacity: fetching ? 0.55 : 1,
        pointerEvents: fetching ? 'none' : undefined,
        transition: 'opacity 120ms ease',
      }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                {['Image', 'Product Code', 'Product Name', 'Category', 'MRP', 'Status', 'Actions'].map(h => (
                  <th key={h} style={{
                    padding: '8px 16px', textAlign: h === 'MRP' ? 'right' : 'left',
                    fontSize: '10px', fontWeight: 600, color: colors.muted,
                    textTransform: 'uppercase', letterSpacing: '0.05em',
                    whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {products.map(product => (
                <ProductRow
                  key={product.id}
                  product={product}
                  toggling={togglingId === product.id}
                  onEdit={() => onEdit(product.product_code)}
                  onToggle={() => onToggle(product)}
                  onPrintQr={() => onPrintQr(product)}
                  onDelete={() => onDelete(product)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// Thumbnail with a safe fallback: hides the broken-image icon and shows a
// neutral placeholder box if the URL is missing or fails to load.
function ProductThumb({ src, alt }: { src: string | null; alt: string }) {
  const [errored, setErrored] = useState(false)

  const showImage = !!src && !errored

  return (
    <div style={{
      width: 56, height: 56, borderRadius: '8px', flexShrink: 0,
      background: colors.raised,
      border: `1px solid ${colors.border}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden',
    }}>
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          onError={() => setErrored(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <Package size={20} color={colors.muted} strokeWidth={1.5} />
      )}
    </div>
  )
}

function ProductRow({
  product, toggling, onEdit, onToggle, onPrintQr, onDelete,
}: {
  product: ShowroomProduct
  toggling: boolean
  onEdit: () => void
  onToggle: () => void
  onPrintQr: () => void
  onDelete: () => void
}) {
  return (
    <tr style={{
      borderBottom: `1px solid ${colors.border}`,
      opacity: product.is_active ? 1 : 0.6,
    }}>
      {/* Image */}
      <td style={{ padding: '10px 16px', verticalAlign: 'middle' }}>
        <ProductThumb src={product.images?.[0] ?? product.image_url ?? null} alt={product.name} />
      </td>

      {/* Product Code */}
      <td style={{ padding: '10px 16px', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
        <span style={{
          fontSize: '12px', fontWeight: 600,
          color: '#1A2035',
          background: 'rgba(26,32,53,0.06)',
          borderRadius: '5px', padding: '4px 9px',
          whiteSpace: 'nowrap',
        }}>
          {product.product_code}
        </span>
      </td>

      {/* Product Name */}
      <td style={{ padding: '10px 16px', verticalAlign: 'middle', minWidth: '160px' }}>
        <span style={{ fontSize: '13.5px', fontWeight: 600, color: colors.primary }}>
          {product.name}
        </span>
      </td>

      {/* Category */}
      <td style={{ padding: '10px 16px', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
        <span style={{ fontSize: '12px', color: colors.tertiary }}>
          {product.category}
        </span>
      </td>

      {/* MRP */}
      <td style={{ padding: '10px 16px', verticalAlign: 'middle', textAlign: 'right', whiteSpace: 'nowrap' }}>
        <span style={{ fontSize: '13.5px', fontWeight: 600, color: colors.primary, fontFamily: font.body }}>
          ₹{Number(product.mrp).toLocaleString('en-IN')}
        </span>
      </td>

      {/* Status */}
      <td style={{ padding: '10px 16px', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
        <button
          onClick={onToggle}
          disabled={toggling}
          style={{
            fontSize: '11px', fontWeight: 600,
            color: product.is_active ? '#166534' : colors.muted,
            background: product.is_active ? '#F0FDF4' : colors.float,
            border: `1px solid ${product.is_active ? '#BBF7D0' : colors.border}`,
            borderRadius: '999px',
            padding: '4px 12px',
            cursor: toggling ? 'default' : 'pointer',
            opacity: toggling ? 0.6 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {toggling ? '…' : product.is_active ? 'Active' : 'Inactive'}
        </button>
      </td>

      {/* Actions */}
      <td style={{ padding: '10px 16px', verticalAlign: 'middle' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <IconButton onClick={onPrintQr} title="Print QR label" variant="neutral">
            <QrCode size={14} strokeWidth={1.8} />
          </IconButton>
          <IconButton onClick={onEdit} title="Edit product" variant="neutral">
            <Pencil size={14} strokeWidth={1.8} />
          </IconButton>
          <IconButton onClick={onDelete} title="Delete product" variant="red">
            <Trash2 size={14} strokeWidth={1.8} />
          </IconButton>
        </div>
      </td>
    </tr>
  )
}

function IconButton({
  onClick, title, variant, children,
}: {
  onClick: () => void
  title: string
  variant: 'neutral' | 'red'
  children: React.ReactNode
}) {
  const palette = variant === 'red'
    ? { color: colors.red, background: colors.redTint, border: 'rgba(217,79,79,0.2)' }
    : { color: colors.secondary, background: colors.float, border: colors.border }

  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, flexShrink: 0,
        color: palette.color,
        background: palette.background,
        border: `1px solid ${palette.border}`,
        borderRadius: '6px',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

// ── Delete Confirm Modal ──────────────────────────────────────────────────────

function DeleteConfirmModal({
  product, busy, error, onCancel, onConfirm,
}: {
  product: ShowroomProduct
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
          <span style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>Delete Product</span>
        </div>
        <p style={{ fontSize: '13.5px', color: colors.secondary, marginBottom: '20px', lineHeight: 1.55 }}>
          Are you sure you want to delete <strong style={{ color: colors.primary }}>{product.name}</strong> ({product.product_code})?
          This action cannot be undone.
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

// ── QR Print Modal ────────────────────────────────────────────────────────────

const QR_LABEL_BRAND = 'BOE · Showroom'

function QrPrintModal({ product, onClose }: { product: ShowroomProduct; onClose: () => void }) {
  const printRef = useRef<HTMLDivElement>(null)
  const exportCanvasRef = useRef<HTMLCanvasElement>(null)
  const [downloadingFormat, setDownloadingFormat] = useState<QrImageFormat | null>(null)
  const { toast, show: showToast, dismiss: dismissToast } = useToast()
  const qrUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/showroom/product/${product.product_code}`
  const mrpText = `₹${Number(product.mrp).toLocaleString('en-IN')}`

  const handleDownload = async (format: QrImageFormat) => {
    if (downloadingFormat) return
    setDownloadingFormat(format)
    try {
      const source = exportCanvasRef.current
      if (!source) throw new Error('QR export canvas is not mounted')
      await downloadPlainQrImage(source, productQrFileNameFor(product.product_code, format), format)
    } catch (err) {
      console.error(`[showroom-product-qr] ${format.toUpperCase()} download failed`, err)
      showToast('Unable to download the QR image. Please try again.', 'error')
    } finally {
      setDownloadingFormat(null)
    }
  }

  const handlePrint = () => {
    const content = printRef.current
    if (!content) return
    const win = window.open('', '_blank', 'width=400,height=520')
    if (!win) return
    win.document.write(`
      <html><head><title>QR Label – ${product.name}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #fff; }
        .label { text-align: center; padding: 28px 32px; border: 1.5px solid #e5e7eb; border-radius: 12px; display: inline-block; }
        .brand { font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #6b7280; margin-bottom: 4px; }
        .name { font-size: 17px; font-weight: 700; color: #111827; margin: 10px 0 2px; }
        .code { font-size: 11px; font-family: monospace; color: #6b7280; margin-bottom: 2px; }
        .mrp { font-size: 20px; font-weight: 700; color: #111827; margin: 6px 0 16px; }
        svg { display: block; margin: 0 auto; }
      </style></head><body>${content.innerHTML}</body></html>
    `)
    win.document.close()
    win.focus()
    win.print()
    win.close()
  }

  return (
    <>
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '24px',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: '14px',
          padding: '28px 32px',
          width: '100%', maxWidth: '360px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
          position: 'relative',
        }}
      >
        {/* Close */}
        <button
          onClick={onClose}
          style={{
            position: 'absolute', top: '14px', right: '14px',
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: '#9ca3af', padding: '4px',
          }}
        >
          <X size={18} />
        </button>

        {/* Label preview */}
        <div ref={printRef} className="label" style={{ textAlign: 'center' }}>
          <div className="brand" style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#6b7280', marginBottom: '4px' }}>
            {QR_LABEL_BRAND}
          </div>
          <QRCodeSVG value={qrUrl} size={160} style={{ display: 'block', margin: '0 auto' }} />
          <div className="name" style={{ fontSize: '17px', fontWeight: 700, color: '#111827', margin: '12px 0 2px' }}>
            {product.name}
          </div>
          <div className="code" style={{ fontSize: '11px', fontFamily: 'monospace', color: '#6b7280', marginBottom: '2px' }}>
            {product.product_code}
          </div>
          <div className="mrp" style={{ fontSize: '20px', fontWeight: 700, color: '#111827', marginTop: '4px' }}>
            {mrpText}
          </div>
        </div>

        {/* Off-screen high-resolution QR for the image exports. Same qrUrl as the
            preview above, so both always encode an identical destination. The
            transparent bgColor is what lets the PNG export keep real alpha. */}
        <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', top: 0, pointerEvents: 'none' }}>
          <QRCodeCanvas
            ref={exportCanvasRef}
            value={qrUrl}
            size={QR_PLAIN_CODE_SIZE}
            marginSize={QR_EXPORT_MARGIN_MODULES}
            fgColor="#000000"
            bgColor="transparent"
          />
        </div>

        {/* Actions */}
        <div style={{ marginTop: '20px', display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
          {(['jpg', 'png'] as const).map(format => (
            <button
              key={format}
              onClick={() => handleDownload(format)}
              disabled={!!downloadingFormat}
              style={{
                flex: '1 1 120px',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                fontSize: '14px', fontWeight: 600,
                color: '#fff',
                background: '#1A2035',
                border: 'none', borderRadius: '8px',
                padding: '11px 0',
                cursor: downloadingFormat ? 'wait' : 'pointer',
                opacity: downloadingFormat && downloadingFormat !== format ? 0.7 : 1,
              }}
            >
              <Download size={15} strokeWidth={2} />
              {downloadingFormat === format ? 'Downloading…' : `Download ${format.toUpperCase()}`}
            </button>
          ))}

          <button
            onClick={handlePrint}
            style={{
              flex: '1 1 120px',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              fontSize: '14px', fontWeight: 600,
              color: colors.secondary,
              background: colors.raised,
              border: `1.5px solid ${colors.border}`, borderRadius: '8px',
              padding: '11px 0',
              cursor: 'pointer',
            }}
          >
            <Printer size={15} strokeWidth={2} />
            Print QR Label
          </button>
        </div>
      </div>
    </div>
    <Toast toast={toast} onDismiss={dismissToast} />
    </>
  )
}
