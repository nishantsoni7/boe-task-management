'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import { AssetModal, AssetField, AssetModalActions, AssetModalError } from './AssetModal'
import { assetErrorMessage, logAssetFailure } from '@/lib/assets/errors'
import { useAssetCatalogue } from '@/hooks/useAssetCatalogue'
import {
  CATEGORY_NAME_MAX,
  PRODUCT_NAME_MAX,
  categoryNameProblem,
  categoryOptions,
  normaliseCatalogueName,
  productNameProblem,
  productsInCategory,
  sortCategories,
  summariseCatalogueUsage,
  type AssetCategory,
  type AssetProduct,
  type CatalogueUsage,
  type CatalogueUsageRow,
} from '@/lib/assets/catalogue'

// Manage Catalogue — add, rename, retire and reactivate asset categories and
// the products within them (20270130000000).
//
// Every write is one RPC. The screen is only shown to someone holding
// canManageCatalogue, but that is a courtesy: the RPCs check the same grant in
// the database, and the tables accept no direct write from anybody.
//
// Kept deliberately short on a phone: one card per category with its products
// listed inside it, one small dialog per add / edit, and nothing to fill in
// beyond a name. Retiring is a switch in the same dialog, never a delete.

type ActivityRow = {
  id: string
  entity_type: string
  event_type: string
  summary: string
  actor_name: string | null
  created_at: string
}

const EMPTY_USAGE: CatalogueUsage = { byCategory: {}, byProduct: {} }

function fmtDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function InactiveBadge() {
  return (
    <span className="boe-badge boe-badge-pending" style={{ fontSize: '10px', whiteSpace: 'nowrap' }}>
      Retired
    </span>
  )
}

