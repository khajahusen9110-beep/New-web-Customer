import { useEffect, useState } from 'react';
import { useSession } from '../store/session';
import { getThemeColors, getBannerImages, type CityBannerImages } from './repository';

const CSS_VAR_BY_KEY: Record<string, string> = {
  foodPromoColorStart: '--food-promo-start',
  foodPromoColorEnd: '--food-promo-end',
  groceryBannerColorStart: '--grocery-banner-start',
  groceryBannerColorEnd: '--grocery-banner-end',
  soldBadgeColorStart: '--sold-badge-start',
  soldBadgeColorEnd: '--sold-badge-end',
  oceanColor: '--ocean',
};

/**
 * Applies this city's admin-configured accent colors (food promo, grocery banner,
 * sold badge, ocean/link color) as CSS variables on the document root. Mounted once
 * near the app root so every page picks up the override without prop drilling.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const cityId = useSession((s) => s.selectedCity?.id ?? '');

  useEffect(() => {
    if (!cityId) return;
    let cancelled = false;
    getThemeColors(cityId).then((colors) => {
      if (cancelled) return;
      const colorMap = colors as unknown as Record<string, string>;
      for (const [key, cssVar] of Object.entries(CSS_VAR_BY_KEY)) {
        const value = colorMap[key];
        if (value) document.documentElement.style.setProperty(cssVar, value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [cityId]);

  return children as React.ReactElement;
}

const EMPTY_BANNER_IMAGES: CityBannerImages = {
  offerBannerGroceryImageUrl: null,
  offerBannerFoodImageUrl: null,
  dealsBannerImageUrl: null,
  foodPromoBannerImageUrl: null,
};

/** This city's admin-uploaded background photos for OfferBanner/DealsBanner/FoodPromoBanner, if any. */
export function useBannerImages(): CityBannerImages {
  const cityId = useSession((s) => s.selectedCity?.id ?? '');
  const [images, setImages] = useState<CityBannerImages>(EMPTY_BANNER_IMAGES);

  useEffect(() => {
    if (!cityId) return;
    let cancelled = false;
    getBannerImages(cityId).then((v) => {
      if (!cancelled) setImages(v);
    });
    return () => {
      cancelled = true;
    };
  }, [cityId]);

  return images;
}
