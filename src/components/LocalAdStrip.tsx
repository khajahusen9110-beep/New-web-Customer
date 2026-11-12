import { MessageCircle, Phone, MapPinned, ExternalLink } from 'lucide-react';
import type { LocalAd } from '../lib/types';
import { openLocalAdLink } from '../lib/repository';
import { fallbackToOriginal, imageSrcSet, resizedImage } from '../lib/images';

// CTA button look + label per link type — WhatsApp gets its own green brand style,
// everything else (website/map) reads "Visit Now", Call gets "Call Now".
const CTA_META: Record<string, { label: string; icon: typeof MessageCircle; className: string }> = {
  whatsapp: { label: 'WhatsApp', icon: MessageCircle, className: 'local-ad-cta-whatsapp' },
  call: { label: 'Call Now', icon: Phone, className: 'local-ad-cta-call' },
  map: { label: 'Visit Now', icon: MapPinned, className: 'local-ad-cta-visit' },
  website: { label: 'Visit Now', icon: ExternalLink, className: 'local-ad-cta-visit' },
};

/**
 * Paid banners from local businesses (table local_ads, managed by the city's own City Admin).
 * Separate from PromoCarousel (Sndmart's own offers): shows a small "Sponsored" tag for transparency.
 * Media is either a photo or a short (<=15s) looping video, never both — admin picks one.
 * A clickable ad gets a CTA pill overlaid on the media itself (WhatsApp / Call / Visit Now), like a
 * native social-feed ad, instead of a separate bar below — keeps the card as one cohesive unit.
 */
export function LocalAdStrip({ ads }: { ads: LocalAd[] }) {
  if (!ads.length) return null;
  return (
    <section className="local-ad-strip" aria-label="Local ads">
      {ads.map((ad) => {
        const clickable = ad.ad_type === 'clickable' && !!ad.link_value;
        const cta = ad.link_type ? CTA_META[ad.link_type] : null;
        const isVideo = ad.media_type === 'video' && !!ad.video_url;
        return (
          <div key={ad.id} className="local-ad-card">
            <div className="local-ad-media">
              {isVideo ? (
                <video src={ad.video_url!} autoPlay loop muted playsInline />
              ) : (
                <img
                  src={resizedImage(ad.image_url ?? '', 640)}
                  srcSet={imageSrcSet(ad.image_url ?? '', 640)}
                  alt={ad.advertiser_name}
                  loading="lazy"
                  decoding="async"
                  onError={fallbackToOriginal(ad.image_url ?? '')}
                />
              )}
              <span className="local-ad-tag">Sponsored</span>
              <div className="local-ad-overlay">
                <span className="local-ad-advertiser">{ad.advertiser_name}</span>
                {clickable && cta && (
                  <button type="button" className={`local-ad-cta ${cta.className}`} onClick={() => openLocalAdLink(ad)}>
                    <cta.icon size={14} />
                    {cta.label}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </section>
  );
}
