// The Best of Exports mark on every quotation picture the client sees (owner, 18 Nov 2026): a black translucent strip
// through the product, a little below the middle, with the small signature (icon and name, white) repeated across it.
// It is burned into the picture file, so saving or screenshotting the picture keeps it. The clean original stays in the
// private 'quotation-originals' bucket; this runs on the server only (sharp), for new pictures and for the backfill.
//
// The owner chose these numbers on the review page (strip 6% high, 45% dark, logo 45% of the strip, centred at 58%).
// They live here and nowhere else, so changing the look is a change to this block and a re-run of the backfill.

import sharp from 'sharp'
import { MARK_LOGO_HEIGHT, MARK_LOGO_PNG_BASE64, MARK_LOGO_WIDTH } from './pictureMarkLogo'

export const MARK = {
  /** Strip height as a share of the picture's height, with a floor so a small picture still reads. */
  stripShare: 0.06,
  stripMinPx: 24,
  /** Where the strip's centre sits, as a share of the picture's height (50% would be exactly the middle). */
  centreShare: 0.58,
  /** How dark the strip is. */
  darkness: 0.45,
  /** The logo's height as a share of the strip's. */
  logoShare: 0.45,
  /** Space between two logos, in logo heights. */
  gapLogos: 1.7,
} as const

export type MarkLayout = { stripTop: number; stripHeight: number; logoHeight: number; logoWidth: number; gap: number }

/** Where everything goes for a picture of this size. Pure, so it is tested without an image. */
export function markLayout(width: number, height: number): MarkLayout {
  const stripHeight = Math.min(height, Math.max(MARK.stripMinPx, Math.round(height * MARK.stripShare)))
  const stripTop = Math.min(height - stripHeight, Math.max(0, Math.round(height * MARK.centreShare - stripHeight / 2)))
  const logoHeight = Math.max(10, Math.round(stripHeight * MARK.logoShare))
  const logoWidth = Math.round(logoHeight * (MARK_LOGO_WIDTH / MARK_LOGO_HEIGHT))
  const gap = Math.round(logoHeight * MARK.gapLogos)
  void width
  return { stripTop, stripHeight, logoHeight, logoWidth, gap }
}

/** The logos' left edges, from the left, one logo plus one gap apart, until the strip is full. */
export function logoPositions(width: number, l: Pick<MarkLayout, 'logoWidth' | 'gap'>): number[] {
  const out: number[] = []
  for (let x = Math.round(l.gap / 2); x < width; x += l.logoWidth + l.gap) out.push(x)
  return out
}

/** A JPEG in, the same picture with the mark out. The picture's size and format do not change. */
export async function markPicture(jpeg: Uint8Array | Buffer): Promise<Buffer> {
  const base = sharp(jpeg).rotate() // honour the camera's orientation before measuring
  const { width, height } = await base.metadata().then(m => ({ width: m.width ?? 0, height: m.height ?? 0 }))
  if (!width || !height) throw new Error('The picture could not be read.')
  const l = markLayout(width, height)
  const strip = await sharp({ create: { width, height: l.stripHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: MARK.darkness } } }).png().toBuffer()
  const logo = await sharp(Buffer.from(MARK_LOGO_PNG_BASE64, 'base64')).resize({ height: l.logoHeight }).png().toBuffer()
  const logoTop = l.stripTop + Math.round((l.stripHeight - l.logoHeight) / 2)
  const layers = [
    { input: strip, left: 0, top: l.stripTop },
    ...logoPositions(width, l).map(left => ({ input: logo, left, top: logoTop })),
  ]
  return base.composite(layers).jpeg({ quality: 88, mozjpeg: true }).toBuffer()
}
