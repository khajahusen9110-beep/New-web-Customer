import { useEffect, useRef, useState } from 'react';
import type { PromoBanner } from '../lib/types';
import { fallbackToOriginal, imageSrcSet, resizedImage } from '../lib/images';

const AUTO_MS = 4000;

/**
 * Super-Admin banners: swipeable, auto-advancing every 4 s (paused while touched or hovered),
 * with dots. Text is written over the image unless the admin turned that off.
 */
export function PromoCarousel({ banners, onOpen }: { banners: PromoBanner[]; onOpen: (b: PromoBanner) => void }) {
  const track = useRef<HTMLDivElement | null>(null);
  const [index, setIndex] = useState(0);
  const paused = useRef(false);

  // Follow manual swipes.
  const onScroll = () => {
    const el = track.current;
    if (!el || !el.clientWidth) return;
    setIndex(Math.round(el.scrollLeft / el.clientWidth));
  };

  const goTo = (i: number) => {
    const el = track.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  };

  useEffect(() => {
    if (banners.length < 2) return;
    const t = setInterval(() => {
      if (paused.current || document.hidden) return;
      const el = track.current;
      if (!el) return;
      const next = (Math.round(el.scrollLeft / el.clientWidth) + 1) % banners.length;
      el.scrollTo({ left: next * el.clientWidth, behavior: next === 0 ? 'auto' : 'smooth' });
    }, AUTO_MS);
    return () => clearInterval(t);
  }, [banners.length]);

  if (!banners.length) return null;
  return (
    <section className="promo-carousel" aria-roledescription="carousel" aria-label="Offers">
      <div
        ref={track}
        className="promo-track"
        onScroll={onScroll}
        onPointerEnter={() => (paused.current = true)}
        onPointerLeave={() => (paused.current = false)}
        onTouchStart={() => (paused.current = true)}
        onTouchEnd={() => (paused.current = false)}
      >
        {banners.map((b, i) => {
          const clickable = b.link_type !== 'none' && !!b.link_value;
          const hasText = b.show_text && (b.title || b.subtitle || (clickable && b.cta_text));
          return (
            <div
              key={b.id}
              className={`promo-slide${clickable ? ' clickable' : ''}`}
              role={clickable ? 'link' : undefined}
              tabIndex={clickable ? 0 : undefined}
              aria-label={b.title || b.subtitle || 'Offer'}
              onClick={() => clickable && onOpen(b)}
              onKeyDown={(e) => clickable && (e.key === 'Enter' || e.key === ' ') && onOpen(b)}
            >
              <img
                src={resizedImage(b.image_url, 640)}
                srcSet={imageSrcSet(b.image_url, 640)}
                alt={hasText ? '' : b.title || 'Offer'}
                loading={i === 0 ? 'eager' : 'lazy'}
                decoding="async"
                onError={fallbackToOriginal(b.image_url)}
              />
              {hasText && (
                <div className="promo-text">
                  {b.title && <div className="promo-title">{b.title}</div>}
                  {b.subtitle && <div className="promo-sub">{b.subtitle}</div>}
                  {clickable && b.cta_text && <span className="promo-cta">{b.cta_text}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {banners.length > 1 && (
        <div className="promo-dots">
          {banners.map((b, i) => (
            <button key={b.id} aria-label={`Offer ${i + 1}`} className={i === index ? 'active' : ''} onClick={() => goTo(i)} />
          ))}
        </div>
      )}
    </section>
  );
}
