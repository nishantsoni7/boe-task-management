'use client'

// ── Typing one product's fabric, packing or approvals ────────────────────────
//
// Opens under the product's row in the F&P Cost or Approvals tab, one product
// at a time (owner, 2026-10-30): a wall of always-open boxes is what made the
// old sheet hard to read. Grey values are the workbook's; a typed value wins
// and the workbook's stays visible as the field's placeholder. Every write goes
// through order_submission_fabric_finish_save_typed, which re-derives who may.

import { useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ORDER_FILES_BUCKET } from '@/lib/orders/draftsView'
import {
  effectiveFinish,
  finishHeadingKey,
  parseTypedFigure,
  typedPayload,
  type FabricFinishLine,
  type FinishEntry,
} from '@/lib/orders/fabricFinishCost'

const PICTURE_URL_TTL_SECONDS = 3600

type Draft = { metres: string; price: string; packing: string; type: string; finish: FinishEntry[] }

const numText = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n))

function draftOf(line: FabricFinishLine): Draft {
  return {
    metres: numText(line.typed?.fabricMetresPerPiece),
    price: numText(line.typed?.fabricPricePerMetre),
    packing: numText(line.typed?.packingCostPerPiece),
    type: line.typed?.packingType ?? '',
    finish: (line.typed?.finish ?? []).map(f => ({ ...f })),
  }
}

function describeError(message: string): string {
  if (/FABRIC_FINISH_FORBIDDEN/.test(message)) return 'You do not have access to change this sheet.'
  if (/FABRIC_FINISH_LINE_NOT_ON_PI/.test(message)) return 'This product is no longer on the PI. Reload the page.'
  if (/FABRIC_FINISH_VALUE_INVALID/.test(message)) return 'Figures must be numbers of at least 0, with at most three decimals for metres and two for rupees.'
  if (/FABRIC_FINISH_IMAGE_INVALID/.test(message)) return 'A picture could not be attached. Add it again.'
  if (/FABRIC_FINISH_FINISH_INVALID/.test(message)) return 'A finish entry is too long or malformed.'
  return 'That could not be saved. Please try again.'
}

