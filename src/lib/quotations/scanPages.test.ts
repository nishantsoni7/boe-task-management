// A PowerPoint slide's picture lands where the slide puts it. The XML is the shape of the Brewery deck (C:\BOE New\Inquiry\
// 659 Brewery, run 17 Nov 2026), whose pictures were all drawn at zero size before.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { slideFrame } from './scanPages'

const SLIDE = `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>
<p:pic><p:nvPicPr><p:cNvPr id="5" name="Picture 4"><a:extLst><a:ext uri="{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}"/></a:extLst></p:cNvPr><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:off x="758480" y="1988296"/><a:ext cx="3314870" cy="3391074"/></a:xfrm></p:spPr></p:pic>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>
</p:spTree></p:cSld></p:sld>`

test('a slide picture takes its size from a:xfrm, not from the a:ext in its name', () => {
  const doc = new new JSDOM('').window.DOMParser().parseFromString(SLIDE, 'application/xml')
  const f = slideFrame(doc.getElementsByTagName('p:pic')[0], 12192000, 6858000)
  assert.ok(Math.abs(f.x - 758480 / 12192000) < 1e-9)
  assert.ok(Math.abs(f.w - 3314870 / 12192000) < 1e-9)
  assert.ok(f.h > 0.49 && f.h < 0.5)
  // A placeholder with no frame of its own (it follows the layout) is at 0,0 with no size, not an error.
  assert.deepEqual(slideFrame(doc.getElementsByTagName('p:sp')[0], 12192000, 6858000), { x: 0, y: 0, w: 0, h: 0 })
})
