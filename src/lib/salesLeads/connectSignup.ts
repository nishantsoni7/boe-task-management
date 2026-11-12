// Reads the messages Meta's Embedded Signup pop-up posts back to the page that opened it
// (Control Center > WhatsApp Connection). Pure, so it is tested without a browser.
//
// Only the WhatsApp Business app finish counts as success. Every other finish (the plain
// Cloud API one above all) means the number was registered the other way, which takes it
// OFF the phone app: exactly what the page exists to avoid, so it is reported, not cheered.

export type SignupEvent =
  | { kind: 'finished'; wabaId: string; phoneNumberId: string }
  | { kind: 'wrong-flow'; event: string }
  | { kind: 'cancelled'; step: string }
  | { kind: 'error'; message: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')

/** null = not a message from Meta's pop-up (another tab, an extension, a wrong origin): ignore it. */
export function readSignupEvent(origin: string, raw: unknown): SignupEvent | null {
  let host: string
  try { host = new URL(origin).hostname } catch { return null }
  if (host !== 'facebook.com' && !host.endsWith('.facebook.com')) return null

  let msg = raw
  if (typeof raw === 'string') {
    try { msg = JSON.parse(raw) } catch { return null }
  }
  if (!isObj(msg) || msg.type !== 'WA_EMBEDDED_SIGNUP') return null
  const data = isObj(msg.data) ? msg.data : {}

  switch (msg.event) {
    case 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING': {
      const wabaId = text(data.waba_id)
      if (!wabaId) return { kind: 'error', message: 'Meta finished without an account ID.' }
      return { kind: 'finished', wabaId, phoneNumberId: text(data.phone_number_id) }
    }
    case 'CANCEL':
      return { kind: 'cancelled', step: text(data.current_step) || 'an unknown step' }
    case 'ERROR':
      return { kind: 'error', message: text(data.error_message) || 'Meta reported an error.' }
    default:
      return { kind: 'wrong-flow', event: text(msg.event) || 'an unnamed event' }
  }
}