export function AssetCatalogueManager({ supabase, isMobile, openAddCategory, onAddCategoryHandled }: {
  supabase: SupabaseClient
  isMobile?: boolean
  /** The header's "Add Category" press, consumed here (see AccessRegister). */
  openAddCategory?: boolean
  onAddCategoryHandled?: () => void
}) {
  const { catalogue, loaded, error: loadError, refresh } = useAssetCatalogue(supabase)
  const [usage, setUsage] = useState<CatalogueUsage>(EMPTY_USAGE)
  // "Used by 0 assets" before the counts arrive would be a false statement,
  // and exactly the one that makes retiring an entry look harmless.
  const [usageLoaded, setUsageLoaded] = useState(false)
  const [activity, setActivity] = useState<ActivityRow[]>([])
  const [showInactive, setShowInactive] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [addingCategory, setAddingCategory] = useState(false)
  const [editingCategory, setEditingCategory] = useState<AssetCategory | null>(null)
  const [addingProductTo, setAddingProductTo] = useState<string | null>(null)
  const [editingProduct, setEditingProduct] = useState<AssetProduct | null>(null)

  const loadSide = useCallback(async () => {
    const [{ data: u, error: uErr }, { data: act, error: aErr }] = await Promise.all([
      supabase.rpc('asset_catalogue_usage'),
      supabase
        .from('asset_catalogue_activity')
        .select('id, entity_type, event_type, summary, actor_name, created_at')
        .order('created_at', { ascending: false })
        .limit(30),
    ])
    if (uErr) { logAssetFailure('manage-catalogue', uErr); setError(assetErrorMessage('manage-catalogue', uErr)) }
    if (aErr) logAssetFailure('manage-catalogue', aErr)
    setUsage(summariseCatalogueUsage((u ?? []) as CatalogueUsageRow[]))
    setUsageLoaded(!uErr)
    setActivity((act ?? []) as ActivityRow[])
  }, [supabase])

  useEffect(() => {
    const onMount = () => { loadSide() }
    onMount()
  }, [loadSide])

  const afterSave = async (message: string) => {
    setNotice(message)
    setError(null)
    await Promise.all([refresh(), loadSide()])
  }

  const categories = useMemo(() => sortCategories(catalogue.categories), [catalogue.categories])
  const visible = showInactive ? categories : categories.filter(c => c.is_active)
  const hiddenCount =
    catalogue.categories.filter(c => !c.is_active).length
    + catalogue.products.filter(p => !p.is_active).length

  const addCategoryOpen = addingCategory || !!openAddCategory
  const closeAddCategory = () => { setAddingCategory(false); onAddCategoryHandled?.() }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {(error || loadError) && <Banner tone="error" message={error ?? loadError ?? ''} />}
      {notice && <Banner tone="success" message={notice} />}

      <div style={{
        display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ fontSize: '12px', color: colors.secondary, maxWidth: '560px', flex: '1 1 260px' }}>
          Categories group assets; products are the models within them. Renaming never breaks an
          existing asset, and retiring an entry only stops it being offered for new ones.
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: colors.secondary, cursor: 'pointer' }}>
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
            Show retired{hiddenCount > 0 ? ` (${hiddenCount})` : ''}
          </label>
          <button
            className="boe-btn boe-btn-primary"
            style={{ padding: '7px 14px', fontSize: '12.5px' }}
            onClick={() => setAddingCategory(true)}
          >
            + Add Category
          </button>
        </div>
      </div>

      {!loaded ? (
        <div style={{ fontSize: '12px', color: colors.muted, padding: '8px 0' }}>Loading…</div>
      ) : visible.length === 0 ? (
        <div className="boe-card" style={{ padding: '28px', textAlign: 'center', fontSize: '12px', color: colors.muted }}>
          {categories.length === 0 ? 'No categories yet. Add the first one.' : 'Every category is retired. Tick "Show retired" to see them.'}
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: '12px',
          alignItems: 'start',
        }}>
          {visible.map(cat => {
            const products = productsInCategory(catalogue.products, cat.key, { includeInactive: showInactive })
            const allProducts = productsInCategory(catalogue.products, cat.key, { includeInactive: true })
            const used = usage.byCategory[cat.key] ?? 0
            return (
              <div key={cat.key} className="boe-card" style={{
                padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px',
                opacity: cat.is_active ? 1 : 0.75,
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, color: colors.primary, fontSize: '14px' }}>{cat.name}</span>
                      {!cat.is_active && <InactiveBadge />}
                    </div>
                    <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '2px' }}>
                      {plural(allProducts.filter(p => p.is_active).length, 'product')}
                      {usageLoaded && ` · used by ${plural(used, 'asset')}`}
                    </div>
                  </div>
                  <button
                    className="boe-btn boe-btn-ghost"
                    style={{ padding: '4px 10px', fontSize: '11.5px', flexShrink: 0 }}
                    onClick={() => setEditingCategory(cat)}
                    aria-label={`Edit category ${cat.name}`}
                  >
                    Edit
                  </button>
                </div>

                {products.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', borderTop: `1px solid ${colors.border}` }}>
                    {products.map(p => (
                      <div key={p.id} style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
                        padding: '7px 0', borderBottom: `1px solid ${colors.border}`,
                      }}>
                        <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '12.5px', color: colors.primary }}>{p.name}</span>
                          {!p.is_active && <InactiveBadge />}
                          <span style={{ fontSize: '11px', color: colors.muted }}>
                            {!usageLoaded ? '' : usage.byProduct[p.id] ? plural(usage.byProduct[p.id], 'asset') : 'unused'}
                          </span>
                        </div>
                        <button
                          className="boe-btn boe-btn-ghost"
                          style={{ padding: '3px 9px', fontSize: '11px', flexShrink: 0 }}
                          onClick={() => setEditingProduct(p)}
                          aria-label={`Edit product ${p.name}`}
                        >
                          Edit
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {cat.is_active && (
                  <button
                    className="boe-btn boe-btn-ghost"
                    style={{ padding: '5px 10px', fontSize: '11.5px', alignSelf: 'flex-start' }}
                    onClick={() => setAddingProductTo(cat.key)}
                  >
                    + Add product
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Who changed what, and when — asset_catalogue_activity, newest first. */}
      <div className="boe-card" style={{ padding: '12px 16px' }}>
        <button
          onClick={() => setShowHistory(v => !v)}
          aria-expanded={showHistory}
          style={{
            background: 'none', border: 'none', padding: 0, cursor: 'pointer', width: '100%',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            fontSize: '11.5px', fontWeight: 700, color: colors.muted,
            textTransform: 'uppercase', letterSpacing: '0.05em',
          }}
        >
          <span>Recent catalogue changes</span>
          <span>{showHistory ? 'Hide' : 'Show'}</span>
        </button>
        {showHistory && (
          activity.length === 0 ? (
            <div style={{ fontSize: '12px', color: colors.muted, paddingTop: '10px' }}>
              No changes yet. The six original categories were carried over from the fixed list.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '10px' }}>
              {activity.map(a => (
                <div key={a.id} style={{ fontSize: '12px', color: colors.secondary }}>
                  <div style={{ color: colors.primary }}>{a.summary}</div>
                  <div style={{ fontSize: '11px', color: colors.muted }}>
                    {a.actor_name ?? 'Unknown user'} · {fmtDateTime(a.created_at)}
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>

      {addCategoryOpen && (
        <CategoryModal
          supabase={supabase}
          categories={catalogue.categories}
          onClose={closeAddCategory}
          onSaved={(c) => { closeAddCategory(); afterSave(`Category "${c.name}" added. Add its products below.`) }}
        />
      )}
      {editingCategory && (
        <CategoryModal
          supabase={supabase}
          category={editingCategory}
          categories={catalogue.categories}
          products={productsInCategory(catalogue.products, editingCategory.key, { includeInactive: true })}
          usedBy={usage.byCategory[editingCategory.key] ?? 0}
          productUsage={usage.byProduct}
          onClose={() => setEditingCategory(null)}
          onSaved={(c) => { setEditingCategory(null); afterSave(`Category "${c.name}" saved.`) }}
        />
      )}
      {(addingProductTo || editingProduct) && (
        <ProductModal
          supabase={supabase}
          product={editingProduct}
          defaultCategoryKey={addingProductTo ?? editingProduct?.category_key ?? ''}
          catalogueCategories={catalogue.categories}
          catalogueProducts={catalogue.products}
          usedBy={editingProduct ? (usage.byProduct[editingProduct.id] ?? 0) : 0}
          onClose={() => { setAddingProductTo(null); setEditingProduct(null) }}
          onSaved={(p) => {
            setAddingProductTo(null); setEditingProduct(null)
            afterSave(editingProduct ? `Product "${p.name}" saved.` : `Product "${p.name}" added.`)
          }}
        />
      )}
    </div>
  )
}

function Banner({ tone, message }: { tone: 'error' | 'success'; message: string }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} style={{
      padding: '10px 12px', borderRadius: '8px', fontSize: '12px',
      background: tone === 'error' ? 'rgba(217,79,79,0.1)' : 'rgba(22,163,74,0.10)',
      color: tone === 'error' ? '#C13030' : '#15803D',
    }}>
      {message}
    </div>
  )
}

/** A name field that says what is wrong while the reader is still typing. */
function NameField({ label, value, onChange, problem, max, autoFocus }: {
  label: string
  value: string
  onChange: (v: string) => void
  problem: string | null
  max: number
  autoFocus?: boolean
}) {
  // Only once the reader has typed: a dialog that opens already saying
  // "Enter a name" is scolding someone for not having started.
  const [touched, setTouched] = useState(false)
  const show = touched && problem
  const inputRef = useRef<HTMLInputElement>(null)
  // AssetModal focuses its own dialog on mount (for the focus trap), which
  // would take focus straight back from a plain autoFocus. Focus after it.
  useEffect(() => {
    if (!autoFocus) return
    const t = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [autoFocus])
  return (
    <AssetField label={label}>
      <input
        ref={inputRef}
        className="boe-input"
        value={value}
        onChange={e => { setTouched(true); onChange(e.target.value) }}
        maxLength={max + 10}
        aria-invalid={!!show}
        style={{ width: '100%', borderColor: show ? '#C13030' : undefined }}
      />
      {show && <div style={{ fontSize: '11.5px', color: '#C13030' }}>{problem}</div>}
    </AssetField>
  )
}

function ActiveSwitch({ checked, onChange, kind, usedBy }: {
  checked: boolean
  onChange: (v: boolean) => void
  kind: 'category' | 'product'
  usedBy: number
}) {
  return (
    <AssetField label="Status">
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: colors.primary, cursor: 'pointer' }}>
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
        Offer this {kind} for new assets
      </label>
      {!checked && (
        <div style={{ fontSize: '11.5px', color: colors.muted }}>
          Retired. It stays readable on {usedBy > 0 ? `the ${plural(usedBy, 'asset')} that use it` : 'any record that names it'},
          and can be reactivated here at any time.
        </div>
      )}
    </AssetField>
  )
}

function CategoryModal({
  supabase, category, categories, products = [], usedBy = 0, productUsage = {}, onClose, onSaved,
}: {
  supabase: SupabaseClient
  /** Absent when adding. */
  category?: AssetCategory
  categories: readonly AssetCategory[]
  products?: readonly AssetProduct[]
  usedBy?: number
  productUsage?: Record<string, number>
  onClose: () => void
  onSaved: (c: AssetCategory) => void
}) {
  const [name, setName] = useState(category?.name ?? '')
  const [active, setActive] = useState(category?.is_active ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const problem = categoryNameProblem(categories, name, category?.key ?? null)
  const unchanged = !!category && normaliseCatalogueName(name) === category.name && active === category.is_active

  const handleSave = async () => {
    if (problem) { setError(problem); return }
    if (saving) return
    setSaving(true)
    setError(null)
    const { data, error: rpcError } = category
      ? await supabase.rpc('update_asset_category', { p_key: category.key, p_name: name, p_is_active: active })
      : await supabase.rpc('create_asset_category', { p_name: name })
    setSaving(false)
    if (rpcError) { logAssetFailure('manage-catalogue', rpcError); setError(assetErrorMessage('manage-catalogue', rpcError)); return }
    onSaved(data as AssetCategory)
  }

  return (
    <AssetModal title={category ? 'Edit Category' : 'Add Category'} onClose={onClose}>
      <NameField
        label="Category name"
        value={name}
        onChange={setName}
        problem={problem}
        max={CATEGORY_NAME_MAX}
        autoFocus
      />
      {category && (
        <>
          <ActiveSwitch checked={active} onChange={setActive} kind="category" usedBy={usedBy} />
          <AssetField label={`Products in this category (${products.length})`}>
            {products.length === 0 ? (
              <div style={{ fontSize: '12px', color: colors.muted }}>None yet. Add products from the category card.</div>
            ) : (
              <div style={{
                display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '160px', overflowY: 'auto',
                background: colors.raised, borderRadius: '8px', padding: '8px 10px',
              }}>
                {products.map(p => (
                  <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '12px' }}>
                    <span style={{ color: p.is_active ? colors.primary : colors.muted }}>
                      {p.name}{p.is_active ? '' : ' (retired)'}
                    </span>
                    <span style={{ color: colors.muted, whiteSpace: 'nowrap' }}>{plural(productUsage[p.id] ?? 0, 'asset')}</span>
                  </div>
                ))}
              </div>
            )}
          </AssetField>
          <div style={{ fontSize: '11.5px', color: colors.muted }}>
            Used by {plural(usedBy, 'asset')}. A new name shows on all of them at once.
          </div>
        </>
      )}
      {error && <AssetModalError message={error} />}
      <AssetModalActions
        onClose={onClose}
        onSave={handleSave}
        saving={saving}
        saveLabel={category ? 'Save Category' : 'Add Category'}
        disabled={!!problem || unchanged}
      />
    </AssetModal>
  )
}

function ProductModal({
  supabase, product, defaultCategoryKey, catalogueCategories, catalogueProducts, usedBy, onClose, onSaved,
}: {
  supabase: SupabaseClient
  /** Null when adding. */
  product: AssetProduct | null
  defaultCategoryKey: string
  catalogueCategories: readonly AssetCategory[]
  catalogueProducts: readonly AssetProduct[]
  usedBy: number
  onClose: () => void
  onSaved: (p: AssetProduct) => void
}) {
  const [categoryKey, setCategoryKey] = useState(product?.category_key ?? defaultCategoryKey)
  const [name, setName] = useState(product?.name ?? '')
  const [active, setActive] = useState(product?.is_active ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const problem = productNameProblem(
    { categories: [...catalogueCategories], products: [...catalogueProducts] },
    categoryKey, name, product?.id ?? null,
  )
  // Moving a product that assets already name would re-categorise them, so the
  // category is fixed once it is in use. The RPC refuses it as well.
  const categoryLocked = !!product && usedBy > 0
  const options = categoryOptions(catalogueCategories, product?.category_key ?? defaultCategoryKey)
  const unchanged = !!product
    && normaliseCatalogueName(name) === product.name
    && active === product.is_active
    && categoryKey === product.category_key

  const handleSave = async () => {
    if (problem) { setError(problem); return }
    if (saving) return
    setSaving(true)
    setError(null)
    const { data, error: rpcError } = product
      ? await supabase.rpc('update_asset_product', {
          p_id: product.id, p_category_key: categoryKey, p_name: name, p_is_active: active,
        })
      : await supabase.rpc('create_asset_product', { p_category_key: categoryKey, p_name: name })
    setSaving(false)
    if (rpcError) { logAssetFailure('manage-catalogue', rpcError); setError(assetErrorMessage('manage-catalogue', rpcError)); return }
    onSaved(data as AssetProduct)
  }

  return (
    <AssetModal title={product ? 'Edit Product' : 'Add Product'} onClose={onClose}>
      <AssetField
        label="Category"
        hint={categoryLocked ? `Used by ${plural(usedBy, 'asset')}, so it stays in this category.` : undefined}
      >
        <select
          className="boe-input"
          value={categoryKey}
          onChange={e => setCategoryKey(e.target.value)}
          disabled={categoryLocked}
          style={{ width: '100%' }}
        >
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </AssetField>
      <NameField
        label="Product name"
        value={name}
        onChange={setName}
        problem={problem}
        max={PRODUCT_NAME_MAX}
        autoFocus
      />
      <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '-6px' }}>
        A model or type, e.g. &ldquo;Dell Latitude 5420&rdquo;. Individual items and their serial numbers are added as assets.
      </div>
      {product && <ActiveSwitch checked={active} onChange={setActive} kind="product" usedBy={usedBy} />}
      {error && <AssetModalError message={error} />}
      <AssetModalActions
        onClose={onClose}
        onSave={handleSave}
        saving={saving}
        saveLabel={product ? 'Save Product' : 'Add Product'}
        disabled={!!problem || unchanged}
      />
    </AssetModal>
  )
}
