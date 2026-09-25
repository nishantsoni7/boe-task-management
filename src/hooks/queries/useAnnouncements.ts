'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import type { MyAnnouncement } from '@/lib/announcements'

// The signed-in person's active announcements, as public.my_announcements()
// decides them: named recipient, live today in India, with their own read time.
//
// ONE QUERY FEEDS THE BANNER, THE HEADER PANEL AND THE ANNOUNCEMENTS PAGE, so
// acknowledging on one of them updates all three. It reads; it never writes —
// a page load records nothing. Keyed by the signed-in user so one person's list
// can never be shown to the next person on the same browser.
export const announcementKeys = {
  mine: (userId: string | null) => ['announcements', 'mine', userId] as const,
}

export function useMyAnnouncements(userId: string | null, enabled = true) {
  return useQuery<MyAnnouncement[]>({
    queryKey: announcementKeys.mine(userId),
    enabled: !!userId && enabled,
    queryFn: async () => {
      const { data, error } = await createClient().rpc('my_announcements')
      if (error) throw error
      return (data ?? []) as MyAnnouncement[]
    },
    staleTime: 60_000,
  })
}

/** Records "I have read this" for the signed-in person only (the RPC takes no user). */
export function useAcknowledgeAnnouncement(userId: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (announcementId: string) => {
      const { data, error } = await createClient().rpc('acknowledge_announcement', { p_id: announcementId })
      if (error) throw error
      return { announcementId, readAt: data as string }
    },
    onSuccess: ({ announcementId, readAt }) => {
      qc.setQueryData<MyAnnouncement[]>(announcementKeys.mine(userId), list =>
        list?.map(a => (a.id === announcementId ? { ...a, read_at: a.read_at ?? readAt } : a)))
      void qc.invalidateQueries({ queryKey: announcementKeys.mine(userId) })
    },
  })
}

/** A short-lived signed URL for a PDF; storage RLS decides whether it is issued. */
export async function signAnnouncementPdf(path: string, ttlSeconds: number): Promise<string> {
  const { data, error } = await createClient().storage
    .from('announcement-files')
    .createSignedUrl(path, ttlSeconds)
  if (error || !data?.signedUrl) throw error ?? new Error('Could not open the PDF.')
  return data.signedUrl
}
