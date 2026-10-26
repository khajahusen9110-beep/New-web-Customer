import type { LocalAd } from '../lib/types';
import { openLocalAdLink } from '../lib/repository';
import { fallbackToOriginal, imageSrcSet, resizedImage } from '../lib/images';

/**
 * Paid banners from local businesses (table local_ads, managed by the city's own City Admin).
 * Separate from PromoCarousel (Sndmart's own offers): shows a small "Ad" tag for transparency,
 * and only opens a link when the admin marked it Clickable.
 */
export function LocalAdStrip({ ads }: { ads: LocalAd[] }) {
  if (!ads.length) return null;
  return (
    <section className="local-ad-strip" aria-label="Local ads">
      {ads.map((ad) => {
        const clickable = ad.ad_type === 'clickable' && !!ad.link_value;
        return (
          <div
            key={ad.id}
            className={`local-ad-card${clickable ? ' clickable' : ''}`}
            role={clickable ? 'link' : undefined}
            tabIndex={clickable ? 0 : undefined}
            aria-label={ad.advertiser_name}
            onClick={() => clickable && openLocalAdLink(ad)}
            onKeyDown={(e) => clickable && (e.key === 'Enter' || e.key === ' ') && openLocalAdLink(ad)}
          >
            <img
              src={resizedImage(ad.image_url, 640)}
              srcSet={imageSrcSet(ad.image_url, 640)}
              alt={ad.advertiser_name}
              loading="lazy"
              decoding="async"
              onError={fallbackToOriginal(ad.image_url)}
            />
            <span className="local-ad-tag">Ad</span>
          </div>
        );
      })}
    </section>
  );
}
