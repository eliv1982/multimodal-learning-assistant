import { describe, expect, it, vi } from "vitest";

import type { Locale } from "./locale";
import { LOCALE_STORAGE_KEY, readStoredLocale, writeStoredLocale } from "./storage";

const storedKeys = () => Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));

describe("the locale storage key", () => {
  it("is a single fixed, non-personal name", () => {
    expect(LOCALE_STORAGE_KEY).toBe("mla.locale");
  });
});

describe("readStoredLocale", () => {
  it("is null when nothing is stored", () => {
    expect(readStoredLocale()).toBeNull();
  });

  it.each(["en", "ru"] as const)("returns a stored %j", (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    expect(readStoredLocale()).toBe(locale);
  });

  it.each(["de", "EN", "RU", "en-US", " ru", "ru ", "", "null", "undefined", "true", '"ru"', '{"locale":"ru"}', "русский"])(
    "treats the invalid stored value %j as none",
    (value) => {
      localStorage.setItem(LOCALE_STORAGE_KEY, value);
      expect(readStoredLocale()).toBeNull();
    },
  );

  it("reads only its own key", () => {
    localStorage.setItem("other", "ru");
    const getItem = vi.spyOn(Storage.prototype, "getItem");

    expect(readStoredLocale()).toBeNull();

    expect(getItem.mock.calls).toEqual([[LOCALE_STORAGE_KEY]]);
  });

  it("is null, rather than throwing, when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(readStoredLocale()).toBeNull();
  });
});

describe("writeStoredLocale", () => {
  it.each(["en", "ru"] as const)("stores %j under the one key, and nothing else", (locale) => {
    writeStoredLocale(locale);

    expect(storedKeys()).toEqual([LOCALE_STORAGE_KEY]);
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe(locale);
    expect(sessionStorage.length).toBe(0);
    expect(readStoredLocale()).toBe(locale);
  });

  it("replaces the previous choice", () => {
    writeStoredLocale("ru");
    writeStoredLocale("en");

    expect(storedKeys()).toEqual([LOCALE_STORAGE_KEY]);
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
  });

  it("writes only the locale key, through setItem alone", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    const clear = vi.spyOn(Storage.prototype, "clear");

    writeStoredLocale("ru");

    expect(setItem.mock.calls).toEqual([[LOCALE_STORAGE_KEY, "ru"]]);
    expect(removeItem).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it.each(["de", "EN", "", "ru-RU", "token", "null"])("refuses to store the value %j", (value) => {
    writeStoredLocale(value as Locale);

    expect(localStorage.length).toBe(0);
  });

  it("does not throw when storage is unavailable, full or blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    expect(() => writeStoredLocale("ru")).not.toThrow();
  });
});
