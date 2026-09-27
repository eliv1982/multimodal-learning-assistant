import { isLocale, type Locale } from "./locale";

/*
 * The one place the application touches browser storage, and the one thing it
 * keeps there: the interface language, "en" or "ru". It is not sensitive.
 * Nothing else (authentication, session, user, documents, chat) may ever be
 * stored client-side.
 *
 * sourcePolicy.test.ts pins this file to exactly the two calls below; the lint
 * rule that bans browser storage is relaxed for this file alone. Every access is
 * guarded (storage can be unavailable or throw) and every value is validated.
 */
export const LOCALE_STORAGE_KEY = "mla.locale";

/** The stored locale, or null when there is none, it is not "en"/"ru", or storage is unavailable. */
export function readStoredLocale(): Locale | null {
  try {
    const value = localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

/** Remembers the locale; silently does nothing when storage is unavailable. */
export function writeStoredLocale(locale: Locale): void {
  if (!isLocale(locale)) {
    return;
  }
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // The choice then only lasts for this page load.
  }
}
