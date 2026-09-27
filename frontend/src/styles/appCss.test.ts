import { describe, expect, it } from "vitest";

import appCss from "./app.css?raw";

/** The value of a custom property declared in :root. */
function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6});`).exec(appCss);
  expect(match, `--${name} is declared as a hex colour`).not.toBeNull();
  return (match as RegExpExecArray)[1] as string;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two hex colours. */
function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.[\]"=*+~>()^$|]/g, (character) => `\\${character}`);
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(appCss);
  expect(match, `a rule for ${selector}`).not.toBeNull();
  return (match as RegExpExecArray)[1] as string;
}

describe("contrast of the chat's input and focus indication (WCAG non-text contrast: 3:1)", () => {
  it("draws the input boundary at 3:1 or better against the surfaces it sits on", () => {
    expect(contrast(token("border-strong"), token("surface"))).toBeGreaterThanOrEqual(3);
    expect(contrast(token("border-strong"), token("composer-bg"))).toBeGreaterThanOrEqual(3);
  });

  it("was not left at the old, low-contrast boundary", () => {
    expect(contrast(token("border"), token("surface"))).toBeLessThan(3);
    expect(rule(".chat-input")).toMatch(/border:\s*1px solid var\(--border-strong\)/);
    expect(rule(".chat-composer")).toMatch(/border:\s*1px solid var\(--border-strong\)/);
  });

  it("draws the keyboard focus ring at 3:1 or better against white and the tinted surfaces", () => {
    for (const surface of ["surface", "composer-bg", "transcript-bg", "bg"]) {
      expect(contrast(token("focus"), token(surface))).toBeGreaterThanOrEqual(3);
    }
  });

  it("uses that focus ring on every focusable control the stylesheet styles, and no lighter one", () => {
    expect(appCss).not.toContain("#86a8f0");
    for (const selector of [".button:focus-visible", ".language-option:focus-visible", ".settings-select:focus-visible"]) {
      expect(rule(selector)).toMatch(/outline:\s*3px solid var\(--focus\)/);
    }
    expect(appCss).toMatch(/\.chat-input:focus-visible,\s*\.chat-transcript:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--focus\)/);
  });
});

describe("chat layout", () => {
  it("tells the transcript from the composer by more than a border", () => {
    expect(token("transcript-bg")).not.toBe(token("composer-bg"));
    expect(rule(".chat-transcript")).toMatch(/background:\s*var\(--transcript-bg\)/);
    expect(rule(".chat-composer")).toMatch(/background:\s*var\(--composer-bg\)/);
  });

  it("keeps wrapping of untrusted chat text exactly as it was", () => {
    const declarations = rule(".chat-text");
    expect(declarations).toMatch(/white-space:\s*pre-wrap/);
    expect(declarations).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".chat-transcript")).toMatch(/overflow-y:\s*auto/);
  });
});

describe("shell layout", () => {
  it("lets the hidden attribute win over any display rule, so a closed Settings panel is really gone", () => {
    expect(rule("[hidden]")).toMatch(/display:\s*none\s*!important/);
  });

  it("stacks Chat and Documents by default, and only sets them side by side where the room allows", () => {
    const base = rule(".workspaces");
    expect(base).not.toMatch(/grid-template-columns/);
    expect(appCss).toMatch(/@container\s*\(min-width:\s*60rem\)\s*\{\s*\.workspaces\s*\{[^}]*grid-template-columns/);
    // The room is the workspace's own width, not the window's: the Settings panel takes some of it.
    expect(rule(".shell-main")).toMatch(/container-type:\s*inline-size/);
  });

  it("puts the Settings panel beside the workspaces only from the desktop breakpoint up", () => {
    expect(rule(".shell-body")).toMatch(/flex-direction:\s*column/);
    expect(appCss).toMatch(/@media\s*\(min-width:\s*64rem\)\s*\{\s*\.shell-body\s*\{[^}]*flex-direction:\s*row/);
  });
});
