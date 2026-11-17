// SERVER ONLY (imports sharp). A product picture from an old PI workbook, shrunk to a
// small JPEG data URL so a whole sheet answers in one small response (about 6 KB a picture).

import sharp from 'sharp'

const SIDE = 160

export async function thumbnailDataUrl(bytes: Uint8Array): Promise<string | null> {
  try {
    const out = await sharp(bytes, { failOn: 'none' }).rotate()
      .resize({ width: SIDE, height: SIDE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 70 }).toBuffer()
    return `data:image/jpeg;base64,${out.toString('base64')}`
  } catch {
    return null
  }
}
