import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n/I18nProvider";
import { LOCALE_STORAGE_KEY } from "../i18n/storage";
import { LanguageSwitcher } from "./LanguageSwitcher";

const renderSwitcher = () =>
  render(
    <I18nProvider>
      <LanguageSwitcher />
    </I18nProvider>,
  );
const pressed = () =>
  screen
    .getAllByRole("button")
    .filter((button) => button.getAttribute("aria-pressed") === "true")
    .map((button) => button.textContent);

describe("LanguageSwitcher", () => {
  it("is a labelled group of two toggle buttons, each language named in itself and tagged with its language", () => {
    renderSwitcher();

    const group = screen.getByRole("group", { name: "Language" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["English", "Русский"]);
    expect(buttons.map((button) => button.getAttribute("lang"))).toEqual(["en", "ru"]);
    expect(buttons.every((button) => button.getAttribute("type") === "button")).toBe(true);
    expect(buttons.every((button) => button.hasAttribute("aria-pressed"))).toBe(true);
  });

  it("marks the language in use as pressed, and moves the mark when the language changes", async () => {
    const user = userEvent.setup();
    renderSwitcher();
    expect(pressed()).toEqual(["English"]);

    await user.click(screen.getByRole("button", { name: "Русский" }));
    expect(pressed()).toEqual(["Русский"]);
    // The group's own label is now in Russian.
    expect(screen.getByRole("group", { name: "Язык" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "English" }));
    expect(pressed()).toEqual(["English"]);
    expect(screen.getByRole("group", { name: "Language" })).toBeTruthy();
  });

  it("keeps the language when the pressed button is pressed again", async () => {
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(screen.getByRole("button", { name: "English" }));

    expect(pressed()).toEqual(["English"]);
    expect(document.documentElement.lang).toBe("en");
  });

  it("starts from the stored language", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "ru");

    renderSwitcher();

    expect(pressed()).toEqual(["Русский"]);
    expect(screen.getByRole("group", { name: "Язык" })).toBeTruthy();
  });

  it("works from the keyboard", async () => {
    const user = userEvent.setup();
    renderSwitcher();

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "English" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Русский" }));
    await user.keyboard("{Enter}");

    expect(pressed()).toEqual(["Русский"]);

    await user.keyboard("{Shift>}{Tab}{/Shift}");
    await user.keyboard(" ");

    expect(pressed()).toEqual(["English"]);
  });

  it("writes only the locale key when used", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(screen.getByRole("button", { name: "Русский" }));

    expect(setItem.mock.calls).toEqual([[LOCALE_STORAGE_KEY, "ru"]]);
  });

  it("is inert, but harmless, outside a provider", async () => {
    const user = userEvent.setup();
    render(<LanguageSwitcher />);

    await user.click(screen.getByRole("button", { name: "Русский" }));

    expect(pressed()).toEqual(["English"]);
    expect(localStorage.length).toBe(0);
  });
});
