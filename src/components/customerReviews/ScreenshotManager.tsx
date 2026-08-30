'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ImagePlus, Trash2 } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import {
  MAX_TEST_SCREENSHOTS,
  TEST_SCREENSHOT_ACCEPT,
  TEST_SCREENSHOT_BUCKET,
  TEST_SCREENSHOT_TYPES_LABEL,
  formatPhotoSize,
  validateTestScreenshot,
} from '@/lib/customerReviews/photos'
import type { TestCardPhoto } from '@/lib/customerReviews/types'

// The test screenshot, on a private bucket.
//
// UPLOADING AND REMOVING BOTH GO THROUGH THE SERVER.
//
// POST /api/customer-reviews/photos authenticates the caller, checks the
// permission, reads the bytes, decodes and re-encodes the image, generates the
// object key and writes both the object and its metadata row.
//
// DELETE /api/customer-reviews/photos does the reverse as ONE operation:
// mark, delete the object, delete the row, write the audit entry.
//
// The browser can do neither itself. `authenticated` holds no INSERT or DELETE
// policy on the metadata table and no INSERT or DELETE policy on the bucket, so
// a direct write or a half-removal is refused by the database rather than
// merely discouraged here.
//
// validateTestScreenshot() still runs before the POST. It is a COURTESY — it
// saves a five-megabyte round trip to be told no — and it is not the boundary.
// The route re-checks everything and does not trust a single field this
// component sends.
//
// READING is direct: short-lived signed URLs, minted per render, governed by
// the same SELECT policy that decides who may read the card. There is no public
// URL anywhere in this file.
//
// THERE IS NO DOWNLOAD CONTROL, and its absence is deliberate. An earlier
// version had one, so an employee could save a project photograph and attach it
// by hand in a customer's chat. There are no project photographs here and no
// customer chats; the only image is a screenshot BOE already took, and a
// control offering to save it out of the system would suggest it was meant to
// go somewhere. It is not.

const SIGNED_URL_TTL_SECONDS = 300

