/**
 * Small, fast images from Supabase Storage.
 *
 * Product photos are 100-300 KB and hotel banners more at full size. Two optional resizers
 * serve them 10-30x smaller as WebP; only a few fixed widths are used so the CDN cache is shared:
 *  - Cloudflare Image Transformations on this site's own domain (/cdn-cgi/image/...). Used
 *    automatically once a one-time probe sees it is switched on for the zone.
 *  - Supabase image transformation (Pro plan), only when VITE_IMAGE_TRANSFORM=true.
 * With neither available the original URL is used directly — never a request that is known
 * to fail first (that doubled every image load).
 */
const SUPABASE_RESIZE = (import.meta.env.VITE_IMAGE_TRANSFORM as string | undefined)?.trim().toLowerCase() === 'true';
const OBJECT_PATH = '/storage/v1/object/public/';
const RENDER_PATH = '/storage/v1/render/image/public/';
export const IMAGE_WIDTHS = [160, 320, 480, 800, 1200] as const;

const CF_FLAG = 'sndmart-img-cf';
const CF_RECHECK_MS = 24 * 3600e3;
function readCfFlag(): { on: boolean; at: number } | null {
  try {
    return JSON.parse(localStorage.getItem(CF_FLAG) ?? 'null') as { on: boolean; at: number } | null;
  } catch {
    return null;
  }
}
const cfFlag = readCfFlag();
const CF_RESIZE = cfFlag?.on === true;

/** Once a day: does this domain resize images? The answer applies from the next page load. */
export function probeImageResizing() {
  if (typeof window === 'undefined' || !/^https:/.test(location.protocol)) return;
  if (cfFlag && Date.now() - cfFlag.at < CF_RECHECK_MS) return;
  const save = (on: boolean) => {
    try {
      localStorage.setItem(CF_FLAG, JSON.stringify({ on, at: Date.now() }));
    } catch {
      /* ignore */
    }
  };
  const img = new Image();
  img.onload = () => save(img.naturalWidth > 0 && img.naturalWidth <= 32);
  img.onerror = () => save(false);
  img.src = `/cdn-cgi/image/width=16,format=auto/${location.origin}/icon-192.png`;
}

const resizable = (url: string) => (CF_RESIZE || SUPABASE_RESIZE) && url.includes(OBJECT_PATH) && !url.includes('?');

/** Resized URL for a Supabase public image, or the url unchanged for anything else. */
export function resizedImage(url: string, width: number, quality = 70): string {
  if (!resizable(url)) return url;
  const w = IMAGE_WIDTHS.find((x) => x >= width) ?? IMAGE_WIDTHS[IMAGE_WIDTHS.length - 1];
  if (CF_RESIZE) return `/cdn-cgi/image/width=${w},quality=${quality},format=auto,fit=scale-down/${url}`;
  return `${url.replace(OBJECT_PATH, RENDER_PATH)}?width=${w}&quality=${quality}&resize=contain`;
}

/** srcset for an image shown at about `cssWidth` CSS pixels (1x and 2x screens). */
export function imageSrcSet(url: string, cssWidth: number): string | undefined {
  if (!resizable(url)) return undefined;
  const w1 = resizedImage(url, cssWidth);
  const w2 = resizedImage(url, cssWidth * 2);
  return w1 === w2 ? undefined : `${w1} 1x, ${w2} 2x`;
}

/** onError handler: falls back to the original image once if the resized one cannot load. */
export function fallbackToOriginal(original: string) {
  return (e: { currentTarget: HTMLImageElement }) => {
    const img = e.currentTarget;
    if (img.dataset.fallback) {
      // The original is missing too: hide it so the tile's own background shows instead of
      // the browser's broken-image icon.
      img.style.visibility = 'hidden';
      return;
    }
    img.dataset.fallback = '1';
    img.removeAttribute('srcset');
    img.src = original;
  };
}
