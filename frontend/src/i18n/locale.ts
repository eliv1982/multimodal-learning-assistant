export const LOCALES = ["en", "ru"] as const;

export type Locale = (typeof LOCALES)[number];

/** English is the source-of-truth and the fallback locale. */
export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * The supported locale for a BCP 47 language tag such as "ru", "ru-RU" or
 * "en-GB", judged by its primary subtag alone; null for anything else.
 */
export function localeFromLanguageTag(tag: string): Locale | null {
  const primary = tag.split(/[-_]/, 1)[0]?.toLowerCase() ?? "";
  return isLocale(primary) ? primary : null;
}

/**
 * The initial locale:
 * 1. a valid stored value (exactly "en" or "ru");
 * 2. the first browser language with a supported primary subtag;
 * 3. English.
 */
export function detectLocale(stored: string | null, languages: readonly string[]): Locale {
  if (isLocale(stored)) {
    return stored;
  }
  for (const tag of languages) {
    const locale = localeFromLanguageTag(tag);
    if (locale !== null) {
      return locale;
    }
  }
  return DEFAULT_LOCALE;
}

/** The browser's preferred languages, most preferred first; empty when unavailable. */
export function browserLanguages(): readonly string[] {
  try {
    const languages = navigator.languages as readonly string[] | undefined;
    if (languages !== undefined && languages.length > 0) {
      return languages;
    }
    const language = navigator.language as string | undefined;
    return language === undefined || language === "" ? [] : [language];
  } catch {
    return [];
  }
}
