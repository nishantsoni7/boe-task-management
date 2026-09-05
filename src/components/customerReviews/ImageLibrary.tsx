'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Archive, ArchiveRestore, ImagePlus, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import { formatPhotoSize } from '@/lib/customerReviews/photos'
import {
  GROUP_IMAGE_ACCEPT,
  GROUP_IMAGE_BUCKET,
  GROUP_IMAGE_TYPES_LABEL,
  MAX_GROUP_IMAGES,
  MAX_GROUP_LABEL,
  validateGroupImage,
  validateGroupLabel,
} from '@/lib/customerReviews/imageGroups'
import {
  REVIEW_GROUP_IMAGE_COLUMNS,
  REVIEW_IMAGE_GROUP_COLUMNS,
  type ReviewGroupImage,
  type ReviewImageGroup,
} from '@/lib/customerReviews/types'
import { StackSkeleton } from './ReviewSkeletons'

// ── The project image library ────────────────────────────────────────────────
//
// ONE GROUP IS ONE PROJECT, and that sentence is the entire design. An image
// review points at a GROUP, so the photographs a candidate posts are one
// project's by construction — nobody has to remember not to mix two, because
// mixing two is not expressible.
//
// WHAT AN ADMINISTRATOR DOES HERE
//   * create a group and give it an internal name;
//   * add images to it, several at a time;
//   * look at what is in it;
//   * remove an image, WHERE PRODUCTION SAFETY ALLOWS;
//   * see whether it is currently in use, and archive it when it is finished.
//
// "WHERE PRODUCTION SAFETY ALLOWS" IS A DATABASE RULE, NOT A HINT.
// begin_customer_review_group_image_removal() refuses to touch a group that a
// live, already-booked review points at: the candidate has been told to post
// those photographs, and taking one away underneath them changes the job they
// were given. The button is still drawn — with the reason — because a control
// that vanishes teaches nobody why.
//
// ARCHIVING IS NOT DELETING. A review that points at a group is a record of
// what somebody was asked to post, so the group has to keep existing. Archiving
// takes it out of the random selection new assignments draw from and touches
// nothing else.
//
// ADDING AND REMOVING BOTH GO THROUGH THE SERVER, for the reason the two
// sibling managers give: the browser holds no INSERT or DELETE privilege on the
// metadata table and none on the bucket, so a direct write or a half-removal is
// refused by the database rather than merely discouraged here.
//
// READING is direct: short-lived signed URLs, minted per render, governed by
// can_view_customer_review_image_group(). Nothing here is public.

const SIGNED_URL_TTL_SECONDS = 300

type GroupWithImages = ReviewImageGroup & { images: ReviewGroupImage[] }

