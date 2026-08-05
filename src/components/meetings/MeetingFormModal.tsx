'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Check, Search } from 'lucide-react'
import { colors } from '@/lib/tokens'
import type { UserProfile } from '@/lib/types'
import { MeetingModal, MeetingField, MeetingModalActions, MeetingModalError } from './MeetingModal'
import { meetingErrorMessage, logMeetingFailure } from '@/lib/meetings/errors'
import { istToday } from '@/lib/istDate'
import {
  MEETING_TYPES, MEETING_TYPE_META, defaultMeetingTitle,
  type Meeting, type MeetingType,
} from '@/lib/meetings/types'

// Schedule a review, or correct its header.
//
// Five fields, three of which are pre-filled: the type, today's date, and a
// title generated from the two. A lead can create a meeting by choosing New
// Order or Repair Order and pressing Create — everything else is optional and
// can be settled during the meeting itself.
//
// Attendees are selected from the ACTIVE BOE member list. There is no second
// employee directory here and never should be.

type MemberOption = { id: string; full_name: string; team: string }

export function MeetingFormModal({
  supabase, profile, meeting, initialAttendeeIds, onClose, onSaved,
}: {
  supabase: SupabaseClient
  profile: UserProfile
  /** Present when editing an existing meeting's header. */
  meeting?: Meeting
  initialAttendeeIds?: string[]
  onClose: () => void
  onSaved: (meetingId: string) => void
}) {
  const editing = !!meeting

  const [type, setType]     = useState<MeetingType>(meeting?.meeting_type ?? 'new_order')
  const [date, setDate]     = useState<string>(meeting?.meeting_date ?? istToday())
  const [title, setTitle]   = useState<string>(meeting?.title ?? defaultMeetingTitle('new_order', istToday()))
  const [leadId, setLeadId] = useState<string>(meeting?.lead_id ?? profile.id)
  const [note, setNote]     = useState<string>(meeting?.note ?? '')
  const [attendees, setAttendees] = useState<Set<string>>(new Set(initialAttendeeIds ?? []))
  const [memberSearch, setMemberSearch] = useState('')

  const [members, setMembers] = useState<MemberOption[]>([])
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState<string | null>(null)

  // The title follows type and date only until the user takes it over. After
  // one keystroke it is theirs, and changing the date must not silently rewrite
  // what they typed.
  const titleTouched = useRef(editing)

  useEffect(() => {
    if (titleTouched.current) return
    setTitle(defaultMeetingTitle(type, date))
  }, [type, date])

  useEffect(() => {
    let active = true
    supabase
      .from('users')
      .select('id, full_name, team')
      .eq('is_active', true)
      .order('full_name')
      .then(({ data }) => {
        if (active && data) setMembers(data as MemberOption[])
      })
    return () => { active = false }
  }, [supabase])

  const filteredMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase()
    if (!q) return members
    return members.filter(m => `${m.full_name} ${m.team}`.toLowerCase().includes(q))
  }, [members, memberSearch])

  const toggleAttendee = (id: string) => {
    setAttendees(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const canSubmit = title.trim() !== '' && date !== '' && leadId !== ''

  const handleSave = async () => {
    if (!canSubmit || saving) return
    setSaving(true)
    setError(null)

    const payload = {
      meeting_type: type,
      meeting_date: date,
      title: title.trim(),
      lead_id: leadId,
      note: note.trim() || null,
    }

    if (editing) {
      const { error: updateErr } = await supabase
        .from('meetings')
        .update(payload)
        .eq('id', meeting.id)

      if (updateErr) {
        logMeetingFailure('edit-meeting', updateErr)
        setError(meetingErrorMessage('edit-meeting', updateErr))
        setSaving(false)
        return
      }

      // Attendees: write only the difference, so an unchanged list costs
      // nothing and a removal never takes an unrelated row with it.
      //
      // The lead is folded in here as well as on create. Handing the meeting to
      // someone else must add them to the room — otherwise the new lead is the
      // one person who cannot see the meeting they now own.
      const before = new Set(initialAttendeeIds ?? [])
      const intended = new Set(attendees)
      intended.add(leadId)
      const added   = [...intended].filter(id => !before.has(id))
      const removed = [...before].filter(id => !intended.has(id))

      if (removed.length > 0) {
        const { error: delErr } = await supabase
          .from('meeting_attendees')
          .delete()
          .eq('meeting_id', meeting.id)
          .in('user_id', removed)
        if (delErr) {
          logMeetingFailure('attendees', delErr)
          setError(meetingErrorMessage('attendees', delErr))
          setSaving(false)
          return
        }
      }
      if (added.length > 0) {
        const { error: insErr } = await supabase
          .from('meeting_attendees')
          .insert(added.map(user_id => ({ meeting_id: meeting.id, user_id })))
        if (insErr) {
          logMeetingFailure('attendees', insErr)
          setError(meetingErrorMessage('attendees', insErr))
          setSaving(false)
          return
        }
      }

      setSaving(false)
      onSaved(meeting.id)
      return
    }

    const { data, error: insertErr } = await supabase
      .from('meetings')
      .insert({ ...payload, created_by: profile.id })
      .select('id')
      .single()

    if (insertErr || !data) {
      logMeetingFailure('create-meeting', insertErr ?? { message: 'no row returned' })
      setError(meetingErrorMessage('create-meeting', insertErr ?? {}))
      setSaving(false)
      return
    }

    // The lead is always an attendee. They were in the room by definition, and
    // relying on them to tick their own name is how a meeting ends up invisible
    // to the person who ran it.
    const attendeeIds = new Set(attendees)
    attendeeIds.add(leadId)

    const { error: attErr } = await supabase
      .from('meeting_attendees')
      .insert([...attendeeIds].map(user_id => ({ meeting_id: data.id, user_id })))

    // A failed attendee write is reported but does not undo the meeting: the
    // meeting exists, the creator can still open it, and the list is editable
    // from the meeting screen. Losing the meeting would be the worse outcome.
    if (attErr) logMeetingFailure('attendees', attErr)

    setSaving(false)
    onSaved(data.id)
  }

  return (
    <MeetingModal
      title={editing ? 'Edit Meeting' : 'New Meeting'}
      subtitle={editing ? undefined : 'Two fields are enough to start — the rest can be filled in during the review.'}
      onClose={onClose}
      width={520}
    >
      {error && <MeetingModalError message={error} />}

      <MeetingField label="Meeting Type" group>
        <div style={{ display: 'flex', gap: '6px' }}>
          {MEETING_TYPES.map(t => {
            const meta = MEETING_TYPE_META[t]
            const selected = type === t
            return (
              <button
                key={t}
                onClick={() => setType(t)}
                style={{
                  flex: 1, padding: '8px 6px', borderRadius: '8px', cursor: 'pointer',
                  fontSize: '12.5px', fontWeight: selected ? 700 : 500,
                  border: `1px solid ${selected ? meta.color : colors.border}`,
                  background: selected ? meta.bg : 'transparent',
                  color: selected ? meta.color : colors.secondary,
                  transition: 'all 0.12s',
                }}
              >
                {meta.label} Review
              </button>
            )
          })}
        </div>
      </MeetingField>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <MeetingField label="Meeting Date">
          <input
            type="date"
            className="boe-input"
            value={date}
            onChange={e => setDate(e.target.value)}
            style={{ colorScheme: 'light' }}
          />
        </MeetingField>
        <MeetingField label="Meeting Lead">
          <select className="boe-input" value={leadId} onChange={e => setLeadId(e.target.value)}>
            {members.length === 0 && <option value={profile.id}>{profile.full_name}</option>}
            {members.map(m => (
              <option key={m.id} value={m.id}>{m.full_name}</option>
            ))}
          </select>
        </MeetingField>
      </div>

      <MeetingField label="Title" hint="Generated from the type and date. Edit it if this review has a name of its own.">
        <input
          className="boe-input"
          value={title}
          onChange={e => { titleTouched.current = true; setTitle(e.target.value) }}
          placeholder="Meeting title"
        />
      </MeetingField>

      <MeetingField label="Attendees" optional group hint={`${attendees.size} selected. The meeting lead is always included.`}>
        <div style={{ position: 'relative', marginBottom: '6px' }}>
          <Search
            size={13}
            color={colors.muted}
            style={{ position: 'absolute', left: '9px', top: '50%', transform: 'translateY(-50%)' }}
          />
          <input
            className="boe-input"
            aria-label="Search members"
            placeholder="Search members…"
            value={memberSearch}
            onChange={e => setMemberSearch(e.target.value)}
            style={{ paddingLeft: '28px', fontSize: '12px' }}
          />
        </div>
        <div style={{
          maxHeight: '168px', overflowY: 'auto',
          border: `1px solid ${colors.border}`, borderRadius: '8px',
        }}>
          {filteredMembers.length === 0 ? (
            <div style={{ padding: '14px', fontSize: '12px', color: colors.muted, textAlign: 'center' }}>
              No members match that search.
            </div>
          ) : filteredMembers.map(m => {
            const checked = attendees.has(m.id) || m.id === leadId
            const locked = m.id === leadId
            return (
              <button
                key={m.id}
                onClick={() => { if (!locked) toggleAttendee(m.id) }}
                disabled={locked}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '7px 10px', border: 'none', textAlign: 'left',
                  background: checked ? 'rgba(85,133,232,0.06)' : 'transparent',
                  cursor: locked ? 'default' : 'pointer',
                  borderBottom: `1px solid ${colors.border}`,
                }}
              >
                <span style={{
                  width: 16, height: 16, borderRadius: '4px', flexShrink: 0,
                  border: `1px solid ${checked ? colors.blue : colors.borderMed}`,
                  background: checked ? colors.blue : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {checked && <Check size={11} strokeWidth={3} color="#fff" />}
                </span>
                <span style={{ fontSize: '12.5px', color: colors.primary, flex: 1, minWidth: 0 }}>
                  {m.full_name}
                </span>
                <span style={{ fontSize: '11px', color: colors.muted, textTransform: 'capitalize', flexShrink: 0 }}>
                  {locked ? 'Lead' : m.team}
                </span>
              </button>
            )
          })}
        </div>
      </MeetingField>

      <MeetingField label="Meeting Note" optional hint="Not minutes. A meeting can always be completed without this.">
        <textarea
          className="boe-input"
          rows={2}
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="Anything worth recording about the session itself…"
          style={{ resize: 'none' }}
        />
      </MeetingField>

      <MeetingModalActions
        onClose={onClose}
        onSave={handleSave}
        saving={saving}
        disabled={!canSubmit}
        saveLabel={editing ? 'Save Changes' : 'Create Meeting'}
      />
    </MeetingModal>
  )
}
