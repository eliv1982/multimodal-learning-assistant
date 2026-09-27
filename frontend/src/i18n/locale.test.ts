import { describe, expect, it, vi } from "vitest";

import { DEFAULT_LOCALE, LOCALES, browserLanguages, detectLocale, isLocale, localeFromLanguageTag } from "./locale";

describe("the supported locales", () => {
  it("are exactly English and Russian, with English the default", () => {
    expect([...LOCALES]).toEqual(["en", "ru"]);
    expect(DEFAULT_LOCALE).toBe("en");
  });
});

describe("isLocale", () => {
  it.each(["en", "ru"])("accepts %j", (value) => {
    expect(isLocale(value)).toBe(true);
  });

  it.each(["EN", "Ru", "de", "en-US", "ru-RU", "", " en", "en ", "english", "русский", "null", "undefined", "__proto__"])(
    "rejects the string %j",
    (value) => {
      expect(isLocale(value)).toBe(false);
    },
  );

  it.each([null, undefined, 0, 1, true, {}, ["en"], () => "en", Symbol("en")])("rejects the non-string %s", (value) => {
    expect(isLocale(value)).toBe(false);
  });
});

describe("localeFromLanguageTag", () => {
  it.each([
    ["en", "en"],
    ["ru", "ru"],
    ["en-US", "en"],
    ["en-GB", "en"],
    ["ru-RU", "ru"],
    ["ru-UA", "ru"],
    ["RU", "ru"],
    ["Ru-ru", "ru"],
    ["EN-us", "en"],
    ["ru_RU", "ru"],
  ])("maps %j to %j by its primary subtag", (tag, expected) => {
    expect(localeFromLanguageTag(tag)).toBe(expected);
  });

  it.each(["de", "de-DE", "fr-CA", "zh-Hans-CN", "es-419", "", "-", "-ru", "e", "eng", "russian", "x-ru", "*", "und"])(
    "does not support %j",
    (tag) => {
      expect(localeFromLanguageTag(tag)).toBeNull();
    },
  );
});

describe("detectLocale", () => {
  it.each(["en", "ru"] as const)("uses a valid stored %j over anything the browser prefers", (stored) => {
    expect(detectLocale(stored, ["ru-RU", "en"])).toBe(stored);
    expect(detectLocale(stored, ["en-US"])).toBe(stored);
    expect(detectLocale(stored, [])).toBe(stored);
  });

  it.each(["de", "EN", "RU", "en-US", "ru ", "", "null", '{"locale":"ru"}', "русский", "undefined"])(
    "ignores the invalid stored value %j and falls back to the browser's language",
    (stored) => {
      expect(detectLocale(stored, ["ru-RU", "en"])).toBe("ru");
      expect(detectLocale(stored, ["en-GB"])).toBe("en");
      expect(detectLocale(stored, ["de"])).toBe("en");
    },
  );

  it("falls back to the browser's language when nothing is stored", () => {
    expect(detectLocale(null, ["ru-RU"])).toBe("ru");
    expect(detectLocale(null, ["en-US"])).toBe("en");
  });

  it("takes the first browser language that has a supported primary subtag, in order", () => {
    expect(detectLocale(null, ["de-DE", "ru", "en"])).toBe("ru");
    expect(detectLocale(null, ["fr", "en-GB", "ru-RU"])).toBe("en");
    expect(detectLocale(null, ["ru-RU", "en-US"])).toBe("ru");
  });

  it("falls back to English when the browser offers nothing supported, or nothing at all", () => {
    expect(detectLocale(null, ["de-DE", "fr", "zh-Hans"])).toBe("en");
    expect(detectLocale(null, [])).toBe("en");
    expect(detectLocale(null, ["", "-"])).toBe("en");
  });
});

describe("browserLanguages", () => {
  const languagesGetter = (value: () => readonly string[]) =>
    vi.spyOn(window.navigator, "languages", "get").mockImplementation(value);
  const languageGetter = (value: () => string) =>
    vi.spyOn(window.navigator, "language", "get").mockImplementation(value);

  it("is the browser's language list, in order", () => {
    languagesGetter(() => ["ru-RU", "en-US"]);
    expect(browserLanguages()).toEqual(["ru-RU", "en-US"]);
  });

  it("falls back to the single language when the list is empty", () => {
    languagesGetter(() => []);
    languageGetter(() => "ru");
    expect(browserLanguages()).toEqual(["ru"]);
  });

  it("is empty when neither is available", () => {
    languagesGetter(() => []);
    languageGetter(() => "");
    expect(browserLanguages()).toEqual([]);
  });

  it("is empty, rather than throwing, when reading the browser's language fails", () => {
    languagesGetter(() => {
      throw new Error("blocked");
    });
    expect(browserLanguages()).toEqual([]);
  });
});
