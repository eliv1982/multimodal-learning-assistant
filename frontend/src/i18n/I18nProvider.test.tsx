import { StrictMode, useEffect } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "./I18nProvider";
import type { Locale } from "./locale";
import { LOCALE_STORAGE_KEY } from "./storage";
import type { Translate } from "./translate";
import { useI18n } from "./useI18n";

/** Shows what the provider hands out; `onTranslator` sees each distinct translator once. */
function Probe({ onTranslator }: { onTranslator?: (t: Translate) => void }) {
  const { locale, setLocale, t } = useI18n();
  useEffect(() => {
    onTranslator?.(t);
  }, [t, onTranslator]);
  return (
    <div>
      <p data-testid="locale">{locale}</p>
      <p data-testid="text">{t("shell.signOut")}</p>
      <button type="button" onClick={() => setLocale("ru")}>
        to-ru
      </button>
      <button type="button" onClick={() => setLocale("en")}>
        to-en
      </button>
      <button type="button" onClick={() => setLocale("de" as Locale)}>
        to-invalid
      </button>
    </div>
  );
}

const locale = () => screen.getByTestId("locale").textContent;
const text = () => screen.getByTestId("text").textContent;
const setBrowserLanguages = (languages: string[]) =>
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(languages);

describe("I18nProvider: the initial language", () => {
  it("is English when nothing is stored and the browser does not ask for Russian", () => {
    render(<I18nProvider><Probe /></I18nProvider>);

    expect(locale()).toBe("en");
    expect(text()).toBe("Sign out");
    expect(document.documentElement.lang).toBe("en");
  });

  it("is a valid stored language, in preference to the browser's", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "ru");
    setBrowserLanguages(["en-US"]);

    render(<I18nProvider><Probe /></I18nProvider>);

    expect(locale()).toBe("ru");
    expect(text()).toBe("Выйти");
    expect(document.documentElement.lang).toBe("ru");
  });

  it("is the browser's language when nothing valid is stored, judged by the primary subtag", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "de");
    setBrowserLanguages(["de-DE", "ru-RU", "en"]);

    render(<I18nProvider><Probe /></I18nProvider>);

    expect(locale()).toBe("ru");
    expect(document.documentElement.lang).toBe("ru");
  });

  it("is English when the browser asks for nothing supported", () => {
    setBrowserLanguages(["de-DE", "fr"]);

    render(<I18nProvider><Probe /></I18nProvider>);

    expect(locale()).toBe("en");
  });

  it("stores nothing merely because it started up, whichever way the language was chosen", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    setBrowserLanguages(["ru-RU"]);

    render(<StrictMode><I18nProvider><Probe /></I18nProvider></StrictMode>);

    expect(locale()).toBe("ru");
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
});

describe("I18nProvider: switching", () => {
  it("changes the text and <html lang>, and remembers exactly the locale", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    render(<I18nProvider><Probe /></I18nProvider>);

    await user.click(screen.getByRole("button", { name: "to-ru" }));

    expect(locale()).toBe("ru");
    expect(text()).toBe("Выйти");
    expect(document.documentElement.lang).toBe("ru");
    expect(setItem.mock.calls).toEqual([[LOCALE_STORAGE_KEY, "ru"]]);
    expect(localStorage.length).toBe(1);

    await user.click(screen.getByRole("button", { name: "to-en" }));

    expect(locale()).toBe("en");
    expect(text()).toBe("Sign out");
    expect(document.documentElement.lang).toBe("en");
    expect(setItem.mock.calls).toEqual([
      [LOCALE_STORAGE_KEY, "ru"],
      [LOCALE_STORAGE_KEY, "en"],
    ]);
    expect(localStorage.length).toBe(1);
  });

  it("writes once per switch, even under StrictMode", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    render(<StrictMode><I18nProvider><Probe /></I18nProvider></StrictMode>);

    await user.click(screen.getByRole("button", { name: "to-ru" }));

    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it("ignores a value that is not a supported language: nothing changes and nothing is stored", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    render(<I18nProvider><Probe /></I18nProvider>);

    await user.click(screen.getByRole("button", { name: "to-invalid" }));

    expect(locale()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(setItem).not.toHaveBeenCalled();
  });

  it("switches even when storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const user = userEvent.setup();
    render(<I18nProvider><Probe /></I18nProvider>);

    await user.click(screen.getByRole("button", { name: "to-ru" }));

    expect(locale()).toBe("ru");
    expect(text()).toBe("Выйти");
    expect(document.documentElement.lang).toBe("ru");
  });

  it("keeps the same translator between renders until the language changes", async () => {
    const user = userEvent.setup();
    const seen = vi.fn<(t: Translate) => void>();
    const view = render(<I18nProvider><Probe onTranslator={seen} /></I18nProvider>);
    expect(seen).toHaveBeenCalledTimes(1);

    view.rerender(<I18nProvider><Probe onTranslator={seen} /></I18nProvider>);
    expect(seen).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "to-ru" }));
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen.mock.calls[1]?.[0]).not.toBe(seen.mock.calls[0]?.[0]);
  });

  it("does not remount what it wraps when the language changes", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <input aria-label="draft" />
        <Probe />
      </I18nProvider>,
    );
    const draft = screen.getByLabelText("draft");
    await user.type(draft, "kept");

    await user.click(screen.getByRole("button", { name: "to-ru" }));

    expect(screen.getByLabelText<HTMLInputElement>("draft")).toBe(draft);
    expect(screen.getByLabelText<HTMLInputElement>("draft").value).toBe("kept");
  });
});

describe("useI18n without a provider", () => {
  it("is English, and switching does nothing rather than throwing", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    render(<Probe />);

    await user.click(screen.getByRole("button", { name: "to-ru" }));

    expect(locale()).toBe("en");
    expect(text()).toBe("Sign out");
    expect(setItem).not.toHaveBeenCalled();
  });
});
