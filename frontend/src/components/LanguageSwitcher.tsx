import { useI18n } from "../i18n/useI18n";
import { LOCALES, type Locale } from "../i18n/locale";

/** Each language is named in itself, so it can be found whichever language is showing now. */
const ENDONYMS: Readonly<Record<Locale, string>> = { en: "English", ru: "Русский" };

/** Two toggle buttons; the pressed one is the interface language. Shown on every screen. */
export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();

  return (
    <div className="language-switcher" role="group" aria-label={t("language.label")}>
      {LOCALES.map((option) => (
        <button
          key={option}
          type="button"
          lang={option}
          className="language-option"
          aria-pressed={option === locale}
          onClick={() => setLocale(option)}
        >
          {ENDONYMS[option]}
        </button>
      ))}
    </div>
  );
}
