import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { DEFAULT_LOCALE, browserLanguages, detectLocale, isLocale, type Locale } from "./locale";
import { readStoredLocale, writeStoredLocale } from "./storage";
import { translatorFor, type Translate } from "./translate";

export interface I18nContextValue {
  locale: Locale;
  /** Switches the interface language and remembers the choice (the locale, nothing else). */
  setLocale: (locale: Locale) => void;
  t: Translate;
}

/**
 * Without a provider (a component rendered on its own) the interface is English
 * and switching does nothing. The application always mounts the provider.
 */
export const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => undefined,
  t: translatorFor(DEFAULT_LOCALE),
});

/**
 * Owns the interface language: the initial choice is the stored one, else the
 * browser's, else English. Only an explicit switch is written to storage, so
 * merely opening the application persists nothing.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectLocale(readStoredLocale(), browserLanguages()));

  const setLocale = useCallback((next: Locale) => {
    if (!isLocale(next)) {
      return;
    }
    setLocaleState(next);
    writeStoredLocale(next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t: translatorFor(locale) }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
