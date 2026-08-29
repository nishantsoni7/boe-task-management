# Image Editor — approved studio reference

`studio-reference.png` is the studio look BOE approved: the background, the
lighting and the shadows of the accepted Bria Product Shot result. It is sent to
Bria as `ref_image_url` on every studio generation, so it is what keeps results
consistent with the approved standard.

**It is deliberately not in `public/`.** Nothing in a browser needs it; the only
reader is the server, on its way to fal, and it travels as a data URI so no
publicly reachable URL for it is ever created.

## How production gets it

**This file is `.gitignore`d, so a deployment built from a git clone does not
have it.** Verified by exporting `HEAD` to a clean tree: only this README is
there, and the loader returns `missing`. Relying on the local file alone means
every generation in production fails with "reference not installed".

So the server tries two sources, in order:

1. **This file**, shipped by `outputFileTracingIncludes` in `next.config.ts` to
   any deployment whose build tree contains it. That covers local development.
2. **A private Supabase Storage bucket**, downloaded server-side with the
   service-role key the app already holds. That is what serves production.

### Provisioning the deployment (once)

1. In the Supabase dashboard, **Storage → New bucket**, name `image-editor`, and
   leave **Public bucket OFF**. A public bucket would give the reference a
   publicly reachable URL, which is the thing keeping it out of `public/` was
   for.
2. Upload the approved PNG into that bucket as `studio-reference.png`.
3. No new Vercel environment variable is required: the loader uses
   `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, both already set.
   Set `IMAGE_EDITOR_REFERENCE_BUCKET` only if a project needs a different
   bucket name.

No storage policy is needed — the service-role key bypasses row-level security,
which is why the bucket can stay private.

## Replacing it

Only with a reference the product owner has approved. Do not substitute a
regenerated or look-alike image: a plausible studio picture that is not the
approved one produces results nobody can tell apart from approved ones, which is
worse than a visible failure. With the file missing the route reports that it is
missing and generates nothing.
