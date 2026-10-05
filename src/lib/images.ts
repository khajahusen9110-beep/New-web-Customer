/**
 * Small, fast images from Supabase Storage.
 *
 * Product photos are ~100 KB and hotel banners up to several MB at full size. Supabase's image
 * transformation (Pro plan) serves them resized and as WebP/AVIF from its CDN, usually 5-20x
 * smaller. Only a few fixed widths are used so the CDN cache is shared by every customer.
 * Turn it off with VITE_IMAGE_TRANSFORM=false; if a resized image fails, the original is used.
 */
const ENABLED = (import.meta.env.VITE_IMAGE_TRANSFORM as string | undefined)?.trim().toLowerCase() !== 'false';
const OBJECT_PATH = '/storage/v1/object/public/';
const RENDER_PATH = '/storage/v1/render/image/public/';
export const IMAGE_WIDTHS = [160, 320, 480, 800, 1200] as const;

/** Resized URL for a Supabase public image, or the url unchanged for anything else. */
export function resizedImage(url: string, width: number, quality = 70): string {
  if (!ENABLED || !url.includes(OBJECT_PATH)) return url;
  const w = IMAGE_WIDTHS.find((x) => x >= width) ?? IMAGE_WIDTHS[IMAGE_WIDTHS.length - 1];
  const [base, query] = url.split('?');
  if (query) return url; // already has parameters (signed or custom): leave alone
  return `${base.replace(OBJECT_PATH, RENDER_PATH)}?width=${w}&quality=${quality}&resize=contain`;
}

/** srcset for an image shown at about `cssWidth` CSS pixels (1x and 2x screens). */
export function imageSrcSet(url: string, cssWidth: number): string | undefined {
  if (!ENABLED || !url.includes(OBJECT_PATH) || url.includes('?')) return undefined;
  const w1 = resizedImage(url, cssWidth);
  const w2 = resizedImage(url, cssWidth * 2);
  return w1 === w2 ? undefined : `${w1} 1x, ${w2} 2x`;
}

/** onError handler: falls back to the original image once if the resized one cannot load. */
export function fallbackToOriginal(original: string) {
  return (e: { currentTarget: HTMLImageElement }) => {
    const img = e.currentTarget;
    if (img.dataset.fallback) return;
    img.dataset.fallback = '1';
    img.removeAttribute('srcset');
    img.src = original;
  };
}
