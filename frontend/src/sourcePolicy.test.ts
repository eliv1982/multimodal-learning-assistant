import { describe, expect, it } from "vitest";

/**
 * Static guard over the shipped (non-test) source: no raw-HTML rendering
 * path and no client-side persistence API (storage, IndexedDB, Cache API,
 * service workers). eslint.config.js enforces the
 * same rules at lint time; this keeps them enforced in the test run too.
 *
 * The one deliberate exception is the interface-language preference: exactly
 * "en" | "ru", under one key, read and written by one file (LOCALE_STORAGE_FILE)
 * and by nothing else. It is a narrow, product-level exception, not a relaxation
 * of the policy: see "the locale exception" below for what pins it down.
 *
 * src/test/** (test setup and helpers) is excluded from this scan because it
 * is never shipped, but it is not a second, unpoliced exception: "never
 * imports anything from the test-support tree" below fails if any shipped
 * module imports from it, and "the test-setup storage exception" below pins
 * src/test/setup.ts's one storage call.
 */
const sources = import.meta.glob(["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}", "!./test/**"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** src/test/ itself: test setup and helpers, never shipped. */
const testSupportSources = import.meta.glob(["./test/*.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const LOCALE_STORAGE_FILE = "./i18n/storage.ts";
/** The only file that may import the locale storage module. */
const LOCALE_STORAGE_CONSUMER = "./i18n/I18nProvider.tsx";

/** The only two ways the locale storage file may use localStorage, and only with the locale key. */
const APPROVED_LOCALE_STORAGE_CALL =
  /(?<![\w.$])localStorage\.(?:getItem\(LOCALE_STORAGE_KEY\)|setItem\(LOCALE_STORAGE_KEY,\s*locale\))/g;

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** How many mentions of localStorage in `text` are not one of the two approved calls. */
function unapprovedLocalStorageUses(text: string): number {
  const code = withoutComments(text);
  const mentions = code.match(/localStorage/g)?.length ?? 0;
  const approved = code.match(APPROVED_LOCALE_STORAGE_CALL)?.length ?? 0;
  return mentions - approved;
}

/** [label, pattern, files exempt from this one pattern]. */
const FORBIDDEN: [label: string, pattern: RegExp, exempt?: readonly string[]][] = [
  ["raw HTML prop", /dangerouslySetInnerHTML/],
  ["innerHTML/outerHTML", /\b(innerHTML|outerHTML)\b/],
  ["insertAdjacentHTML", /insertAdjacentHTML/],
  ["DOMParser", /\bDOMParser\b/],
  ["createContextualFragment", /createContextualFragment/],
  ["a Markdown or syntax-highlighting library", /from\s+["'](marked|markdown-it|markdown-to-jsx|react-markdown|remark[\w-]*|rehype[\w-]*|micromark|showdown|snarkdown|highlight\.js|prismjs|react-syntax-highlighter|shiki|dompurify|sanitize-html)["']/],
  ["document.write", /document\.write/],
  ["eval", /\beval\s*\(/],
  ["Function constructor", /new\s+Function\s*\(/],
  ["localStorage", /localStorage/, [LOCALE_STORAGE_FILE]],
  ["sessionStorage", /sessionStorage/],
  ["indexedDB", /indexedDB/],
  // Nothing (a chosen file, a document list, a response) may be kept in a
  // browser cache or served by a service worker either.
  ["Cache API", /\bCacheStorage\b|\b(?:window|self|globalThis)\s*\.\s*caches\b|(?<![\w.$])caches\s*\.\s*(?:open|match|has|delete|keys)\s*\(/],
  ["service worker", /\bnavigator\s*\.\s*serviceWorker\b|\bServiceWorkerContainer\b|\bserviceWorker\s*\.\s*register\b/],
  ["cookie write", /document\.cookie\s*=(?!=)/],
];

describe("shipped source policy", () => {
  it("finds the application sources", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(5);
  });

  it.each(FORBIDDEN)("contains no %s", (_label, pattern, exempt = []) => {
    const offenders = Object.entries(sources)
      .filter(([path, text]) => !exempt.includes(path) && pattern.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("never imports anything from the test-support tree (src/test/**)", () => {
    // Relative specifiers only (no path aliases in this project): "./test/...",
    // "../test/...", "../../test/...". A shipped module importing from here
    // could bundle a test-only, policy-exempt helper into production.
    const importsTestTree = /["'](?:\.\.?\/)+test\//;
    const offenders = Object.entries(sources)
      .filter(([, text]) => importsTestTree.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  describe("the locale exception", () => {
    const storageSource = () => sources[LOCALE_STORAGE_FILE];

    it("is exactly one file, and that file is found", () => {
      expect(FORBIDDEN.flatMap(([, , exempt]) => exempt ?? [])).toEqual([LOCALE_STORAGE_FILE]);
      expect(typeof storageSource()).toBe("string");
    });

    it("lets that file read and write the locale key with getItem and setItem, and do nothing else with localStorage", () => {
      const text = storageSource() ?? "";
      const code = withoutComments(text);
      expect(code.match(/(?<![\w.$])localStorage\.getItem\(LOCALE_STORAGE_KEY\)/g)).toHaveLength(1);
      expect(code.match(/(?<![\w.$])localStorage\.setItem\(LOCALE_STORAGE_KEY,\s*locale\)/g)).toHaveLength(1);
      expect(unapprovedLocalStorageUses(text)).toBe(0);
    });

    it("keeps the rest of the storage policy in force for that file", () => {
      const text = withoutComments(storageSource() ?? "");
      for (const [label, pattern, exempt] of FORBIDDEN) {
        if (exempt?.includes(LOCALE_STORAGE_FILE) !== true) {
          expect([label, pattern.test(text)]).toEqual([label, false]);
        }
      }
    });

    it("stores under one key, whose literal exists nowhere else", () => {
      expect(withoutComments(storageSource() ?? "")).toMatch(/export const LOCALE_STORAGE_KEY = "mla\.locale";/);
      const elsewhere = Object.entries(sources)
        .filter(([path, text]) => path !== LOCALE_STORAGE_FILE && text.includes("mla.locale"))
        .map(([path]) => path);
      expect(elsewhere).toEqual([]);
    });

    it("is imported by the language provider and by nothing else", () => {
      const importsStorage = /from\s+["'][^"']*\bstorage["']/;
      const importers = Object.entries(sources)
        .filter(([path, text]) => path !== LOCALE_STORAGE_FILE && importsStorage.test(text))
        .map(([path]) => path);
      expect(importers).toEqual([LOCALE_STORAGE_CONSUMER]);
    });

    it("recognizes only the two approved calls", () => {
      for (const approved of [
        "return localStorage.getItem(LOCALE_STORAGE_KEY);",
        "localStorage.setItem(LOCALE_STORAGE_KEY, locale);",
        "// localStorage.setItem('token', jwt) in a comment is not code",
      ]) {
        expect(unapprovedLocalStorageUses(approved)).toBe(0);
      }
      for (const violation of [
        'localStorage.setItem("token", value);',
        "localStorage.setItem(LOCALE_STORAGE_KEY, token);",
        "localStorage.getItem(OTHER_KEY);",
        "localStorage.removeItem(LOCALE_STORAGE_KEY);",
        "localStorage.clear();",
        "window.localStorage.getItem(LOCALE_STORAGE_KEY);",
        "const store = localStorage;",
        "localStorage[LOCALE_STORAGE_KEY] = locale;",
      ]) {
        expect([violation, unapprovedLocalStorageUses(violation)]).not.toEqual([violation, 0]);
      }
    });
  });

  describe("the test-setup storage exception", () => {
    // src/test/setup.ts is excluded from `sources` (it is never shipped), but
    // eslint.config.js still grants it a narrow storage exemption so it can
    // reset the locale key between tests. Pin exactly what it may do, the
    // same way "the locale exception" pins src/i18n/storage.ts.
    const SETUP_FILE = "./test/setup.ts";
    const setupSource = () => testSupportSources[SETUP_FILE];

    it("is found", () => {
      expect(typeof setupSource()).toBe("string");
    });

    it("touches localStorage only to clear it, once, and never touches sessionStorage or indexedDB", () => {
      const code = withoutComments(setupSource() ?? "");
      expect(code.match(/localStorage/g)?.length ?? 0).toBe(1);
      expect(code.match(/(?<![\w.$])localStorage\.clear\(\)/g)).toHaveLength(1);
      expect(code).not.toMatch(/sessionStorage/);
      expect(code).not.toMatch(/indexedDB/);
    });
  });

  it("has Cache API and service-worker patterns that match what they name, and not the fetch cache option", () => {
    const pattern = (label: string) => FORBIDDEN.find(([name]) => name === label)?.[1] as RegExp;
    for (const violation of [
      "await caches.open('files')",
      "window.caches.match(request)",
      "self . caches",
      "new CacheStorage()",
    ]) {
      expect(pattern("Cache API").test(violation)).toBe(true);
    }
    for (const violation of [
      "navigator.serviceWorker.register('/sw.js')",
      "navigator . serviceWorker",
      "let c: ServiceWorkerContainer",
    ]) {
      expect(pattern("service worker").test(violation)).toBe(true);
    }
    for (const fine of ['fetch(path, { cache: "no-store" })', "// the browser caches the response", "Cache-Control"]) {
      expect(pattern("Cache API").test(fine)).toBe(false);
      expect(pattern("service worker").test(fine)).toBe(false);
    }
  });

  it("only ever reaches the backend through relative paths", () => {
    const absoluteUrl = /["'`]https?:\/\//;
    const offenders = Object.entries(sources)
      .filter(([, text]) => absoluteUrl.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
