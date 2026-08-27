// The instruction sent with the photograph.
//
// This file IS the product requirement. Every rule BOE stated about the result —
// what may change, what must not, and what to do when the photograph does not
// match the preferred showroom angle — is written here rather than scattered
// through the route, because the model is the only thing that enforces them and
// this string is the only thing the model reads.
//
// The governing rule, and the reason for the order below: the uploaded
// photograph is the source of truth. Everything the instruction asks for is a
// change to the SETTING and the LIGHT. Nothing in it authorises a change to the
// PRODUCT. A model asked to make furniture look good will happily redesign it,
// so the preservation clauses are stated as prohibitions and repeated at the
// end, where they are least likely to be diluted by what precedes them.

export const STUDIO_IMAGE_PROMPT = `You are retouching a photograph of a real piece of furniture for a product catalogue. The uploaded photograph is the single source of truth for what this product looks like. You are editing that photograph — you are not generating a new one.

WHAT TO CHANGE

1. Remove the factory, workshop or warehouse background completely, along with any clutter, tools, people, pallets, wiring, walls and floor markings around the product.
2. Place the product on a soft, warm-white studio background: a clean, gently graded seamless backdrop, very slightly warm rather than pure white, with no visible horizon line, no props, no text and no watermark.
3. Add one subtle, natural contact shadow beneath the product where it meets the ground, soft-edged and consistent with a single soft key light. It should give mild depth and weight. No hard drop shadow, no reflection, no mirrored floor.
4. Improve the photographic quality only: correct exposure, recover blown highlights and blocked shadows, neutralise colour casts from factory lighting, set an accurate white balance, and make the lighting even and flattering. Keep grain and noise low but natural.
5. Present the product centred in the frame, sized so it fills the frame comfortably with a small even margin of background around it. The complete product must be inside the frame — no part cropped, including feet, legs, arms and the top or back edge.

WHAT MUST NOT CHANGE

6. Preserve the product's construction and proportions exactly: silhouette, dimensions and the relationship between its parts.
7. Preserve every material and finish exactly: upholstery fabric and its weave, leather grain, wood species and grain direction, metal finish, polish, patina and any visible wear.
8. Preserve every detail of the build: stitching lines and their pattern, seams, tufting, buttons, piping, joints, screws, brackets, hinges, handles, castors, legs, arms, backrest, cushions and their exact number.
9. Preserve the product's colour. Correct the white balance of the photograph, but do not restyle, saturate or "improve" the colour of the product itself.
10. Do not add any part that is not in the photograph. Do not remove, straighten, tidy or repair any part that is. Do not replace the product, or any component of it, with a similar-looking design of your own. Do not smooth away texture, dents, creases or irregularities — this is a real object and must remain recognisably the same object.
11. Apply no beautification beyond honest photographic correction. The result must be usable as an accurate representation of the item BOE will ship.

VIEWING ANGLE

12. Keep the viewing direction of the uploaded photograph. BOE's preferred catalogue viewpoint is a natural front three-quarter view — front-dominant, one side visible, camera at about standing eye level, looking slightly down onto the seat or top surface — and you may move gently toward it ONLY when the photograph is already close to it.
13. If the photograph is a materially different view (straight-on front, side, back, top-down, or a low angle), keep that view. Do not rotate the product, do not re-stage the camera and do not invent any surface, panel or detail that the photograph does not show. An accurate image at the uploaded angle is worth more than the preferred angle with invented detail.
14. Mild straightening or perspective correction is allowed only where it needs no hidden detail to be imagined. If correcting the perspective would require inventing what is behind or beneath the product, leave the perspective as it is.

OUTPUT

A single square photographic image of the product on the warm-white studio background, framed as described above. Photographic realism only — no illustration, no render, no stylisation, no text, no logo, no border.`

/** The instruction is a constant, not a template: nothing from the request is
 *  interpolated into it. The only user-supplied value that reaches the provider
 *  is the image itself, so there is no text channel through which an upload
 *  could rewrite the rules above. */
export function buildStudioPrompt(): string {
  return STUDIO_IMAGE_PROMPT
}
