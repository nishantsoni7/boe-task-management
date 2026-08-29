# Image Editor — approved studio reference

`studio-reference.png` is the studio look BOE approved: the background, the
lighting and the shadows of the accepted Bria Product Shot result. It is sent to
Bria as `ref_image_url` on every studio generation, so it is what keeps results
consistent with the approved standard.

**It is deliberately not in `public/`.** Nothing in a browser needs it; the only
reader is the server, on its way to fal, and it travels as a data URI so no
publicly reachable URL for it is ever created. `outputFileTracingIncludes` in
`next.config.ts` is what puts it into a deployment.

## Replacing it

Only with a reference the product owner has approved. Do not substitute a
regenerated or look-alike image: a plausible studio picture that is not the
approved one produces results nobody can tell apart from approved ones, which is
worse than a visible failure. With the file missing the route reports that it is
missing and generates nothing.
