'use client'

import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import { AssetModal, AssetField, AssetModalActions, AssetModalError } from './AssetModal'
import { assetErrorMessage, logAssetFailure } from '@/lib/assets/errors'
import {
  ASSET_CATEGORY_OPTIONS,
  ASSET_CONDITION_LABEL,
  ASSET_CONDITION_OPTIONS,
  humanizeToken,
  type Asset,
} from '@/lib/assets/types'
import {
  buildProposedFields,
  validateChangeRequest,
} from '@/lib/assets/changeRequests'
import { notifyAssetEvent } from '@/lib/assets/notifyClient'
import {
  assetEditSummary,
  changedAssetFields,
  editDeservesNotification,
  type AssetEditableValues,
} from '@/lib/assets/assetNotifications'

// Create / edit an asset, and the request-an-admin-to-do-it counterparts.
//
// These live in components/ rather than in either page because BOTH the
// inventory list and the asset detail page offer them. One copy means the
// create form and the edit form can never fall out of step about which fields
// an asset has — which is exactly what happened when asset_code was added to
// one query and not the other.

const inputStyle = { width: '100%' } as const

function CategorySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  // An asset whose stored category is not in the standard list still shows its
  // own value rather than silently snapping to "laptop_desktop" on save.
  const options = ASSET_CATEGORY_OPTIONS.includes(value) || value === ''
    ? ASSET_CATEGORY_OPTIONS
    : [value, ...ASSET_CATEGORY_OPTIONS]
  return (
    <select className="boe-input" value={value} onChange={e => onChange(e.target.value)} style={inputStyle}>
      {options.map(t => <option key={t} value={t}>{humanizeToken(t)}</option>)}
    </select>
  )
}

function ConditionSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select className="boe-input" value={value} onChange={e => onChange(e.target.value)} style={inputStyle}>
      <option value="">Not recorded</option>
      {ASSET_CONDITION_OPTIONS.map(c => <option key={c} value={c}>{ASSET_CONDITION_LABEL[c]}</option>)}
    </select>
  )
}

type AssetFormState = {
  assetType: string
  assetName: string
  serialNo: string
  specifications: string
  brand: string
  model: string
  description: string
  condition: string
  location: string
}

function useAssetForm(initial: Partial<AssetFormState>) {
  const [form, setForm] = useState<AssetFormState>({
    assetType:      initial.assetType      ?? ASSET_CATEGORY_OPTIONS[0],
    assetName:      initial.assetName      ?? '',
    serialNo:       initial.serialNo       ?? '',
    specifications: initial.specifications ?? '',
    brand:          initial.brand          ?? '',
    model:          initial.model          ?? '',
    description:    initial.description    ?? '',
    condition:      initial.condition      ?? '',
    location:       initial.location       ?? '',
  })
  const set = <K extends keyof AssetFormState>(key: K) => (value: AssetFormState[K]) =>
    setForm(prev => ({ ...prev, [key]: value }))
  return { form, set }
}

