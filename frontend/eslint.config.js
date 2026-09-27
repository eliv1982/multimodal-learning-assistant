import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["dist", "node_modules"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      reactHooks.configs.flat.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Stage 7B-1 browser-storage policy: no authentication material (or
      // anything else) is persisted client-side. The only exception is the
      // interface-language preference, allowed in src/i18n/storage.ts below.
      "no-restricted-globals": [
        "error",
        { name: "localStorage", message: "Browser storage is not used (Stage 7B-1 policy)." },
        { name: "sessionStorage", message: "Browser storage is not used (Stage 7B-1 policy)." },
        { name: "indexedDB", message: "Browser storage is not used (Stage 7B-1 policy)." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "window", property: "localStorage", message: "Browser storage is not used." },
        { object: "window", property: "sessionStorage", message: "Browser storage is not used." },
        { object: "window", property: "indexedDB", message: "Browser storage is not used." },
        { object: "globalThis", property: "localStorage", message: "Browser storage is not used." },
        { object: "globalThis", property: "sessionStorage", message: "Browser storage is not used." },
        { object: "globalThis", property: "indexedDB", message: "Browser storage is not used." },
      ],
      // Server-provided text is only ever rendered as React text nodes.
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "Raw HTML rendering is forbidden; render text through React.",
        },
        {
          selector: "MemberExpression[property.name=/^(innerHTML|outerHTML)$/]",
          message: "Raw HTML assignment is forbidden; render text through React.",
        },
      ],
    },
  },
  {
    // The one product exception to the storage policy: the interface language
    // ("en" | "ru", nothing else) is remembered in localStorage, from this file
    // alone. sessionStorage and IndexedDB stay banned here too, and the
    // `window.`/`globalThis.` spellings stay banned everywhere (the rules above).
    // sourcePolicy.test.ts pins what this file may do with localStorage.
    files: ["src/i18n/storage.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "sessionStorage", message: "Browser storage is not used (Stage 7B-1 policy)." },
        { name: "indexedDB", message: "Browser storage is not used (Stage 7B-1 policy)." },
      ],
    },
  },
  {
    // Tests deliberately touch the storage APIs to prove they are unused.
    // This exemption is *.test.ts(x) only: src/test/ helpers (setup.ts,
    // http.ts) stay under the full policy above, except for the one,
    // narrower exemption below. That keeps src/test/ eligible for the
    // "production source cannot import from src/test/**" guard in
    // sourcePolicy.test.ts — a helper exempted here could otherwise be
    // bundled into production with the policy silently lifted.
    files: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-globals": "off",
      "no-restricted-properties": "off",
      "no-restricted-syntax": "off",
    },
  },
  {
    // src/test/setup.ts resets the one approved locale key between tests
    // (localStorage.clear()); sourcePolicy.test.ts pins this file to exactly
    // that one call. sessionStorage/indexedDB stay banned here too, same as
    // src/i18n/storage.ts above.
    files: ["src/test/setup.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "sessionStorage", message: "Browser storage is not used (Stage 7B-1 policy)." },
        { name: "indexedDB", message: "Browser storage is not used (Stage 7B-1 policy)." },
      ],
    },
  },
]);
