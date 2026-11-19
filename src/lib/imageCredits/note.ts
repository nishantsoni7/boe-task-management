// The sentence beside a picture button, from what /api/image-credits/me answered. Pure and client-safe.
// Credits only: never rupees, providers or models (staff screens deliberately say nothing about cost).

export type CreditStatus = { enabled?: boolean; enforce?: boolean; allowed?: boolean; month_left?: number; today_left?: number }

/** The sentence for a status, or null when there is nothing to say (limits off, or no answer yet). */
export function creditNoteText(status: CreditStatus | null, cost: number): { text: string; warn: boolean } | null {
  if (!status?.enforce) return null
  if (status.enabled === false) return { text: 'Picture making is switched off for now.', warn: true }
  if (status.allowed === false) return { text: 'Picture credits are not switched on for your account. Ask a founder.', warn: true }
  const month = status.month_left ?? 0
  const today = status.today_left ?? 0
  const uses = `Uses ${cost} credit${cost === 1 ? '' : 's'}`
  if (month < cost) return { text: `${uses}, but you have ${month} left this month. They start again on the 1st.`, warn: true }
  if (today < cost) return { text: `${uses}, but you have reached today’s limit. Try again tomorrow.`, warn: true }
  return { text: `${uses} · ${month} left this month · ${today} left today`, warn: false }
}