export function ScreenshotManager({
  supabase,
  cardId,
  screenshots,
  onChanged,
  /** False once the card is submitted — the evidence must not move underneath a verifier. */
  canAttach,
  canRemove,
  emptyHint,
}: {
  supabase: SupabaseClient
  cardId: string
  screenshots: TestCardPhoto[]
  onChanged: () => void | Promise<void>
  canAttach: boolean
  canRemove: boolean
  emptyHint: string
}) {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const uploading = useRef(false)
  const removing = useRef(false)

  // Signed URLs are minted per render pass and never stored anywhere. They
  // expire on their own, and a viewer who has lost access simply gets no URL —
  // createSignedUrl is governed by the same policy as reading the card.
  useEffect(() => {
    let active = true
    const paths = screenshots.map(s => s.storage_path)
    // Nothing to sign. Previously signed URLs are left in state rather than
    // cleared: they are keyed by object path, so a removed image's entry is
    // never looked up again, and clearing here would be a setState in an effect
    // body for no visible change.
    if (paths.length === 0) return

    supabase.storage
      .from(TEST_SCREENSHOT_BUCKET)
      .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)
      .then(({ data }) => {
        if (!active || !data) return
        const next: Record<string, string> = {}
        data.forEach((entry, index) => {
          if (entry.signedUrl) next[paths[index]] = entry.signedUrl
        })
        setUrls(next)
      })
      .catch(() => { /* a missing preview is not an error worth a banner */ })

    return () => { active = false }
  }, [supabase, screenshots])

  const attach = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    // State is too slow to stop a double click; the ref is what actually stops
    // a second POST, and the server refuses a duplicate by content hash even if
    // two tabs race past this.
    if (uploading.current) return
    uploading.current = true
    setBusy(true)
    setError(null)

    try {
      if (screenshots.length >= MAX_TEST_SCREENSHOTS) {
        setError('Remove the current screenshot before attaching another.')
        return
      }

      const file = files[0]
      // A courtesy check, not the boundary. See the note at the top.
      const invalid = validateTestScreenshot(file)
      if (invalid) { setError(invalid); return }

      const body = new FormData()
      body.append('cardId', cardId)
      body.append('kind', 'test_screenshot')
      body.append('file', file)

      const response = await fetch('/api/customer-reviews/photos', { method: 'POST', body })
      if (!response.ok) {
        // The route's own sentence, which is chosen from a closed list and
        // never contains a filename, a path or a number.
        const payload = await response.json().catch(() => null)
        setError(typeof payload?.error === 'string'
          ? payload.error
          : 'That screenshot could not be attached.')
        return
      }

      await onChanged()
    } catch {
      setError('That screenshot could not be attached. Check your connection and try again.')
    } finally {
      uploading.current = false
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }, [cardId, screenshots.length, onChanged])

  const remove = useCallback(async (shot: TestCardPhoto) => {
    if (removing.current) return
    removing.current = true
    setBusy(true)
    setError(null)
    try {
      // ONE call. Removing an attachment means deleting a private object AND a
      // metadata row, and a browser that could do either half on its own would
      // eventually do exactly one of them — leaving a file nothing names, or a
      // record pointing at nothing. The database refuses both halves to
      // `authenticated`, so this is the only path.
      const response = await fetch('/api/customer-reviews/photos', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoId: shot.id }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        setError(typeof payload?.error === 'string'
          ? payload.error
          : 'That screenshot could not be removed.')
        return
      }
      await onChanged()
    } catch {
      setError('That screenshot could not be removed. Check your connection and try again.')
    } finally {
      removing.current = false
      setBusy(false)
    }
  }, [onChanged])

  return (
    <div>
      {screenshots.length === 0 ? (
        <p style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>{emptyHint}</p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '10px' }}>
          {screenshots.map(shot => (
            <div
              key={shot.id}
              style={{
                width: '124px', borderRadius: '9px', overflow: 'hidden',
                border: `1px solid ${colors.border}`, background: colors.raised,
              }}
            >
              <div style={{ height: '92px', background: colors.float, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {urls[shot.storage_path] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={urls[shot.storage_path]}
                    alt={shot.file_name}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <span style={{ fontSize: '11px', color: colors.muted }}>Loading…</span>
                )}
              </div>
              <div style={{ padding: '6px 8px' }}>
                <div style={{
                  fontSize: '11px', color: colors.secondary, fontWeight: 600,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {shot.file_name}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4px', marginTop: '2px' }}>
                  <span style={{ fontSize: '10px', color: colors.muted }}>{formatPhotoSize(shot.byte_size)}</span>
                  {canRemove && (
                    <button
                      type="button"
                      onClick={() => remove(shot)}
                      disabled={busy}
                      aria-label={`Remove ${shot.file_name}`}
                      // 32px square. The icon is 13px; the padding is what makes
                      // it hittable with a thumb rather than only with a mouse.
                      style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: '32px', height: '32px', margin: '-6px -6px -6px 0',
                        borderRadius: '6px', border: 'none', background: 'transparent',
                        color: colors.red, cursor: busy ? 'not-allowed' : 'pointer',
                      }}
                    >
                      <Trash2 size={13} strokeWidth={2} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {canAttach && screenshots.length < MAX_TEST_SCREENSHOTS && (
        <>
          <input
            ref={inputRef}
            type="file"
            accept={TEST_SCREENSHOT_ACCEPT}
            onChange={e => attach(e.target.files)}
            style={{ display: 'none' }}
            id="test-screenshot-input"
          />
          <label
            htmlFor="test-screenshot-input"
            className="boe-btn boe-btn-ghost"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '7px 14px', fontSize: '12px', minHeight: '36px',
              cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1,
            }}
          >
            <ImagePlus size={14} strokeWidth={2} />
            {busy ? 'Checking and uploading…' : 'Attach screenshot'}
          </label>
          <p style={{ fontSize: '11px', color: colors.muted, marginTop: '6px', lineHeight: 1.5 }}>
            {TEST_SCREENSHOT_TYPES_LABEL}, up to 5 MB. Each file is checked on the server,
            re-encoded, and stripped of camera metadata before it is stored. It is kept in a private
            bucket that only you and a verifier can read.
          </p>
        </>
      )}

      {error && (
        <p role="alert" style={{ fontSize: '12px', color: colors.red, marginTop: '8px' }}>{error}</p>
      )}
    </div>
  )
}
