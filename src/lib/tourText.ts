// Text for the first-visit tour (English and Kannada) and the customer's language choice. {0}, {1} ... are filled in by tt().
export type TourLang = 'en' | 'kn';
const LANG_KEY = 'sndmart-tiffin-lang';

export const TOUR_TEXT: Record<TourLang, Record<string, string>> = {
  en: {
    tourSkip: "Skip",
    tourNext: "Next",
    tourStart: "Start shopping",
    tourWelcomeT: "Welcome to Sndmart",
    tourWelcomeB: "Fresh groceries and hot food from local hotels, delivered to your door in Sindhanur.",
    tourWaT: "Help on WhatsApp",
    tourWaB: "Track your order, report a problem or talk to our team in a WhatsApp chat.",
    tourRewardsT: "Rewards and savings",
    tourRewardsB: "Scratch cards, cashback in your wallet and Refer & Earn: the more you order, the more you save.",
    tourProfileTitle: "App tour",
    tourProfileSub: "See what is new in Sndmart",
    tourHelperT: "New: Quick Helper",
    tourHelperB: "Need a hand for a short while? Book a nearby helper for 30, 60 or 90 minutes and pay only for the time you use.",
    tourTryHelper: "Try Quick Helper",
  },
  kn: {
    tourSkip: "ಬಿಟ್ಟುಬಿಡಿ",
    tourNext: "ಮುಂದೆ",
    tourStart: "ಶಾಪಿಂಗ್ ಶುರು ಮಾಡಿ",
    tourWelcomeT: "Sndmart ಗೆ ಸ್ವಾಗತ",
    tourWelcomeB: "ಸಿಂಧನೂರಿನಲ್ಲಿ ತಾಜಾ ದಿನಸಿ ಮತ್ತು ಸ್ಥಳೀಯ ಹೋಟೆಲ್‌ಗಳ ಬಿಸಿ ಊಟ ನಿಮ್ಮ ಮನೆ ಬಾಗಿಲಿಗೆ ತಲುಪುತ್ತದೆ.",
    tourWaT: "WhatsApp ನಲ್ಲಿ ಸಹಾಯ",
    tourWaB: "ಆರ್ಡರ್ ಟ್ರ್ಯಾಕ್ ಮಾಡಿ, ಸಮಸ್ಯೆ ತಿಳಿಸಿ ಅಥವಾ ನಮ್ಮ ತಂಡದೊಂದಿಗೆ WhatsApp ಚಾಟ್‌ನಲ್ಲಿ ಮಾತನಾಡಿ.",
    tourRewardsT: "ಬಹುಮಾನ ಮತ್ತು ಉಳಿತಾಯ",
    tourRewardsB: "ಸ್ಕ್ರ್ಯಾಚ್ ಕಾರ್ಡ್, ವಾಲೆಟ್‌ನಲ್ಲಿ ಕ್ಯಾಶ್‌ಬ್ಯಾಕ್ ಮತ್ತು ರೆಫರ್ & ಅರ್ನ್: ಹೆಚ್ಚು ಆರ್ಡರ್ ಮಾಡಿದಷ್ಟೂ ಹೆಚ್ಚು ಉಳಿತಾಯ.",
    tourProfileTitle: "ಆ್ಯಪ್ ಟೂರ್",
    tourProfileSub: "Sndmart ನಲ್ಲಿ ಹೊಸದೇನಿದೆ ನೋಡಿ",
    tourHelperT: "ಹೊಸದು: ಕ್ವಿಕ್ ಹೆಲ್ಪರ್",
    tourHelperB: "ಸ್ವಲ್ಪ ಹೊತ್ತು ಸಹಾಯ ಬೇಕೇ? 30, 60 ಅಥವಾ 90 ನಿಮಿಷಗಳಿಗೆ ಹತ್ತಿರದ ಸಹಾಯಕರನ್ನು ಬುಕ್ ಮಾಡಿ, ಬಳಸಿದ ಸಮಯಕ್ಕೆ ಮಾತ್ರ ಪಾವತಿಸಿ.",
    tourTryHelper: "ಕ್ವಿಕ್ ಹೆಲ್ಪರ್ ನೋಡಿ",
  },
};

/** Kannada when the phone is set to Kannada, otherwise English; the customer's own choice always wins. */
export function initialTourLang(): TourLang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'en' || saved === 'kn') return saved;
  } catch {
    /* storage can be blocked */
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('kn') ? 'kn' : 'en';
}

export function saveTourLang(lang: TourLang) {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* storage can be blocked */
  }
}

export function tt(lang: TourLang, key: string): string {
  return TOUR_TEXT[lang][key] ?? TOUR_TEXT.en[key] ?? key;
}
