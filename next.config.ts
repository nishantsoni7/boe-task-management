import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  // PDFKit loads font/AFM files via fs.readFileSync relative to its own module
  // directory. Bundling it breaks those paths. Mark it external so Next.js
  // leaves it as a node_modules require at runtime.
  serverExternalPackages: ['pdfkit'],
};

export default nextConfig;