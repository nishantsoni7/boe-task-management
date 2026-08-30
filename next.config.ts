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
  // whose build tree contains it.
  //
  // This is NOT sufficient on its own: the reference is gitignored, so a build
  // from a git clone has nothing for this to trace. Production is served by the
  // private Supabase Storage bucket instead — see studioReference.ts.
  //
  // SHARP'S NATIVE LIBRARY, WHICH THE TRACER CANNOT SEE
  // ---------------------------------------------------
  // `sharp` is on Next's default externals list, so it is required from
  // node_modules at runtime rather than bundled, and file tracing decides what
  // ships. Tracing follows `require`/`import` — and the binding
  // `@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.2.node` does NOT require its
  // library. It declares `NEEDED: libvips-cpp.so.8.18.3` in its ELF header and
  // finds it through an RPATH of `$ORIGIN/../../sharp-libvips-linux-x64/lib`.
  // That is the dynamic linker's business, invisible to a JavaScript tracer.
  //
  // So the trace shipped the binding, the libvips package.json, its index.js
  // and its stub.node — and left the 18 MB .so behind. Production loaded the
  // binding, dlopen failed, and the function died before any handler ran:
  //
  //     Could not load sharp using linux-x64
  //     ERR_DLOPEN_FAILED: libvips-cpp.so.8.18.3: cannot open shared object file
  //
  // Naming the directory here is what puts it in the bundle. Every route that
  // reaches sharp needs it, not just the Image Editor: the two document routes
  // below carry the same defect and would fail the same way.
  //
  // glibc only. Vercel's Node runtime is Amazon Linux; if it ever moves to
  // musl, add `sharp-libvips-linuxmusl-x64` alongside.
  outputFileTracingIncludes: {
    '/api/image-editor/studio': [
      './assets/image-editor/**',
      './node_modules/@img/sharp-libvips-linux-x64/**/*',
    ],
    '/api/image-editor/convert': ['./node_modules/@img/sharp-libvips-linux-x64/**/*'],
    '/api/orders/\\[id\\]/documents': ['./node_modules/@img/sharp-libvips-linux-x64/**/*'],
    '/api/showroom/quotation/\\[id\\]': ['./node_modules/@img/sharp-libvips-linux-x64/**/*'],
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