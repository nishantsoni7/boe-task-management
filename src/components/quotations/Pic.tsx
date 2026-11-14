// A product picture from the public quotation-images bucket. A plain <img>: next/image would re-host every
// client-facing picture through the image optimiser, and the client link must show the stored file as it is.
export function Pic({ src, alt, className, lazy }: { src: string; alt: string; className?: string; lazy?: boolean }) {
  // eslint-disable-next-line @next/next/no-img-element -- see above
  return <img className={className} src={src} alt={alt} loading={lazy ? 'lazy' : undefined} decoding={lazy ? 'async' : undefined} />
}
