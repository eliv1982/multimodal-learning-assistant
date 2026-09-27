import { describe, expect, it } from "vitest";

import { en, type Messages } from "./en";
import { ru } from "./ru";
import { createTranslator, interpolate, translatorFor, type MessageKey } from "./translate";

const KEYS = Object.keys(en) as MessageKey[];
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("translation key parity", () => {
  it("gives Russian exactly the keys English has, no more and no fewer", () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
  });

  it("has no empty message in either language", () => {
    for (const [locale, messages] of [
      ["en", en],
      ["ru", ru],
    ] as const) {
      for (const key of KEYS) {
        expect([locale, key, messages[key].trim() === ""]).toEqual([locale, key, false]);
      }
    }
  });

  it("is enforced by the compiler: a missing or an extra key is a type error", () => {
    const withoutOne = Object.fromEntries(Object.entries(ru).filter(([key]) => key !== "chat.send"));
    // @ts-expect-error a locale that lacks a key does not satisfy Messages
    const incomplete: Messages = withoutOne;
    // @ts-expect-error a locale with a key English does not have does not satisfy Messages
    const surplus: Messages = { ...ru, "chat.notAKey": "x" };

    expect(incomplete).toBeDefined();
    expect(surplus).toBeDefined();
  });
});

describe("placeholder parity", () => {
  it.each(KEYS)("uses the same placeholders in both languages for %s", (key) => {
    expect(placeholders(ru[key])).toEqual(placeholders(en[key]));
  });

  it.each(KEYS)("has only well-formed {name} placeholders in %s", (key) => {
    for (const text of [en[key], ru[key]]) {
      expect(text.replace(/\{\w+\}/g, "")).not.toMatch(/[{}]/);
    }
  });

  it("has placeholders where the interface interpolates, and only there", () => {
    const withPlaceholders = KEYS.filter((key) => placeholders(en[key]).length > 0);
    expect(withPlaceholders.sort()).toEqual(["chat.hint", "chat.tooLong", "title.signIn", "title.verificationError"]);
    expect(placeholders(en["chat.hint"])).toEqual(["length", "max"]);
    expect(placeholders(en["title.signIn"])).toEqual(["product"]);
  });
});

describe("translation content", () => {
  it("does not leave a Russian message in English (a copy-paste of the source)", () => {
    const untranslated = KEYS.filter((key) => ru[key] === en[key]);
    expect(untranslated).toEqual([]);
  });

  it("is written in Cyrillic for Russian", () => {
    for (const key of KEYS) {
      expect([key, /[А-Яа-яЁё]/.test(ru[key])]).toEqual([key, true]);
    }
  });

  it("is domain-neutral in both languages: no Python or tutor framing", () => {
    for (const key of KEYS) {
      expect([key, /python|tutor|питон|пайтон|репетитор|наставник/i.test(`${en[key]} ${ru[key]}`)]).toEqual([key, false]);
    }
  });

  it("never translates or repeats the product name inside a message", () => {
    for (const key of KEYS) {
      expect(en[key]).not.toContain("Multimodal Learning Assistant");
      expect(ru[key]).not.toContain("Multimodal Learning Assistant");
    }
  });
});

describe("interpolate", () => {
  it("fills placeholders, including numbers and repeats", () => {
    expect(interpolate("{a} of {b}, {a} again", { a: 3, b: "four" })).toBe("3 of four, 3 again");
  });

  it("returns a message without placeholders untouched", () => {
    expect(interpolate("No placeholders {} here { }", { a: 1 })).toBe("No placeholders {} here { }");
    expect(interpolate("plain", undefined)).toBe("plain");
  });

  it("leaves a placeholder that was given no value as written", () => {
    expect(interpolate("{a} and {b}", { a: "x" })).toBe("x and {b}");
    expect(interpolate("{a}", {})).toBe("{a}");
  });

  it("ignores values that have no placeholder", () => {
    expect(interpolate("{a}", { a: "x", unused: "y" })).toBe("x");
  });

  it("inserts a value as plain text: special replacement patterns and markup are not interpreted", () => {
    expect(interpolate("[{a}]", { a: "$& $1 $$ $` $'" })).toBe("[$& $1 $$ $` $']");
    expect(interpolate("[{a}]", { a: "<b>x</b>" })).toBe("[<b>x</b>]");
  });

  it("does not expand placeholders that appear inside a value", () => {
    expect(interpolate("{a} {b}", { a: "{b}", b: "B" })).toBe("{b} B");
    expect(interpolate("{a}", { a: "{a}" })).toBe("{a}");
  });

  it("only looks up the caller's own properties: inherited names are not placeholders", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect(interpolate(`{${name}}`, { other: "x" })).toBe(`{${name}}`);
    }
  });
});

describe("createTranslator", () => {
  it("returns the message of its own language", () => {
    expect(createTranslator({ "chat.send": "Senden" })("chat.send")).toBe("Senden");
  });

  it("falls back to English for a message the language lacks", () => {
    const partial = createTranslator({ "chat.send": "Senden" });

    expect(partial("chat.send")).toBe("Senden");
    expect(partial("chat.sending")).toBe(en["chat.sending"]);
    expect(createTranslator({})("shell.signOut")).toBe("Sign out");
  });

  it("interpolates a fallback message too", () => {
    expect(createTranslator({})("chat.tooLong", { length: 4001, max: 4000 })).toBe(
      "Too long: 4001 of 4000 characters. Shorten it to send.",
    );
  });

  it("uses a given fallback in place of English", () => {
    const fallback: Messages = { ...en, "chat.send": "Fallback send" };

    expect(createTranslator({}, fallback)("chat.send")).toBe("Fallback send");
  });

  it("renders the key itself, never nothing or a crash, for a key that nobody has", () => {
    const t = createTranslator({}) as (key: string) => string;

    expect(t("no.such.key")).toBe("no.such.key");
  });

  it("does not mistake inherited object members for messages", () => {
    const t = createTranslator({}) as (key: string) => string;

    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(t(name)).toBe(name);
    }
  });

  it("ignores an empty own message no differently from a present one: the empty string is a message", () => {
    expect(createTranslator({ "chat.send": "" })("chat.send")).toBe("");
  });
});

describe("translatorFor", () => {
  it("translates in the requested language", () => {
    expect(translatorFor("en")("shell.signOut")).toBe("Sign out");
    expect(translatorFor("ru")("shell.signOut")).toBe("Выйти");
  });

  it("interpolates in each language", () => {
    expect(translatorFor("en")("chat.hint", { length: 12, max: 4000 })).toBe(
      "Enter to send, Shift+Enter for a new line. 12 / 4000",
    );
    expect(translatorFor("ru")("chat.hint", { length: 12, max: 4000 })).toBe(
      "Enter — отправить, Shift+Enter — новая строка. 12 / 4000",
    );
    expect(translatorFor("ru")("title.signIn", { product: "Multimodal Learning Assistant" })).toBe(
      "Вход — Multimodal Learning Assistant",
    );
  });

  it("requires exactly the placeholders of a message: the compiler checks the call", () => {
    const t = translatorFor("en");

    // @ts-expect-error a message with placeholders needs its values
    t("chat.tooLong");
    // @ts-expect-error a missing placeholder value is a type error
    t("chat.tooLong", { length: 1 });
    // @ts-expect-error a message without placeholders takes no values
    t("chat.send", { length: 1 });
    // @ts-expect-error only known keys can be translated
    t("chat.notAKey");
    // (Wrong calls still render something rather than crash.)
    expect(t("chat.send")).toBe("Send");
  });
});