export function FabricFinishLineEditor({ submissionId, line, part, headings, pictureUrls, onSaved, onCancel }: {
  submissionId: string
  line: FabricFinishLine
  part: 'cost' | 'approvals'
  /** Every heading this PI uses, so a blank cell can be filled in too. */
  headings: readonly string[]
  /** Signed links for the pictures already stored, by path. */
  pictureUrls: Readonly<Record<string, string>>
  onSaved: () => void
  onCancel: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [draft, setDraft] = useState<Draft>(() => draftOf(line))
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [addedUrls, setAddedUrls] = useState<Record<string, string>>({})
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({})

  const name = line.productName ?? line.itemSequence
  const update = (patch: Partial<Draft>) => { setProblem(null); setDraft(d => ({ ...d, ...patch })) }

  const finishFor = (heading: string) => draft.finish.find(f => finishHeadingKey(f.heading) === finishHeadingKey(heading))
  const sheetFor = (heading: string) => line.sheet?.finish.find(f => finishHeadingKey(f.heading) === finishHeadingKey(heading))

  const setFinishValue = (heading: string, value: string) => {
    const existing = finishFor(heading)
    update({ finish: existing
      ? draft.finish.map(f => (f === existing ? { ...f, value } : f))
      : [...draft.finish, { heading, value, imagePath: null, imageSha256: null }] })
  }

  const setFinishImage = (heading: string, imagePath: string, imageSha256: string) => {
    const existing = finishFor(heading)
    const sheet = sheetFor(heading)
    update({ finish: existing
      ? draft.finish.map(f => (f === existing ? { ...f, imagePath, imageSha256 } : f))
      : [...draft.finish, { heading, value: sheet?.value ?? '', imagePath, imageSha256 }] })
  }

  const uploadImage = async (heading: string, file: File) => {
    setBusy(true); setProblem(null)
    try {
      const form = new FormData()
      form.set('submissionId', submissionId)
      form.set('itemSequence', line.itemSequence)
      form.set('file', file)
      const res = await fetch('/api/orders/fabric-finish/image', { method: 'POST', body: form })
      const body = (await res.json().catch(() => null)) as { storage_path?: string; sha256?: string; message?: string } | null
      if (!res.ok || !body?.storage_path || !body.sha256) {
        setProblem(body?.message ?? 'The picture could not be stored. Please try again.')
        return
      }
      setFinishImage(heading, body.storage_path, body.sha256)
      const signed = await supabase.storage.from(ORDER_FILES_BUCKET).createSignedUrls([body.storage_path], PICTURE_URL_TTL_SECONDS)
      const url = signed.data?.[0]?.signedUrl
      if (url) setAddedUrls(u => ({ ...u, [body.storage_path as string]: url }))
    } catch {
      setProblem('Could not reach the server. The picture was not added.')
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setBusy(true); setProblem(null)
    try {
      const payload = typedPayload({
        fabricMetresPerPiece: draft.metres,
        fabricPricePerMetre: draft.price,
        packingCostPerPiece: draft.packing,
        packingType: draft.type,
        finish: draft.finish,
      })
      if (!payload.ok) { setProblem(payload.problem); return }
      const { error } = await supabase.rpc('order_submission_fabric_finish_save_typed', {
        p_submission_id: submissionId, p_item_sequence: line.itemSequence, p_values: payload.values,
      })
      if (error) { setProblem(describeError(error.message)); return }
      onSaved()
    } finally {
      setBusy(false)
    }
  }

  const figure = (label: string, key: 'metres' | 'price' | 'packing', sheetValue: number | null | undefined) => (
    <label className="pv-field">
      <span className="pv-field-label">{label}</span>
      <input
        className={`boe-input${Number.isNaN(parseTypedFigure(draft[key]) as number) ? ' pv-input-bad' : ''}`}
        inputMode="decimal"
        aria-label={`${label}, ${name}`}
        value={draft[key]}
        placeholder={sheetValue === null || sheetValue === undefined ? 'Type' : String(sheetValue)}
        disabled={busy}
        onChange={e => update({ [key]: e.target.value })}
      />
    </label>
  )

  const approval = (heading: string) => {
    const current = effectiveFinish(line).find(f => finishHeadingKey(f.entry.heading) === finishHeadingKey(heading))
    const typed = finishFor(heading)
    const imagePath = typed?.imagePath ?? current?.entry.imagePath ?? null
    const url = imagePath ? addedUrls[imagePath] ?? pictureUrls[imagePath] : undefined
    const inputKey = finishHeadingKey(heading)
    return (
      <div key={heading} className="pv-field">
        <label className="pv-field-label" htmlFor={`pv-${line.itemSequence}-${inputKey}`}>{heading}</label>
        <input
          id={`pv-${line.itemSequence}-${inputKey}`}
          className="boe-input"
          aria-label={`${heading}, ${name}`}
          value={typed?.value ?? ''}
          placeholder={sheetFor(heading)?.value || 'Type'}
          disabled={busy}
          onChange={e => setFinishValue(heading, e.target.value)}
        />
        <div className="pv-field-picture">
          {url && (
            // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link
            <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={`${heading} reference`} className="pv-swatch" /></a>
          )}
          <input
            ref={el => { fileInputs.current[inputKey] = el }}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadImage(heading, f) }}
          />
          <button type="button" className="pv-link" disabled={busy} onClick={() => fileInputs.current[inputKey]?.click()}>
            {imagePath ? 'Change picture' : 'Add picture'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="pv-editor">
      <p className="pv-editor-note">Grey values come from the workbook. Anything you type here takes priority.</p>
      {part === 'cost' ? (
        <div className="pv-editor-grid">
          {figure('Fabric metres / piece', 'metres', line.sheet?.fabricMetresPerPiece)}
          {figure('₹ / metre', 'price', line.sheet?.fabricPricePerMetre)}
          {figure('Packing ₹ / piece', 'packing', line.sheet?.packingCostPerPiece)}
          <label className="pv-field">
            <span className="pv-field-label">Packing type</span>
            <input
              className="boe-input"
              aria-label={`Packing type, ${name}`}
              value={draft.type}
              placeholder={line.sheet?.packingType ?? 'Type'}
              disabled={busy}
              onChange={e => update({ type: e.target.value })}
            />
          </label>
        </div>
      ) : (
        <div className="pv-editor-grid">{headings.map(approval)}</div>
      )}
      {problem && <p className="pv-problem" role="alert">{problem}</p>}
      <div className="pv-editor-actions">
        <button type="button" className="boe-btn boe-btn-primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="boe-btn boe-btn-ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