function AssetFormFields({
  form, set, showLocation = true,
}: {
  form: AssetFormState
  set: <K extends keyof AssetFormState>(key: K) => (value: AssetFormState[K]) => void
  showLocation?: boolean
}) {
  return (
    <>
      <AssetField label="Category">
        <CategorySelect value={form.assetType} onChange={set('assetType')} />
      </AssetField>
      <AssetField label="Asset Name">
        <input className="boe-input" value={form.assetName} onChange={e => set('assetName')(e.target.value)} placeholder="e.g. Dell XPS 15" style={inputStyle} />
      </AssetField>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <AssetField label="Brand">
          <input className="boe-input" value={form.brand} onChange={e => set('brand')(e.target.value)} style={inputStyle} />
        </AssetField>
        <AssetField label="Model">
          <input className="boe-input" value={form.model} onChange={e => set('model')(e.target.value)} style={inputStyle} />
        </AssetField>
      </div>
      <AssetField label="Serial No.">
        <input className="boe-input" value={form.serialNo} onChange={e => set('serialNo')(e.target.value)} placeholder="Optional" style={inputStyle} />
      </AssetField>
      <AssetField label="Condition">
        <ConditionSelect value={form.condition} onChange={set('condition')} />
      </AssetField>
      {showLocation && (
        <AssetField label="Location" hint="Where it sits when nobody holds it. Transfers change this later.">
          <input className="boe-input" value={form.location} onChange={e => set('location')(e.target.value)} style={inputStyle} />
        </AssetField>
      )}
      <AssetField label="Description">
        <textarea className="boe-input" value={form.description} onChange={e => set('description')(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
      </AssetField>
      <AssetField label="Specifications / Details">
        <textarea
          className="boe-input"
          value={form.specifications}
          onChange={e => set('specifications')(e.target.value)}
          placeholder="Example: Intel i5, 8GB RAM, 512GB SSD, Windows 11"
          rows={3}
          style={{ ...inputStyle, resize: 'vertical' }}
        />
      </AssetField>
    </>
  )
}

// ─── Create ───────────────────────────────────────────────────────────────────

export function CreateAssetModal({
  supabase, onClose, onSaved,
}: { supabase: SupabaseClient; onClose: () => void; onSaved: () => void }) {
  const { form, set } = useAssetForm({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    if (!form.assetName.trim()) { setError('Asset Name is required.'); return }
    if (saving) return
    setSaving(true)
    setError(null)
    // asset_code is deliberately NOT sent: it is issued by the database
    // (20260726000000) and any value a client supplied would be discarded.
    const { error: dbError } = await supabase.from('assets').insert({
      asset_type:     form.assetType,
      asset_name:     form.assetName.trim(),
      serial_no:      form.serialNo.trim() || null,
      specifications: form.specifications.trim() || null,
      brand:          form.brand.trim() || null,
      model:          form.model.trim() || null,
      description:    form.description.trim() || null,
      condition:      form.condition || null,
      location:       form.location.trim() || null,
    })
    setSaving(false)
    // A failed create keeps the modal open with every entered value intact —
    // the reader gets one sentence, the console gets the driver error.
    if (dbError) { logAssetFailure('create', dbError); setError(assetErrorMessage('create', dbError)); return }
    onSaved()
  }

  return (
    <AssetModal title="Create Asset" onClose={onClose} width={520}>
      <AssetFormFields form={form} set={set} />
      {error && <AssetModalError message={error} />}
      <AssetModalActions onClose={onClose} onSave={handleSave} saving={saving} saveLabel="Create Asset" />
    </AssetModal>
  )
}

// ─── Edit ─────────────────────────────────────────────────────────────────────

/** The form's values as the DATABASE names them — the shape the rules use. */
function formAsAssetValues(form: AssetFormState): AssetEditableValues {
  return {
    asset_type:     form.assetType,
    asset_name:     form.assetName.trim(),
    serial_no:      form.serialNo.trim() || null,
    specifications: form.specifications.trim() || null,
    brand:          form.brand.trim() || null,
    model:          form.model.trim() || null,
    description:    form.description.trim() || null,
    condition:      form.condition || null,
    location:       form.location.trim() || null,
  }
}

export function EditAssetModal({
  asset, supabase, currentEmployeeId, onClose, onSaved,
}: {
  asset: Asset
  supabase: SupabaseClient
  /** The custodian to notify, when the edit is one worth notifying about. */
  currentEmployeeId?: string | null
  onClose: () => void
  onSaved: () => void
}) {
  const { form, set } = useAssetForm({
    assetType:      asset.asset_type,
    assetName:      asset.asset_name,
    serialNo:       asset.serial_no ?? '',
    specifications: asset.specifications ?? '',
    brand:          asset.brand ?? '',
    model:          asset.model ?? '',
    description:    asset.description ?? '',
    condition:      asset.condition ?? '',
    location:       asset.location ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    if (!form.assetName.trim()) { setError('Asset Name is required.'); return }
    if (saving) return
    setSaving(true)
    setError(null)
    const { error: dbError } = await supabase
      .from('assets')
      .update({
        asset_type:     form.assetType,
        asset_name:     form.assetName.trim(),
        serial_no:      form.serialNo.trim() || null,
        specifications: form.specifications.trim() || null,
        brand:          form.brand.trim() || null,
        model:          form.model.trim() || null,
        description:    form.description.trim() || null,
        condition:      form.condition || null,
        location:       form.location.trim() || null,
      })
      .eq('id', asset.id)
    setSaving(false)
    if (dbError) { logAssetFailure('edit', dbError); setError(assetErrorMessage('edit', dbError)); return }

    // THE METADATA RULE, finally at a call site. editDeservesNotification has
    // existed and been tested since the module shipped but was never called, so
    // every direct edit was silent — including one that moved an asset's
    // condition or location out from under the person holding it. A corrected
    // serial number or a reworded description still says nothing.
    const changed = changedAssetFields(asset, formAsAssetValues(form))
    if (editDeservesNotification(changed)) {
      notifyAssetEvent({
        event: 'asset_edited',
        assetId: asset.id,
        assetName: asset.asset_name,
        assetCode: asset.asset_code,
        toEmployeeId: currentEmployeeId ?? null,
        note: assetEditSummary(changed),
      })
    }
    onSaved()
  }

  return (
    <AssetModal title="Edit Asset" onClose={onClose} width={520}>
      <AssetFormFields form={form} set={set} />
      {error && <AssetModalError message={error} />}
      <AssetModalActions onClose={onClose} onSave={handleSave} saving={saving} saveLabel="Save Changes" />
    </AssetModal>
  )
}

// ─── Request Edit ─────────────────────────────────────────────────────────────
// Never writes to assets. It files a row in asset_change_requests and stops —
// only an admin approving it can move the asset.

export function RequestEditModal({
  asset, supabase, onClose, onSubmitted,
}: { asset: Asset; supabase: SupabaseClient; onClose: () => void; onSubmitted: () => void }) {
  const [assetType, setAssetType] = useState(asset.asset_type)
  const [assetName, setAssetName] = useState(asset.asset_name)
  const [serialNo, setSerialNo] = useState(asset.serial_no ?? '')
  const [specifications, setSpecifications] = useState(asset.specifications ?? '')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    const proposed = buildProposedFields(
      { asset_type: asset.asset_type, asset_name: asset.asset_name, serial_no: asset.serial_no, specifications: asset.specifications },
      { asset_type: assetType, asset_name: assetName, serial_no: serialNo, specifications },
    )
    const invalid = validateChangeRequest({ type: 'edit', reason, proposed })
    if (invalid) { setError(invalid); return }
    if (saving) return

    setSaving(true)
    setError(null)
    // requested_by is defaulted from auth.uid() by the table and pinned by the
    // insert policy — the client never sends it.
    const { error: dbError } = await supabase.from('asset_change_requests').insert({
      asset_id: asset.id,
      asset_name_snapshot: asset.asset_name,
      request_type: 'edit',
      reason: reason.trim(),
      ...proposed,
    })
    setSaving(false)
    if (dbError) { logAssetFailure('request-edit', dbError); setError(assetErrorMessage('request-edit', dbError)); return }
    // Reviewers are resolved server-side; the requester is never notified about
    // their own request (the API drops the actor from every recipient set).
    notifyAssetEvent({
      event: 'asset_edit_request_submitted',
      assetId: asset.id,
      assetName: asset.asset_name,
      assetCode: asset.asset_code,
      requestType: 'edit',
    })
    onSubmitted()
  }

  return (
    <AssetModal title="Request Edit" onClose={onClose}>
      <div style={{ fontSize: '11.5px', color: colors.muted }}>
        An administrator reviews this request before anything changes. Only the four fields below
        can be proposed this way.
      </div>
      <AssetField label="Category">
        <CategorySelect value={assetType} onChange={setAssetType} />
      </AssetField>
      <AssetField label="Asset Name">
        <input className="boe-input" value={assetName} onChange={e => setAssetName(e.target.value)} style={inputStyle} />
      </AssetField>
      <AssetField label="Serial No.">
        <input className="boe-input" value={serialNo} onChange={e => setSerialNo(e.target.value)} style={inputStyle} />
      </AssetField>
      <AssetField label="Specifications / Details">
        <textarea className="boe-input" value={specifications} onChange={e => setSpecifications(e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
      </AssetField>
      <AssetField label="Reason (required)">
        <textarea
          className="boe-input"
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="Why does this asset need changing?"
          rows={2}
          style={{ ...inputStyle, resize: 'vertical' }}
        />
      </AssetField>
      {error && <AssetModalError message={error} />}
      <AssetModalActions onClose={onClose} onSave={handleSubmit} saving={saving} saveLabel="Submit Request" />
    </AssetModal>
  )
}

// ─── Request Removal ──────────────────────────────────────────────────────────
// Does not delete anything. Whether the asset can eventually go is decided at
// approval time by the custody-history rule, not here.

export function RequestRemovalModal({
  asset, supabase, onClose, onSubmitted,
}: { asset: Asset; supabase: SupabaseClient; onClose: () => void; onSubmitted: () => void }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    const invalid = validateChangeRequest({ type: 'remove', reason })
    if (invalid) { setError(invalid); return }
    if (saving) return

    setSaving(true)
    setError(null)
    const { error: dbError } = await supabase.from('asset_change_requests').insert({
      asset_id: asset.id,
      asset_name_snapshot: asset.asset_name,
      request_type: 'remove',
      reason: reason.trim(),
    })
    setSaving(false)
    if (dbError) { logAssetFailure('request-remove', dbError); setError(assetErrorMessage('request-remove', dbError)); return }
    notifyAssetEvent({
      event: 'asset_request_submitted',
      assetId: asset.id,
      assetName: asset.asset_name,
      assetCode: asset.asset_code,
      requestType: 'remove',
    })
    onSubmitted()
  }

  return (
    <AssetModal title="Request Removal" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: colors.primary }}>{asset.asset_name}</div>
        <div style={{ fontSize: '12px', color: colors.secondary, fontFamily: 'monospace' }}>{asset.serial_no ?? 'No serial number'}</div>
      </div>
      <div style={{
        padding: '10px 12px', borderRadius: '8px',
        background: 'rgba(217,79,79,0.08)', color: '#C13030', fontSize: '11.5px',
      }}>
        This request needs administrator approval. The asset is not removed now, and it cannot be
        removed at all if it has assignment, movement, service or document history.
      </div>
      <AssetField label="Reason (required)">
        <textarea
          className="boe-input"
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="Why should this asset be removed?"
          rows={3}
          style={{ ...inputStyle, resize: 'vertical' }}
        />
      </AssetField>
      {error && <AssetModalError message={error} />}
      <AssetModalActions onClose={onClose} onSave={handleSubmit} saving={saving} saveLabel="Submit Request" />
    </AssetModal>
  )
}