export function ImageLibrary({ supabase }: { supabase: SupabaseClient }) {
  const [groups, setGroups] = useState<GroupWithImages[] | null>(null)
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [newLabel, setNewLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  const acting = useRef(false)
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  const load = useCallback(async () => {
    // THREE REQUESTS, NOT ONE PER GROUP. The groups, then every live image in
    // one `in`, then the count of reviews pointing at each — so twenty groups
    // cost the same three round trips as one does.
    const { data: groupRows, error: groupError } = await supabase
      .from('customer_review_image_groups')
      .select(REVIEW_IMAGE_GROUP_COLUMNS)
      .order('created_at', { ascending: false })

    if (groupError) {
      setError('The project image library could not be loaded. Refresh to try again.')
      setGroups([])
      return
    }

    const rows = (groupRows ?? []) as unknown as ReviewImageGroup[]
    const ids = rows.map(g => g.id)

    let images: ReviewGroupImage[] = []
    let inUse = new Map<string, number>()

    if (ids.length > 0) {
      const [{ data: imageRows }, { data: cardRows }] = await Promise.all([
        supabase
          .from('customer_review_group_images')
          .select(REVIEW_GROUP_IMAGE_COLUMNS)
          .in('group_id', ids)
          .is('removal_started_at', null)
          .order('uploaded_at', { ascending: true }),
        // WHETHER A GROUP IS CURRENTLY ASSIGNED. Only the group id is selected —
        // this is a count of references, not a list of reviews, and there is
        // nothing here that could be rendered as one.
        supabase
          .from('customer_review_test_cards')
          .select('image_group_id')
          .in('image_group_id', ids)
          .is('deleted_at', null),
      ])

      images = (imageRows ?? []) as unknown as ReviewGroupImage[]
      inUse = new Map<string, number>()
      for (const row of (cardRows ?? []) as { image_group_id: string | null }[]) {
        if (!row.image_group_id) continue
        inUse.set(row.image_group_id, (inUse.get(row.image_group_id) ?? 0) + 1)
      }
    }

    setError('')
    setGroups(rows.map(g => {
      const mine = images.filter(i => i.group_id === g.id)
      return { ...g, images: mine, image_count: mine.length, assigned_count: inUse.get(g.id) ?? 0 }
    }))
  }, [supabase])

  useEffect(() => {
    const startFetch = () => { void load() }
    startFetch()
  }, [load])

  // Signed URLs are minted per render pass and never stored anywhere. They
  // expire on their own, and a viewer who has lost access simply gets no URL.
  useEffect(() => {
    if (!groups) return
    const paths = groups.flatMap(g => g.images.map(i => i.storage_path))
    if (paths.length === 0) return
    let active = true
    supabase.storage
      .from(GROUP_IMAGE_BUCKET)
      .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)
      .then(({ data }) => {
        if (!active || !data) return
        const next: Record<string, string> = {}
        data.forEach((entry, index) => {
          if (entry.signedUrl) next[paths[index]] = entry.signedUrl
        })
        setUrls(prev => ({ ...prev, ...next }))
      })
      .catch(() => { /* a missing thumbnail is not an error worth a banner */ })
    return () => { active = false }
  }, [supabase, groups])

  const create = useCallback(async () => {
    if (acting.current) return
    const checked = validateGroupLabel(newLabel)
    if (!checked.ok) { setError(checked.error); return }
    acting.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const { data, error: rpcError } = await supabase.rpc('create_customer_review_image_group', {
        p_label: checked.label,
      })
      if (rpcError) {
        setError(rpcError.message.replace(/^[A-Z_]+:\s*/, '') || 'That project group could not be created.')
        return
      }
      setNewLabel('')
      setNotice(`“${checked.label}” created. Add its images next.`)
      // Opened immediately, because creating an empty group is never the goal —
      // adding pictures to it is, and a group with none is not offered to a
      // review at all.
      const created = (data ?? null) as { id?: string } | null
      if (created?.id) setOpenGroup(created.id)
      await load()
    } catch {
      setError('That project group could not be created. Check your connection and try again.')
    } finally {
      acting.current = false
      setBusy(false)
    }
  }, [supabase, newLabel, load])

  const addImages = useCallback(async (groupId: string, files: FileList | null, existing: number) => {
    if (!files || files.length === 0 || acting.current) return
    acting.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const chosen = Array.from(files)
      const room = MAX_GROUP_IMAGES - existing
      if (room <= 0) {
        setError(`A project group holds ${MAX_GROUP_IMAGES} images. Remove one before adding another.`)
        return
      }
      if (chosen.length > room) {
        setError(`Only ${room} more image${room === 1 ? '' : 's'} can be added to this project.`)
        return
      }

      // ONE AT A TIME, IN ORDER. Sequential rather than parallel so a refusal
      // names the file that caused it and the ones after it are not uploaded on
      // top of a failure.
      let added = 0
      for (const file of chosen) {
        const objection = validateGroupImage(file)
        if (objection) { setError(objection); break }

        const form = new FormData()
        form.append('groupId', groupId)
        form.append('file', file)

        const res = await fetch('/api/customer-reviews/image-groups', { method: 'POST', body: form })
        if (!res.ok) {
          const payload = await res.json().catch(() => null)
          setError(payload?.error ?? 'That image could not be added. Try again.')
          break
        }
        added++
      }
      if (added > 0) setNotice(`${added} image${added === 1 ? '' : 's'} added.`)
      await load()
    } catch {
      setError('That image could not be added. Try again.')
    } finally {
      acting.current = false
      setBusy(false)
      const input = inputRefs.current[groupId]
      // Cleared so choosing the same file twice in a row still fires onChange.
      if (input) input.value = ''
    }
  }, [load])

  const removeImage = useCallback(async (imageId: string) => {
    if (acting.current) return
    acting.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const res = await fetch('/api/customer-reviews/image-groups', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageId }),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        setError(payload?.error ?? 'That image could not be removed. Try again.')
        return
      }
      await load()
    } catch {
      setError('That image could not be removed. Try again.')
    } finally {
      acting.current = false
      setBusy(false)
    }
  }, [load])

  const rename = useCallback(async (groupId: string, current: string) => {
    if (acting.current) return
    // window.prompt is the right size for this control and the wrong size for
    // anything larger. Renaming a project is a one-field correction — usually a
    // typo — and a modal, a form and three pieces of state for one string would
    // be more machinery than the action deserves. Every rule that matters is
    // enforced elsewhere: validateGroupLabel() here, the column CHECK and the
    // uniqueness constraint in the database.
    const next = window.prompt('Project name', current)
    if (next === null || next.trim() === current) return

    const checked = validateGroupLabel(next)
    if (!checked.ok) { setError(checked.error); return }

    acting.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const { error: rpcError } = await supabase.rpc('rename_customer_review_image_group', {
        p_group_id: groupId,
        p_label: checked.label,
      })
      if (rpcError) {
        setError(rpcError.message.replace(/^[A-Z_]+:\s*/, '') || 'That project could not be renamed.')
        return
      }
      await load()
    } catch {
      setError('That project could not be renamed. Check your connection and try again.')
    } finally {
      acting.current = false
      setBusy(false)
    }
  }, [supabase, load])

  const setArchived = useCallback(async (groupId: string, archived: boolean) => {
    if (acting.current) return
    acting.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const { error: rpcError } = await supabase.rpc('archive_customer_review_image_group', {
        p_group_id: groupId,
        p_archived: archived,
      })
      if (rpcError) {
        setError(rpcError.message.replace(/^[A-Z_]+:\s*/, '') || 'That project group could not be changed.')
        return
      }
      setNotice(archived
        ? 'Archived. It will not be given to any new assignment; the reviews already using it are untouched.'
        : 'Restored. New assignments can draw from it again.')
      await load()
    } catch {
      setError('That project group could not be changed. Check your connection and try again.')
    } finally {
      acting.current = false
      setBusy(false)
    }
  }, [supabase, load])

  return (
    <section style={{
      display: 'flex', flexDirection: 'column', gap: '12px',
      border: `1px solid ${colors.borderSoft}`, borderRadius: '10px',
      background: colors.base, padding: '14px',
    }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <h2 style={{
          margin: 0, fontSize: '13px', fontWeight: 700, letterSpacing: '0.04em',
          textTransform: 'uppercase', color: colors.primary,
        }}>
          Project image library
        </h2>
        <p style={{ margin: 0, fontSize: '12px', color: colors.secondary, lineHeight: 1.6 }}>
          One group is one project. An image review is given a whole group, so a candidate
          always posts one project&rsquo;s photographs. Images stay private.
        </p>
      </header>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="text"
          value={newLabel}
          maxLength={MAX_GROUP_LABEL}
          onChange={e => { setNewLabel(e.target.value); setError('') }}
          placeholder="Project name, for internal use"
          aria-label="New project group name"
          className="boe-input"
          style={{ maxWidth: '280px', minHeight: '40px' }}
        />
        <button
          type="button"
          onClick={() => { void create() }}
          disabled={busy || newLabel.trim().length === 0}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            padding: '9px 14px', borderRadius: '8px', minHeight: '40px',
            border: `1px solid ${colors.border}`, fontSize: '13px', fontWeight: 600,
            background: colors.raised, color: colors.primary,
            cursor: busy || !newLabel.trim() ? 'not-allowed' : 'pointer',
          }}
        >
          {busy ? <Loader2 size={14} className="boe-spin" /> : <Plus size={14} />}
          New project group
        </button>
      </div>

      {error && <p role="alert" style={{ fontSize: '12px', color: colors.red, margin: 0, lineHeight: 1.6 }}>{error}</p>}
      {notice && <p role="status" style={{ fontSize: '12px', color: '#166534', margin: 0, lineHeight: 1.6 }}>{notice}</p>}

      {groups === null ? (
        <StackSkeleton count={3} height={62} />
      ) : groups.length === 0 ? (
        <p style={{
          margin: 0, padding: '18px', borderRadius: '8px', fontSize: '12px', lineHeight: 1.6,
          border: `1px dashed ${colors.border}`, color: colors.muted,
        }}>
          No project groups yet. Until one has images, every image review waits.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {groups.map(group => {
            const open = openGroup === group.id
            const count = group.images.length
            const assigned = group.assigned_count ?? 0
            return (
              <li key={group.id} style={{
                border: `1px solid ${colors.border}`, borderRadius: '8px',
                background: group.archived_at ? colors.raised : '#FFFFFF',
              }}>
                <div style={{
                  display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap',
                  padding: '10px 12px',
                }}>
                  <button
                    type="button"
                    onClick={() => setOpenGroup(open ? null : group.id)}
                    style={{
                      background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                      fontSize: '13px', fontWeight: 700, color: colors.primary, textAlign: 'left',
                    }}
                  >
                    {group.label}
                  </button>

                  <span style={{ fontSize: '11px', color: colors.secondary, fontVariantNumeric: 'tabular-nums' }}>
                    {count} image{count === 1 ? '' : 's'}
                  </span>

                  {/* WHETHER IT IS CURRENTLY ASSIGNED — the fact the requirement
                      asks for, said as a number rather than a yes/no, because
                      "used by 6 reviews" is what decides whether to archive it. */}
                  <span style={{ fontSize: '11px', color: assigned > 0 ? '#1E40AF' : colors.muted }}>
                    {assigned > 0 ? `In use by ${assigned} review${assigned === 1 ? '' : 's'}` : 'Not assigned'}
                  </span>

                  {count === 0 && !group.archived_at && (
                    <span style={{ fontSize: '11px', color: '#92400E', fontWeight: 600 }}>
                      Not offered to reviews until it has an image
                    </span>
                  )}

                  {group.archived_at && (
                    <span style={{ fontSize: '11px', color: colors.muted, fontWeight: 600 }}>Archived</span>
                  )}

                  <button
                    type="button"
                    onClick={() => { void rename(group.id, group.label) }}
                    disabled={busy}
                    style={{
                      marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '5px',
                      background: 'transparent', border: 'none', padding: '4px', cursor: busy ? 'not-allowed' : 'pointer',
                      fontSize: '11px', color: colors.secondary,
                    }}
                  >
                    <Pencil size={13} />
                    Rename
                  </button>

                  <button
                    type="button"
                    onClick={() => { void setArchived(group.id, !group.archived_at) }}
                    disabled={busy}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '5px',
                      background: 'transparent', border: 'none', padding: '4px', cursor: busy ? 'not-allowed' : 'pointer',
                      fontSize: '11px', color: colors.secondary,
                    }}
                  >
                    {group.archived_at ? <ArchiveRestore size={13} /> : <Archive size={13} />}
                    {group.archived_at ? 'Restore' : 'Archive'}
                  </button>
                </div>

                {/*
                  A THUMBNAIL STRIP ON THE COLLAPSED CARD, so a project is
                  recognisable without opening it — an admin scanning a library
                  is looking for a project, and a row of labels all look alike.

                  IT COSTS NOTHING EXTRA. These are the SAME signed URLs the
                  expanded view uses, already minted by the effect above for
                  every image on the page. Only the first four are drawn, and a
                  URL that has not arrived yet simply renders nothing — no
                  placeholder box, because a row of grey squares reads as a
                  broken project rather than a loading one.
                */}
                {!open && count > 0 && (
                  <div style={{
                    display: 'flex', gap: '6px', padding: '0 12px 11px',
                    alignItems: 'center', flexWrap: 'wrap',
                  }}>
                    {group.images.slice(0, 4).map(image => (
                      urls[image.storage_path] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          key={image.id}
                          src={urls[image.storage_path]}
                          alt=""
                          style={{
                            width: '44px', height: '44px', objectFit: 'cover',
                            borderRadius: '6px', border: `1px solid ${colors.border}`,
                            display: 'block', flexShrink: 0,
                          }}
                        />
                      ) : null
                    ))}
                    {count > 4 && (
                      <span style={{ fontSize: '11px', color: colors.muted }}>
                        +{count - 4}
                      </span>
                    )}
                  </div>
                )}

                {open && (
                  <div style={{
                    borderTop: `1px solid ${colors.border}`, padding: '10px 12px',
                    display: 'flex', flexDirection: 'column', gap: '10px',
                  }}>
                    {count > 0 && (
                      <ul style={{
                        listStyle: 'none', margin: 0, padding: 0,
                        display: 'grid', gap: '8px',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
                      }}>
                        {group.images.map(image => (
                          <li key={image.id} style={{
                            position: 'relative', borderRadius: '8px', overflow: 'hidden',
                            border: `1px solid ${colors.border}`, background: colors.raised,
                          }}>
                            {/*
                              A PLAIN <img>, as the two sibling managers use. A
                              signed, short-lived storage URL cannot go through
                              next/image: the optimiser fetches it server-side and
                              caches the result past the life of the signature,
                              which turns a 300-second grant into a cached copy of
                              a private object.
                            */}
                            {urls[image.storage_path] ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={urls[image.storage_path]}
                                alt={image.file_name}
                                style={{ display: 'block', width: '100%', aspectRatio: '1 / 1', objectFit: 'cover' }}
                              />
                            ) : (
                              <div style={{
                                width: '100%', aspectRatio: '1 / 1', display: 'flex',
                                alignItems: 'center', justifyContent: 'center', padding: '6px',
                                fontSize: '10px', color: colors.muted, textAlign: 'center',
                                overflowWrap: 'anywhere',
                              }}>
                                {image.file_name}
                              </div>
                            )}

                            <div style={{
                              padding: '5px 6px', fontSize: '10px', color: colors.tertiary,
                              borderTop: `1px solid ${colors.border}`, background: '#FFFFFF',
                            }}>
                              {formatPhotoSize(image.byte_size)}
                            </div>

                            <button
                              type="button"
                              onClick={() => { void removeImage(image.id) }}
                              disabled={busy}
                              aria-label={`Remove ${image.file_name}`}
                              style={{
                                position: 'absolute', top: '4px', right: '4px',
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                width: '26px', height: '26px', borderRadius: '6px',
                                border: 'none', background: 'rgba(17,24,39,0.72)', color: '#FFFFFF',
                                cursor: busy ? 'not-allowed' : 'pointer',
                              }}
                            >
                              <Trash2 size={13} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}

                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        ref={el => { inputRefs.current[group.id] = el }}
                        type="file"
                        accept={GROUP_IMAGE_ACCEPT}
                        multiple
                        onChange={e => { void addImages(group.id, e.target.files, count) }}
                        disabled={busy || count >= MAX_GROUP_IMAGES}
                        style={{ display: 'none' }}
                        id={`group-file-${group.id}`}
                      />
                      <label
                        htmlFor={`group-file-${group.id}`}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: '6px',
                          padding: '9px 14px', borderRadius: '8px', minHeight: '40px',
                          border: `1px solid ${colors.border}`, fontSize: '13px', fontWeight: 600,
                          background: colors.raised,
                          color: count >= MAX_GROUP_IMAGES ? colors.muted : colors.primary,
                          cursor: busy || count >= MAX_GROUP_IMAGES ? 'not-allowed' : 'pointer',
                        }}
                      >
                        <ImagePlus size={14} />
                        Add images
                      </label>
                      <span style={{ fontSize: '11px', color: colors.muted }}>
                        {GROUP_IMAGE_TYPES_LABEL}, up to 5 MB each · {count} of {MAX_GROUP_IMAGES}
                      </span>
                    </div>

                    {assigned > 0 && (
                      <p style={{ margin: 0, fontSize: '11px', color: colors.secondary, lineHeight: 1.6 }}>
                        Once a candidate books a review using this project, its images are fixed.
                      </p>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
