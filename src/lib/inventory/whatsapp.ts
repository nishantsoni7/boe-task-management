import { conditionLabel, type InventoryItem } from './constants'
import { formatPrice, readyText } from './format'

// What a customer receives on WhatsApp. Plain text with *bold* for the name (WhatsApp's own markup),
// the facts a buyer asks about, and the picture links last: WhatsApp builds its preview card from the first
// link, so the first picture shows large under the message.

export type ShareOptions = {
  /** Public picture addresses, in display order. */
  imageUrls: string[]
  includePrice: boolean
  /** YYYY-MM-DD, for the "ready in about N days" line. Defaults to today (IST). */
  today?: string
}

export function buildShareMessage(item: InventoryItem, opts: ShareOptions): string {
  const lines: string[] = []
  lines.push(`*${item.name}*`)
  lines.push(`Code: ${item.product_code}`)
  if (item.category) lines.push(`Category: ${item.category}`)
  lines.push(`Size: ${item.size_text}`)
  lines.push(`Material: ${item.material}`)
  lines.push(`Condition: ${conditionLabel(item.condition)}`)
  lines.push(`Status: ${readyText(item, opts.today)}`)
  if (opts.includePrice) lines.push(`Price: ${formatPrice(item.retail_price)}${item.qty_total > 1 ? ' each' : ''}`)
  lines.push(item.qty_available > 0 ? `Available: ${item.qty_available}` : 'Currently sold out')
  if (item.description?.trim()) lines.push('', item.description.trim())
  const urls = opts.imageUrls.slice(0, 4)
  if (urls.length) {
    lines.push('', urls.length === 1 ? 'Photo:' : 'Photos:', ...urls)
  }
  return lines.join('\n')
}

/** "98765 43210" or "+91 98765 43210" → "919876543210"; null when it cannot be a number. */
export function waDigits(raw: string | null | undefined): string | null {
  const d = (raw ?? '').replace(/\D/g, '')
  if (/^[6-9]\d{9}$/.test(d)) return `91${d}`
  if (/^0[6-9]\d{9}$/.test(d)) return `91${d.slice(1)}`
  if (/^91[6-9]\d{9}$/.test(d)) return d
  if (/^[1-9]\d{7,14}$/.test(raw?.trim().startsWith('+') ? d : '')) return d
  return null
}

/** wa.me opens WhatsApp with the text ready to send; with a number it opens that chat. */
export function waLink(text: string, phone?: string | null): string {
  const digits = waDigits(phone)
  return `https://wa.me/${digits ?? ''}?text=${encodeURIComponent(text)}`
}

/**
 * Send the actual photograph with the details, through the phone's share sheet (WhatsApp is one tap there).
 * Resolves true when a share sheet took it, false when this browser cannot share files (the caller then
 * falls back to waLink). A cancelled sheet counts as handled.
 */
export async function sharePhotoAndText(text: string, imageUrl: string | null, filename: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function' || !imageUrl) return false
  try {
    const res = await fetch(imageUrl)
    if (!res.ok) return false
    const blob = await res.blob()
    const file = new File([blob], `${filename}.jpg`, { type: 'image/jpeg' })
    if (typeof navigator.canShare !== 'function' || !navigator.canShare({ files: [file] })) return false
    await navigator.share({ files: [file], text })
    return true
  } catch (e) {
    return e instanceof DOMException && e.name === 'AbortError'
  }
}
