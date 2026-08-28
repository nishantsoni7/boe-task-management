import type { NextConfig } from "next";
import { imageRemotePatterns, PREVIEW_QUALITY, THUMB_QUALITY } from "./src/lib/imageHosts";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  // PDFKit loads font/AFM files via fs.readFileSync relative to its own module
  // directory. Bundling it breaks those paths. Mark it external so Next.js
  // leaves it as a node_modules require at runtime.
  serverExternalPackages: ['pdfkit'],

  // The Image Editor's approved studio reference is read from disk at request
  // time and sent to Bria as `ref_image_url`. It is deliberately NOT in
  // `public/` — nothing in a browser needs it — so Next has no way to know the
  // server depends on it, and without this line it is left out of a deployment
  // and every studio generation fails with "reference not installed".
  outputFileTracingIncludes: {
    '/api/image-editor/studio': ['./assets/image-editor/**'],
  },

  images: {
    // Showroom product images are pasted URLs rather than uploads, so the hosts
    // the optimizer may fetch from are an explicit allowlist — see
    // src/lib/imageHosts.ts, which also decides, on the client, whether a given
    // URL may be sent to the optimizer. Both halves read the same values, so
    // they cannot disagree and produce a 400.
    //
    // In practice that list is BOE's own site, where every stored product image
    // lives; NEXT_PUBLIC_SHOWROOM_IMAGE_HOSTS extends it. A host that is not on
    // it is not broken — the thumbnail simply loads the original, as before.
    remotePatterns: imageRemotePatterns(),

    // Required from Next 16: a quality not on this list is refused with a 400.
    // 35 is what list thumbnails ask for, 55 the edit-page preview; 75 is Next's
    // default, kept so an ordinary <Image> elsewhere still works.
    qualities: [THUMB_QUALITY, PREVIEW_QUALITY, 75],

    // A resized thumbnail is derived from an immutable original, so re-deriving
    // it hourly buys nothing. 31 days keeps repeat visits and page-to-page
    // returns on cache instead of re-downloading and re-encoding.
    minimumCacheTTL: 2678400,
  },
};

export default nextConfig;