import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  FORBIDDEN_ERROR_DETAIL,
  NETWORK_ERROR_DETAIL,
  RATE_LIMITED_ERROR_DETAIL,
  SERVER_ERROR_DETAIL,
  UNEXPECTED_RESPONSE_DETAIL,
  apiGetJson,
} from "./api/client";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { useAuth } from "./auth/useAuth";
import { I18nProvider } from "./i18n/I18nProvider";
import { LOCALE_STORAGE_KEY } from "./i18n/storage";
import {
  REPLACEMENT_CHARACTER,
  SAMPLE_USER,
  SENSITIVE_DETAILS,
  deferred,
  jsonResponse,
  mockFetch,
  noContentResponse,
  rawBytes,
  textResponse,
  type RecordedCall,
} from "./test/http";

const ACCOUNT_BOT_PATH = "/my_tutor_bot";
const ACCOUNT_SECRET = "A".repeat(43);
const ACCOUNT_LINK_RESPONSE = {
  deep_link: `https://t.me${ACCOUNT_BOT_PATH}?start=link_${ACCOUNT_SECRET}`,
  bot_path: ACCOUNT_BOT_PATH,
  expires_at: "2026-09-25T12:00:00Z",
};

function renderApp(extra?: React.ReactNode) {
  return render(
    <I18nProvider>
      <AuthProvider>
        <App />
        {extra}
      </AuthProvider>
    </I18nProvider>,
  );
}

/** Resolves a held-open request and flushes the resulting React updates. */
async function settle<T>(gate: { promise: Promise<T>; resolve: (value: T) => void }, value: T) {
  await act(async () => {
    gate.resolve(value);
    await gate.promise;
  });
}

/**
 * An authenticated request unrelated to any feature, for tests of the central
 * 401 handling: the signed-in shell already reads `/api/settings` and
 * `/api/documents` on its own.
 */
const LATER_REQUEST_PATH = "/api/later-request";

const DOCUMENTS_FIRST_PAGE = "/api/documents?limit=21&offset=0";

/**
 * Routes /api/me, /api/logout, /api/settings and /api/documents (the signed-in
 * shell reads the last two on mount; the defaults are the text mode and an
 * empty first page of documents); every other request is a test bug and
 * answers 599.
 */
function backend(overrides: {
  me?: (call: RecordedCall) => Response | Promise<Response>;
  logout?: (call: RecordedCall) => Response | Promise<Response>;
  settings?: (call: RecordedCall) => Response | Promise<Response>;
  documents?: (call: RecordedCall) => Response | Promise<Response>;
  other?: (call: RecordedCall) => Response | Promise<Response>;
}) {
  return mockFetch((call) => {
    if (call.url === "/api/me" && overrides.me) return overrides.me(call);
    if (call.url === "/api/logout" && overrides.logout) return overrides.logout(call);
    if (call.url === "/api/settings") return (overrides.settings ?? (() => jsonResponse(200, { mode: "text" })))(call);
    if (call.url.startsWith("/api/documents")) {
      if (overrides.documents) return overrides.documents(call);
      if (call.init.method === "GET" && call.url === DOCUMENTS_FIRST_PAGE) return jsonResponse(200, { items: [] });
    }
    if (overrides.other) return overrides.other(call);
    return jsonResponse(599, { detail: `unexpected request ${call.url}` });
  });
}

const networkDown = () => {
  throw new TypeError("Failed to fetch");
};

async function signedInApp(options: Parameters<typeof backend>[0] = {}) {
  const harness = backend({ me: () => jsonResponse(200, SAMPLE_USER), ...options });
  renderApp();
  // The shell's page heading, in whichever interface language is showing.
  await screen.findByRole("heading", { name: /^(You’re signed in|Вы вошли в систему)$/ });
  return harness;
}

/**
 * Account connections and Settings live in a side panel that starts closed.
 * Opens it (or leaves it open): what a user does before touching either.
 */
async function openSettings() {
  const trigger = await screen.findByRole("button", { name: "Settings" });
  if (trigger.getAttribute("aria-expanded") !== "true") {
    await userEvent.setup().click(trigger);
  }
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
}

describe("session bootstrap", () => {
  it("starts in a loading state and calls GET /api/me exactly once", async () => {
    const gate = deferred<Response>();
    const { calls } = backend({ me: () => gate.promise });

    renderApp();

    expect(screen.getByRole("status").textContent).toContain("Checking your session");
    expect(screen.queryByRole("link", { name: /sign in/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /sign out/i })).toBeNull();
    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual(["GET /api/me"]);

    await settle(gate, jsonResponse(200, SAMPLE_USER));
    await screen.findByRole("heading", { name: "You’re signed in" });
  });

  it("renders the authenticated shell for a 200 response", async () => {
    await signedInApp();

    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.getByText("Member since")).toBeTruthy();
    expect(screen.getByText(/2026/)).toBeTruthy();
    expect(screen.getByText("Not linked")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /sign in/i })).toBeNull();
  });

  it("shows whether Telegram is linked", async () => {
    await signedInApp({ me: () => jsonResponse(200, { ...SAMPLE_USER, telegram_linked: true }) });
    expect(screen.getByText("Linked")).toBeTruthy();
  });

  it("does not display the canonical user id anywhere in the UI", async () => {
    await signedInApp();
    expect(document.body.textContent).not.toContain(SAMPLE_USER.id);
    expect(document.body.innerHTML).not.toContain(SAMPLE_USER.id);
  });

  it("renders the anonymous sign-in screen for a 401, without an error", async () => {
    backend({ me: () => jsonResponse(401, { detail: "Not authenticated" }) });

    renderApp();

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /sign out/i })).toBeNull();
  });

  it("treats a network failure as a verification error, not as signed out", async () => {
    backend({ me: networkDown });

    renderApp();

    expect(await screen.findByRole("heading", { name: "We couldn’t verify your session" })).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /sign in/i })).toBeNull();
  });

  it.each([500, 502, 503])("treats HTTP %i as a verification error, not as signed out", async (status) => {
    backend({ me: () => textResponse(status, "<html>upstream problem</html>", "text/html") });

    renderApp();

    expect(await screen.findByRole("heading", { name: "We couldn’t verify your session" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /sign in/i })).toBeNull();
    expect(screen.getByText(SERVER_ERROR_DETAIL)).toBeTruthy();
    expect(document.body.textContent).not.toContain("upstream problem");
  });

  it.each([
    [403, FORBIDDEN_ERROR_DETAIL],
    [429, RATE_LIMITED_ERROR_DETAIL],
  ])("treats HTTP %i as a verification error with a fixed message, not as signed out", async (status, message) => {
    backend({ me: () => jsonResponse(status, { detail: "backend prose" }) });

    renderApp();

    expect(await screen.findByRole("heading", { name: "We couldn’t verify your session" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /sign in/i })).toBeNull();
    expect(screen.getByText(message)).toBeTruthy();
    expect(document.body.textContent).not.toContain("backend prose");
  });

  it("shows the fixed network message for a network failure", async () => {
    backend({ me: networkDown });

    renderApp();

    expect(await screen.findByText(NETWORK_ERROR_DETAIL)).toBeTruthy();
  });

  it("treats a structurally invalid 200 as a verification error", async () => {
    backend({ me: () => jsonResponse(200, { id: 123 }) });

    renderApp();

    expect(await screen.findByRole("heading", { name: "We couldn’t verify your session" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "You’re signed in" })).toBeNull();
  });

  it("treats a 200 whose body is not valid UTF-8 as a verification error: not signed in, not signed out", async () => {
    // With replacement decoding this would parse as a valid user with id U+FFFD.
    backend({
      me: () =>
        new Response(rawBytes('{"id":"', [0xff], '","created_at":"2026-01-15T12:00:00Z","telegram_linked":false}'), {
          status: 200,
        }),
    });

    renderApp();

    expect(await screen.findByRole("heading", { name: "We couldn’t verify your session" })).toBeTruthy();
    expect(screen.getByText(UNEXPECTED_RESPONSE_DETAIL)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "You’re signed in" })).toBeNull();
    expect(screen.queryByRole("link", { name: /sign in/i })).toBeNull();
    expect(document.body.textContent).not.toContain(REPLACEMENT_CHARACTER);
  });

  it("makes the verification-error and anonymous screens visibly distinct", async () => {
    backend({ me: () => jsonResponse(401, { detail: "Not authenticated" }) });
    const anonymous = renderApp();
    await screen.findByRole("link", { name: "Sign in with GitHub" });
    const anonymousText = anonymous.container.textContent;
    anonymous.unmount();

    backend({ me: networkDown });
    const failed = renderApp();
    await screen.findByRole("button", { name: "Try again" });

    expect(failed.container.textContent).not.toBe(anonymousText);
    expect(anonymousText).not.toContain("verify");
    expect(failed.container.textContent).toContain("You have not been signed out");
  });

  it("retries only when the user asks, one request per click, and can then recover", async () => {
    let healthy = false;
    const user = userEvent.setup();
    const gate = deferred<Response>();
    const { calls } = backend({
      me: () => {
        if (!healthy) return textResponse(503, "unavailable");
        return gate.promise;
      },
    });

    renderApp();
    await screen.findByRole("button", { name: "Try again" });
    // No automatic retry loop: give one a chance to (wrongly) happen.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(1);

    healthy = true;
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(screen.getByRole("status").textContent).toContain("Checking your session");
    expect(calls).toHaveLength(2);

    await settle(gate, jsonResponse(200, SAMPLE_USER));
    await screen.findByRole("heading", { name: "You’re signed in" });
    // Session checks only: the signed-in shell reads /api/settings on its own.
    expect(calls.filter((call) => call.url === "/api/me")).toHaveLength(2);
  });

  it("can fail again after a retry and stays in the error state without looping", async () => {
    const user = userEvent.setup();
    const { calls } = backend({ me: networkDown });

    renderApp();
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByRole("button", { name: "Try again" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toHaveLength(2);
  });

  it("still resolves correctly under React StrictMode's double-invoked effects", async () => {
    backend({ me: () => jsonResponse(200, SAMPLE_USER) });

    render(
      <StrictMode>
        <I18nProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </I18nProvider>
      </StrictMode>,
    );

    expect(await screen.findByRole("heading", { name: "You’re signed in" })).toBeTruthy();
  });
});

describe("GitHub sign-in", () => {
  it("is a plain link for full browser navigation to the backend, not an AJAX call", async () => {
    const user = userEvent.setup();
    const { calls } = backend({ me: () => jsonResponse(401, { detail: "Not authenticated" }) });
    renderApp();
    const link = await screen.findByRole("link", { name: "Sign in with GitHub" });

    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/api/auth/github/login");
    expect(link.getAttribute("target")).toBeNull();

    // Observe the click after React has handled it; block jsdom's own
    // (unimplemented) navigation. `defaultPrevented === false` proves the app
    // did not hijack the click, so a real browser performs the navigation.
    const seen: boolean[] = [];
    const observer = (event: MouseEvent) => {
      seen.push(event.defaultPrevented);
      event.preventDefault();
    };
    document.addEventListener("click", observer);
    await user.click(link);
    document.removeEventListener("click", observer);

    expect(seen).toEqual([false]);
    expect(calls.map((call) => call.url)).toEqual(["/api/me"]);
  });
});

describe("central 401 handling", () => {
  it("moves to the anonymous screen when a later request is rejected as unauthorized", async () => {
    await signedInApp({ other: () => jsonResponse(401, { detail: "Not authenticated" }) });

    await act(async () => {
      await apiGetJson(LATER_REQUEST_PATH).catch(() => undefined);
    });

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "You’re signed in" })).toBeNull();
    expect(document.body.textContent).not.toContain("Member since");
  });

  it("does not sign out on a network failure of a later request", async () => {
    await signedInApp({ other: networkDown });

    await act(async () => {
      await apiGetJson(LATER_REQUEST_PATH).catch(() => undefined);
    });

    expect(screen.getByRole("heading", { name: "You’re signed in" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /sign in/i })).toBeNull();
  });

  it.each([403, 500, 503])("does not sign out on HTTP %i from a later request", async (status) => {
    await signedInApp({ other: () => jsonResponse(status, { detail: "nope" }) });

    await act(async () => {
      await apiGetJson(LATER_REQUEST_PATH).catch(() => undefined);
    });

    expect(screen.getByRole("heading", { name: "You’re signed in" })).toBeTruthy();
  });

  it("stops reacting to 401s once the provider is unmounted", async () => {
    backend({
      me: () => jsonResponse(200, SAMPLE_USER),
      other: () => jsonResponse(401, { detail: "Not authenticated" }),
    });
    const view = renderApp();
    await screen.findByRole("heading", { name: "You’re signed in" });
    view.unmount();

    await expect(apiGetJson(LATER_REQUEST_PATH)).rejects.toMatchObject({ status: 401 });
  });
});

describe("account linking integration", () => {
  it("stays authenticated and keeps the issued link after a manual false status", async () => {
    const user = userEvent.setup();
    let meCount = 0;
    backend({
      me: () => {
        meCount += 1;
        return jsonResponse(200, SAMPLE_USER);
      },
      other: (call) =>
        call.url === "/api/link/telegram/start" ? jsonResponse(200, ACCOUNT_LINK_RESPONSE) : jsonResponse(599, {}),
    });
    renderApp();

    await openSettings();
    await user.click(await screen.findByRole("button", { name: "Link Telegram" }));
    await user.click(await screen.findByRole("button", { name: "Check link status" }));

    expect(await screen.findByText(/not linked yet/i)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "You’re signed in" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Telegram" }).getAttribute("href")).toBe(
      ACCOUNT_LINK_RESPONSE.deep_link,
    );
    expect(meCount).toBe(2);
  });

  it("updates the authenticated shell and clears the issued link after a manual true status", async () => {
    const user = userEvent.setup();
    let meCount = 0;
    backend({
      me: () => {
        meCount += 1;
        return jsonResponse(200, { ...SAMPLE_USER, telegram_linked: meCount > 1 });
      },
      other: (call) =>
        call.url === "/api/link/telegram/start" ? jsonResponse(200, ACCOUNT_LINK_RESPONSE) : jsonResponse(599, {}),
    });
    renderApp();

    await openSettings();
    await user.click(await screen.findByRole("button", { name: "Link Telegram" }));
    await user.click(await screen.findByRole("button", { name: "Check link status" }));

    expect(await screen.findByText("Linked")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open Telegram" })).toBeNull();
    expect(document.documentElement.outerHTML).not.toContain(ACCOUNT_SECRET);
  });

  it("treats a manual-status 401 after merge as signed out and drops the secret-bearing UI", async () => {
    const user = userEvent.setup();
    let meCount = 0;
    backend({
      me: () => {
        meCount += 1;
        return meCount === 1 ? jsonResponse(200, SAMPLE_USER) : jsonResponse(401, { detail: "merged" });
      },
      other: (call) =>
        call.url === "/api/link/telegram/start" ? jsonResponse(200, ACCOUNT_LINK_RESPONSE) : jsonResponse(599, {}),
    });
    renderApp();

    await openSettings();
    await user.click(await screen.findByRole("button", { name: "Link Telegram" }));
    await user.click(await screen.findByRole("button", { name: "Check link status" }));

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(document.documentElement.outerHTML).not.toContain(ACCOUNT_SECRET);
    expect(screen.queryByRole("log")).toBeNull();
  });

  it("ends the signed-in application after confirmed GitHub disconnection", async () => {
    const user = userEvent.setup();
    await signedInApp({
      other: (call) =>
        call.url === "/api/unlink/github" ? jsonResponse(200, { status: "ok" }) : jsonResponse(599, {}),
    });

    await openSettings();
    await user.click(screen.getByRole("button", { name: "Disconnect GitHub web access" }));
    await user.click(screen.getByRole("button", { name: "Confirm disconnect" }));

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Account connections" })).toBeNull();
    expect(screen.queryByRole("log")).toBeNull();
  });

  it("keeps the authenticated application and hides backend detail when GitHub disconnection is refused", async () => {
    const user = userEvent.setup();
    await signedInApp({
      other: (call) =>
        call.url === "/api/unlink/github"
          ? jsonResponse(409, { detail: SENSITIVE_DETAILS[0] })
          : jsonResponse(599, {}),
    });

    await openSettings();
    await user.click(screen.getByRole("button", { name: "Disconnect GitHub web access" }));
    await user.click(screen.getByRole("button", { name: "Confirm disconnect" }));

    expect((await screen.findByRole("alert")).textContent).toContain("session are unchanged");
    expect(screen.getByRole("heading", { name: "You’re signed in" })).toBeTruthy();
    expect(document.documentElement.outerHTML).not.toContain(SENSITIVE_DETAILS[0]);
  });

  it("does not let a late successful status response resurrect an anonymous session", async () => {
    const user = userEvent.setup();
    const statusGate = deferred<Response>();
    let meCount = 0;
    backend({
      me: () => {
        meCount += 1;
        return meCount === 1 ? jsonResponse(200, SAMPLE_USER) : statusGate.promise;
      },
      other: (call) => {
        if (call.url === "/api/link/telegram/start") return jsonResponse(200, ACCOUNT_LINK_RESPONSE);
        if (call.url === LATER_REQUEST_PATH) return jsonResponse(401, { detail: "session ended" });
        return jsonResponse(599, {});
      },
    });
    renderApp();
    await openSettings();
    await user.click(await screen.findByRole("button", { name: "Link Telegram" }));
    await user.click(await screen.findByRole("button", { name: "Check link status" }));

    await act(async () => {
      await apiGetJson(LATER_REQUEST_PATH).catch(() => undefined);
    });
    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();

    await settle(statusGate, jsonResponse(200, { ...SAMPLE_USER, telegram_linked: true }));
    expect(screen.getByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(screen.queryByText("Linked")).toBeNull();
  });

  it("disables sign out while an account mutation is pending", async () => {
    const user = userEvent.setup();
    const gate = deferred<Response>();
    await signedInApp({ other: (call) => (call.url === "/api/link/telegram/start" ? gate.promise : jsonResponse(599, {})) });

    await openSettings();
    await user.click(screen.getByRole("button", { name: "Link Telegram" }));

    expect(screen.getByRole("button", { name: "Sign out" }).hasAttribute("disabled")).toBe(true);
    await settle(gate, jsonResponse(200, ACCOUNT_LINK_RESPONSE));
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign out" }).hasAttribute("disabled")).toBe(false));
  });

  it("disables account operations while sign out is pending", async () => {
    const user = userEvent.setup();
    const gate = deferred<Response>();
    await signedInApp({ logout: () => gate.promise });
    await openSettings();

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(screen.getByRole("button", { name: "Link Telegram" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Disconnect GitHub web access" }).hasAttribute("disabled")).toBe(true);
    await settle(gate, noContentResponse());
    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
  });
});

describe("settings integration", () => {
  const settingsRegion = () => screen.getByRole("region", { name: "Settings" });
  const settingsSelect = () =>
    within(settingsRegion()).getByRole<HTMLSelectElement>("combobox", { name: "Preferred mode" });
  const settingsSave = () =>
    within(settingsRegion()).getByRole<HTMLButtonElement>("button", { name: /^(Save|Saving…)$/ });
  const settingsLoaded = async () => {
    await openSettings();
    await waitFor(() => expect(settingsSelect().disabled).toBe(false));
  };
  const chatAndLinking = (call: RecordedCall) => {
    if (call.url === "/api/chat") return jsonResponse(200, { text: "Use a list comprehension." });
    if (call.url === "/api/link/telegram/start") return jsonResponse(200, ACCOUNT_LINK_RESPONSE);
    return jsonResponse(599, {});
  };

  it("is shown only while authenticated, with the server's effective mode", async () => {
    backend({ me: () => jsonResponse(401, { detail: "Not authenticated" }) });
    const anonymous = renderApp();
    await screen.findByRole("link", { name: "Sign in with GitHub" });
    expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    anonymous.unmount();

    backend({ me: networkDown });
    const failed = renderApp();
    await screen.findByRole("button", { name: "Try again" });
    expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
    failed.unmount();

    const user = userEvent.setup();
    const { calls } = await signedInApp({
      settings: () => jsonResponse(200, { mode: "rag" }),
      logout: () => noContentResponse(),
    });
    await settingsLoaded();
    expect(settingsSelect().value).toBe("rag");
    expect(calls.filter((call) => call.url === "/api/settings").map((call) => call.init.method)).toEqual(["GET"]);

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("sits with the account connections in the Settings side panel, apart from the chat, as an independent sibling", async () => {
    await signedInApp();
    await openSettings();

    const panel = screen.getByRole("complementary", { name: "Account and settings" });
    const account = within(panel).getByRole("heading", { name: "Account connections" });
    const settings = within(panel).getByRole("heading", { name: "Settings" });
    expect(account.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(screen.getByRole("main")).queryByRole("heading", { name: "Settings" })).toBeNull();
    expect(panel.contains(screen.getByRole("heading", { name: "Ask the assistant" }))).toBe(false);
    expect(within(settingsRegion()).queryByRole("log")).toBeNull();
    expect(within(settingsRegion()).queryByRole("button", { name: /link telegram|disconnect/i })).toBeNull();
  });

  it("ends the authenticated shell through the central handler when the Settings request is a 401", async () => {
    backend({ me: () => jsonResponse(200, SAMPLE_USER), settings: () => jsonResponse(401, { detail: "session ended" }) });

    renderApp();

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "You’re signed in" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toContain("session ended");
  });

  it("ends the authenticated shell when a save is rejected as unauthorized, without a local error", async () => {
    const user = userEvent.setup();
    await signedInApp({
      settings: (call) =>
        call.init.method === "PATCH" ? jsonResponse(401, { detail: "session ended" }) : jsonResponse(200, { mode: "text" }),
    });
    await settingsLoaded();

    await user.selectOptions(settingsSelect(), "voice");
    await user.click(settingsSave());

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not let a late Settings answer bring the shell back after sign-out, and cancels the read", async () => {
    const user = userEvent.setup();
    const gate = deferred<Response>();
    const { calls } = await signedInApp({ settings: () => gate.promise, logout: () => noContentResponse() });

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();

    expect(calls.find((call) => call.url === "/api/settings")?.init.signal?.aborted).toBe(true);
    await settle(gate, jsonResponse(200, { mode: "rag" }));
    expect(screen.getByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "You’re signed in" })).toBeNull();
  });

  it("disables the Settings controls while sign-out is pending", async () => {
    const user = userEvent.setup();
    const gate = deferred<Response>();
    await signedInApp({ logout: () => gate.promise });
    await settingsLoaded();

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(settingsSelect().disabled).toBe(true);
    expect(settingsSave().disabled).toBe(true);
    await settle(gate, noContentResponse());
    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
  });

  it("leaves Settings usable while an account operation is pending", async () => {
    const user = userEvent.setup();
    const gate = deferred<Response>();
    await signedInApp({ other: (call) => (call.url === "/api/link/telegram/start" ? gate.promise : jsonResponse(599, {})) });
    await settingsLoaded();

    await openSettings();
    await user.click(screen.getByRole("button", { name: "Link Telegram" }));

    expect(screen.getByRole("button", { name: "Disconnect GitHub web access" }).hasAttribute("disabled")).toBe(true);
    expect(settingsSelect().disabled).toBe(false);
    expect(settingsSave().disabled).toBe(false);
    await settle(gate, jsonResponse(200, ACCOUNT_LINK_RESPONSE));
  });

  it("keeps chat and account linking working, and a saved mode never reaches the chat request", async () => {
    document.cookie = "csrf_token=dev-csrf; Path=/";
    const user = userEvent.setup();
    const { calls } = await signedInApp({
      settings: (call) =>
        call.init.method === "PATCH" ? jsonResponse(200, { mode: "vision" }) : jsonResponse(200, { mode: "text" }),
      other: chatAndLinking,
    });
    await settingsLoaded();

    await user.selectOptions(settingsSelect(), "vision");
    await user.click(settingsSave());
    await screen.findByText("Preference saved.");
    await user.click(screen.getByRole("textbox", { name: "Your message" }));
    await user.paste("How do I square numbers?");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await within(screen.getByRole("log", { name: "Conversation" })).findByText("Use a list comprehension.");
    await openSettings();
    await user.click(screen.getByRole("button", { name: "Link Telegram" }));

    expect(await screen.findByRole("link", { name: "Open Telegram" })).toBeTruthy();
    const chat = calls.filter((call) => call.url === "/api/chat");
    expect(chat).toHaveLength(1);
    expect(JSON.parse(chat[0]?.init.body as string)).toEqual({ message: "How do I square numbers?", history: [] });
    expect(chat[0]?.init.body).not.toMatch(/mode|vision/);
    expect(calls.filter((call) => call.init.method === "PATCH").map((call) => call.init.body)).toEqual(['{"mode":"vision"}']);
    expect(settingsSelect().value).toBe("vision");
    expect(screen.getByRole("heading", { name: "You’re signed in" })).toBeTruthy();
  });

  it("keeps the rest of the shell usable, and hides the backend detail, when Settings cannot load", async () => {
    const user = userEvent.setup();
    await signedInApp({
      settings: () => jsonResponse(503, { detail: SENSITIVE_DETAILS[0] }),
      other: chatAndLinking,
    });
    await openSettings();

    const alert = await within(settingsRegion()).findByRole("alert");
    expect(alert.textContent).toContain(SERVER_ERROR_DETAIL);
    expect(document.documentElement.outerHTML).not.toContain(SENSITIVE_DETAILS[0]);
    expect(screen.getByRole("heading", { name: "You’re signed in" })).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Sign out" }).disabled).toBe(false);

    await user.click(screen.getByRole("textbox", { name: "Your message" }));
    await user.paste("hello");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await within(screen.getByRole("log", { name: "Conversation" })).findByText("Use a list comprehension.");
    await openSettings();
    await user.click(screen.getByRole("button", { name: "Link Telegram" }));
    expect(await screen.findByRole("link", { name: "Open Telegram" })).toBeTruthy();
  });
});

describe("documents integration", () => {
  const documentsRegion = () => screen.getByRole("region", { name: "Documents" });
  const fileInput = () => within(documentsRegion()).getByLabelText<HTMLInputElement>("Choose a document file");
  const uploadButton = () =>
    within(documentsRegion()).getByRole<HTMLButtonElement>("button", { name: /^(Upload|Uploading…)$/ });
  const refreshButton = () => within(documentsRegion()).getByRole<HTMLButtonElement>("button", { name: "Refresh" });
  const documentsLoaded = () =>
    waitFor(() => expect(within(documentsRegion()).queryByText("Loading documents…")).toBeNull());
  const created = { id: "00000000-0000-4000-8000-000000000001", display_name: "notes.txt", created_at: "2026-09-25T12:00:00.5" };
  const noteFile = () => new File(["hello"], "notes.txt", { type: "text/plain" });
  const documentCalls = (calls: RecordedCall[]) => calls.filter((call) => call.url.startsWith("/api/documents"));
  const WARNING =
    "Link Telegram before uploading if you plan to use RAG there. Documents are not moved when separate accounts are merged and can prevent linking.";
  const chatOnly = (call: RecordedCall) =>
    call.url === "/api/chat" ? jsonResponse(200, { text: "Use a list comprehension." }) : jsonResponse(599, {});

  it("is shown only while authenticated, and reads the first page of the caller's documents", async () => {
    backend({ me: () => jsonResponse(401, { detail: "Not authenticated" }) });
    const anonymous = renderApp();
    await screen.findByRole("link", { name: "Sign in with GitHub" });
    expect(screen.queryByRole("region", { name: "Documents" })).toBeNull();
    expect(screen.queryByLabelText("Choose a document file")).toBeNull();
    anonymous.unmount();

    backend({ me: networkDown });
    const failed = renderApp();
    await screen.findByRole("button", { name: "Try again" });
    expect(screen.queryByRole("region", { name: "Documents" })).toBeNull();
    failed.unmount();

    const user = userEvent.setup();
    const { calls } = await signedInApp({ logout: () => noContentResponse() });
    await documentsLoaded();
    expect(screen.getByText("No documents yet.")).toBeTruthy();
    expect(documentCalls(calls).map((call) => `${call.init.method} ${call.url}`)).toEqual([
      `GET ${DOCUMENTS_FIRST_PAGE}`,
    ]);

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Documents" })).toBeNull();
    expect(screen.queryByLabelText("Choose a document file")).toBeNull();
  });

  it("follows the chat as the second workspace, and stays an independent sibling of Settings and Account connections", async () => {
    await signedInApp();
    await openSettings();

    const documents = screen.getByRole("heading", { name: "Documents" });
    const chat = screen.getByRole("heading", { name: "Ask the assistant" });
    expect(chat.compareDocumentPosition(documents) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(documentsRegion().parentElement).toBe(screen.getByRole("region", { name: "Ask the assistant" }).parentElement);
    expect(documentsRegion().contains(screen.getByRole("region", { name: "Settings" }))).toBe(false);
    expect(documentsRegion().contains(screen.getByRole("region", { name: "Account connections" }))).toBe(false);
    expect(within(documentsRegion()).queryByRole("log")).toBeNull();
    expect(within(documentsRegion()).queryByRole("combobox")).toBeNull();
    expect(within(documentsRegion()).queryByRole("button", { name: /link telegram|disconnect/i })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Your message" })).toBeTruthy();
  });

  it("warns, neutrally, while Telegram is not linked, and stops when linking is confirmed", async () => {
    const user = userEvent.setup();
    let meCount = 0;
    backend({
      me: () => {
        meCount += 1;
        return jsonResponse(200, { ...SAMPLE_USER, telegram_linked: meCount > 1 });
      },
      other: (call) =>
        call.url === "/api/link/telegram/start" ? jsonResponse(200, ACCOUNT_LINK_RESPONSE) : jsonResponse(599, {}),
    });
    renderApp();
    await screen.findByRole("heading", { name: "You’re signed in" });
    await documentsLoaded();

    expect(within(documentsRegion()).getByText(WARNING)).toBeTruthy();
    expect(within(documentsRegion()).queryByRole("alert")).toBeNull();
    // Informational only: uploading is not blocked.
    expect(fileInput().disabled).toBe(false);

    await openSettings();
    await user.click(screen.getByRole("button", { name: "Link Telegram" }));
    await user.click(await screen.findByRole("button", { name: "Check link status" }));

    expect(await screen.findByText("Linked")).toBeTruthy();
    expect(screen.queryByText(WARNING)).toBeNull();
    expect(screen.getByRole("region", { name: "Documents" })).toBeTruthy();
  });

  it("shows no warning when Telegram is already linked", async () => {
    await signedInApp({ me: () => jsonResponse(200, { ...SAMPLE_USER, telegram_linked: true }) });
    await documentsLoaded();

    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it("ends the authenticated shell through the central handler when the documents read is a 401", async () => {
    backend({ me: () => jsonResponse(200, SAMPLE_USER), documents: () => jsonResponse(401, { detail: "session ended" }) });

    renderApp();

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "You’re signed in" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Documents" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toContain("session ended");
  });

  it("ends the authenticated shell when an upload is rejected as unauthorized, without a local error or a claim of success", async () => {
    const user = userEvent.setup();
    await signedInApp({
      documents: (call) =>
        call.init.method === "POST" ? jsonResponse(401, { detail: "session ended" }) : jsonResponse(200, { items: [] }),
    });
    await documentsLoaded();

    await user.upload(fileInput(), noteFile());
    await user.click(uploadButton());

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Documents" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/^Uploaded/)).toBeNull();
  });

  it("ends the authenticated shell when a delete is rejected as unauthorized", async () => {
    const user = userEvent.setup();
    await signedInApp({
      documents: (call) =>
        call.init.method === "DELETE" ? jsonResponse(401, { detail: "session ended" }) : jsonResponse(200, { items: [created] }),
    });
    await within(documentsRegion()).findByText("notes.txt");

    await user.click(within(documentsRegion()).getByRole("button", { name: "Delete" }));
    await user.click(within(documentsRegion()).getByRole("button", { name: "Confirm Delete" }));

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Documents" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not let a late documents answer bring the shell back after sign-out, and cancels the read", async () => {
    const user = userEvent.setup();
    const gate = deferred<Response>();
    const { calls } = await signedInApp({ documents: () => gate.promise, logout: () => noContentResponse() });

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();

    expect(documentCalls(calls)[0]?.init.signal?.aborted).toBe(true);
    await settle(gate, jsonResponse(200, { items: [created] }));
    expect(screen.getByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Documents" })).toBeNull();
    expect(screen.queryByText("notes.txt")).toBeNull();
    expect(screen.queryByRole("heading", { name: "You’re signed in" })).toBeNull();
  });

  it("does not let a late upload answer bring anything back after the session ends, and cancels the upload", async () => {
    const user = userEvent.setup();
    const gate = deferred<Response>();
    const { calls } = await signedInApp({
      documents: (call) => (call.init.method === "POST" ? gate.promise : jsonResponse(200, { items: [] })),
      logout: () => noContentResponse(),
    });
    await documentsLoaded();
    await user.upload(fileInput(), noteFile());
    await user.click(uploadButton());

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();

    expect(documentCalls(calls).find((call) => call.init.method === "POST")?.init.signal?.aborted).toBe(true);
    await settle(gate, jsonResponse(201, created));
    expect(screen.getByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Documents" })).toBeNull();
    expect(screen.queryByText(/notes\.txt/)).toBeNull();
    expect(documentCalls(calls).filter((call) => call.init.method === "GET")).toHaveLength(1);
  });

  it("ends Documents together with the authenticated application after confirmed GitHub disconnection", async () => {
    const user = userEvent.setup();
    await signedInApp({
      other: (call) => (call.url === "/api/unlink/github" ? jsonResponse(200, { status: "ok" }) : jsonResponse(599, {})),
    });
    await documentsLoaded();

    await openSettings();
    await user.click(screen.getByRole("button", { name: "Disconnect GitHub web access" }));
    await user.click(screen.getByRole("button", { name: "Confirm disconnect" }));

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Documents" })).toBeNull();
  });

  it("disables the Documents controls while sign-out is pending", async () => {
    const user = userEvent.setup();
    const gate = deferred<Response>();
    await signedInApp({ documents: () => jsonResponse(200, { items: [created] }), logout: () => gate.promise });
    await within(documentsRegion()).findByText("notes.txt");

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(fileInput().disabled).toBe(true);
    expect(uploadButton().disabled).toBe(true);
    expect(refreshButton().disabled).toBe(true);
    expect(within(documentsRegion()).getByRole<HTMLButtonElement>("button", { name: "Delete" }).disabled).toBe(true);
    await settle(gate, noContentResponse());
    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
  });

  it("leaves Documents usable while an account operation is pending", async () => {
    const user = userEvent.setup();
    const gate = deferred<Response>();
    await signedInApp({
      other: (call) => (call.url === "/api/link/telegram/start" ? gate.promise : jsonResponse(599, {})),
    });
    await documentsLoaded();

    await openSettings();
    await user.click(screen.getByRole("button", { name: "Link Telegram" }));

    expect(screen.getByRole("button", { name: "Disconnect GitHub web access" }).hasAttribute("disabled")).toBe(true);
    expect(fileInput().disabled).toBe(false);
    expect(refreshButton().disabled).toBe(false);
    await settle(gate, jsonResponse(200, ACCOUNT_LINK_RESPONSE));
  });

  it("keeps web chat text-only: uploading a document adds nothing to the chat request, and chat keeps its contract", async () => {
    document.cookie = "csrf_token=dev-csrf; Path=/";
    const user = userEvent.setup();
    let uploaded = false;
    const { calls } = await signedInApp({
      documents: (call) => {
        if (call.init.method === "POST") {
          uploaded = true;
          return jsonResponse(201, created);
        }
        return jsonResponse(200, { items: uploaded ? [created] : [] });
      },
      other: chatOnly,
    });
    await documentsLoaded();

    await user.upload(fileInput(), noteFile());
    await user.click(uploadButton());
    await screen.findByText("Uploaded “notes.txt”.");
    await user.click(screen.getByRole("textbox", { name: "Your message" }));
    await user.paste("How do I square numbers?");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await within(screen.getByRole("log", { name: "Conversation" })).findByText("Use a list comprehension.");

    const chat = calls.filter((call) => call.url === "/api/chat");
    expect(chat).toHaveLength(1);
    expect(JSON.parse(chat[0]?.init.body as string)).toEqual({ message: "How do I square numbers?", history: [] });
    expect(Object.keys(JSON.parse(chat[0]?.init.body as string) as object).sort()).toEqual(["history", "message"]);
    expect(chat[0]?.init.body).not.toMatch(/document|notes|rag|mode|file|scope/i);
    expect(chat[0]?.headers.get("content-type")).toBe("application/json");
    expect(chat[0]?.headers.get("x-csrf-token")).toBe("dev-csrf");
    // The upload itself never touched the chat or settings endpoints.
    const upload = calls.find((call) => call.init.method === "POST" && call.url === "/api/documents");
    expect(upload?.headers.has("content-type")).toBe(false);
    expect(upload?.init.body).toBeInstanceOf(FormData);
    expect(calls.filter((call) => call.url === "/api/settings" && call.init.method !== "GET")).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "You’re signed in" })).toBeTruthy();
  });

  it("keeps the rest of the shell usable, and hides the backend detail, when the documents list cannot load", async () => {
    const user = userEvent.setup();
    await signedInApp({ documents: () => jsonResponse(503, { detail: SENSITIVE_DETAILS[0] }), other: chatOnly });

    const alert = await within(documentsRegion()).findByRole("alert");
    expect(alert.textContent).toContain(SERVER_ERROR_DETAIL);
    expect(document.documentElement.outerHTML).not.toContain(SENSITIVE_DETAILS[0]);
    expect(screen.getByRole("heading", { name: "You’re signed in" })).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Sign out" }).disabled).toBe(false);

    await user.click(screen.getByRole("textbox", { name: "Your message" }));
    await user.paste("hello");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await within(screen.getByRole("log", { name: "Conversation" })).findByText("Use a list comprehension.");
  });

  it("never puts the user id or a document name into a request path, and never writes to browser storage", async () => {
    document.cookie = "csrf_token=dev-csrf; Path=/";
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    let items: unknown[] = [];
    const { calls } = await signedInApp({
      documents: (call) => {
        if (call.init.method === "POST") {
          items = [created];
          return jsonResponse(201, created);
        }
        if (call.init.method === "DELETE") {
          items = [];
          return noContentResponse();
        }
        return jsonResponse(200, { items });
      },
    });
    await documentsLoaded();

    await user.upload(fileInput(), noteFile());
    await user.click(uploadButton());
    await within(documentsRegion()).findByText("Uploaded “notes.txt”.");
    await documentsLoaded();
    await user.click(within(documentsRegion()).getByRole("button", { name: "Delete" }));
    await user.click(within(documentsRegion()).getByRole("button", { name: "Confirm Delete" }));
    await within(documentsRegion()).findByText("Deleted “notes.txt”.");

    for (const call of documentCalls(calls)) {
      expect(call.url).not.toContain(SAMPLE_USER.id);
      expect(call.url).not.toContain("notes");
      expect(call.url).not.toContain("dev-csrf");
    }
    expect(documentCalls(calls).find((call) => call.init.method === "DELETE")?.url).toBe(`/api/documents/${created.id}`);
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});

describe("logout", () => {
  it("POSTs /api/logout with the CSRF header, waits for the server, then shows the anonymous screen", async () => {
    document.cookie = "csrf_token=dev-csrf; Path=/";
    const user = userEvent.setup();
    const gate = deferred<Response>();
    const { calls } = await signedInApp({ logout: () => gate.promise });

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    // In flight: still signed in, control disabled, request already sent correctly.
    const pendingButton = screen.getByRole("button", { name: "Signing out…" });
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("heading", { name: "You’re signed in" })).toBeTruthy();
    const logoutCall = calls.find((call) => call.url === "/api/logout");
    expect(logoutCall?.init.method).toBe("POST");
    expect(logoutCall?.headers.get("x-csrf-token")).toBe("dev-csrf");
    expect(logoutCall?.init.credentials).toBe("same-origin");

    await settle(gate, noContentResponse());

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "You’re signed in" })).toBeNull();
    expect(document.body.textContent).not.toContain("Member since");
    expect(calls.filter((call) => call.url === "/api/logout")).toHaveLength(1);
  });

  it("sends one request even if logout is triggered twice before React re-renders", async () => {
    const user = userEvent.setup();
    const gate = deferred<Response>();
    function DoubleLogout() {
      const { logout } = useAuth();
      return (
        <button
          type="button"
          onClick={() => {
            logout();
            logout();
          }}
        >
          double
        </button>
      );
    }
    const { calls } = backend({ me: () => jsonResponse(200, SAMPLE_USER), logout: () => gate.promise });
    renderApp(<DoubleLogout />);
    await screen.findByRole("heading", { name: "You’re signed in" });

    await user.click(screen.getByRole("button", { name: "double" }));
    await user.click(screen.getByRole("button", { name: "double" }));

    expect(calls.filter((call) => call.url === "/api/logout")).toHaveLength(1);
    await settle(gate, noContentResponse());
  });

  it.each([
    ["HTTP 500", () => jsonResponse(500, { detail: "Something broke" }), SERVER_ERROR_DETAIL],
    ["HTTP 403 (CSRF)", () => jsonResponse(403, { detail: "CSRF validation failed" }), FORBIDDEN_ERROR_DETAIL],
    ["HTTP 429", () => jsonResponse(429, { detail: "Rate limit exceeded" }), RATE_LIMITED_ERROR_DETAIL],
    ["a network failure", networkDown, NETWORK_ERROR_DETAIL],
    ["an unexpected 200", () => textResponse(200, "<html>proxy</html>", "text/html"), UNEXPECTED_RESPONSE_DETAIL],
  ])("does not claim to be logged out after %s, and allows an explicit retry", async (_label, failure, message) => {
    const user = userEvent.setup();
    let attempt = 0;
    const { calls } = await signedInApp({
      logout: () => {
        attempt += 1;
        return attempt === 1 ? failure() : noContentResponse();
      },
    });

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("still signed in");
    expect(alert.textContent).toContain(message);
    expect(document.body.textContent).not.toMatch(/Something broke|CSRF validation failed|Rate limit exceeded|proxy/);
    expect(screen.getByRole("heading", { name: "You’re signed in" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /sign in/i })).toBeNull();
    const retryButton = screen.getByRole("button", { name: "Sign out" });
    expect((retryButton as HTMLButtonElement).disabled).toBe(false);

    // No automatic retry happened.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter((call) => call.url === "/api/logout")).toHaveLength(1);

    await user.click(retryButton);

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(calls.filter((call) => call.url === "/api/logout")).toHaveLength(2);
  });

  it("makes Chat inert while sign-out is pending, then usable again with the same draft when sign-out fails", async () => {
    const user = userEvent.setup();
    const gate = deferred<Response>();
    const { calls } = await signedInApp({
      logout: () => gate.promise,
      other: (call) =>
        call.url === "/api/chat"
          ? jsonResponse(200, { text: "Loops repeat things." })
          : jsonResponse(599, { detail: `unexpected request ${call.url}` }),
    });
    const chatCalls = () => calls.filter((call) => call.url === "/api/chat");
    const composer = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Your message" });
    await user.click(composer);
    await user.paste("How do loops work?");

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    // Pending: the composer and Send are inert, and nothing can start a request.
    expect(composer.disabled).toBe(true);
    const sendButton = screen.getByRole<HTMLButtonElement>("button", { name: "Send" });
    expect(sendButton.disabled).toBe(true);
    await user.click(sendButton);
    await user.type(composer, "{Enter}");
    fireEvent.keyDown(composer, { key: "Enter" });
    fireEvent.submit(composer.closest("form") as HTMLFormElement);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(chatCalls()).toHaveLength(0);
    expect(composer.value).toBe("How do loops work?");

    // The sign-out fails: still signed in, and Chat is back exactly as it was left.
    await settle(gate, jsonResponse(500, { detail: "Something broke" }));
    expect((await screen.findByRole("alert")).textContent).toContain("still signed in");
    expect(screen.getByRole("heading", { name: "You’re signed in" })).toBeTruthy();
    expect(composer.disabled).toBe(false);
    expect(composer.value).toBe("How do loops work?");
    expect(chatCalls()).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Loops repeat things.")).toBeTruthy();
    expect(chatCalls()).toHaveLength(1);
    expect(JSON.parse(chatCalls()[0]?.init.body as string)).toEqual({ message: "How do loops work?", history: [] });
  });

  it("goes anonymous when the server answers 401 (session already invalid) and leaves no stale error", async () => {
    const user = userEvent.setup();
    await signedInApp({ logout: () => jsonResponse(401, { detail: "Not authenticated" }) });

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("backend error text is never rendered", () => {
  const spyOnConsole = () =>
    (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );

  it("does not render markup from a backend detail, as HTML or as text", async () => {
    const markup = "<img src=x onerror=alert(1)><script>window.pwned=1</script>";
    backend({ me: () => jsonResponse(500, { detail: markup }) });

    const { container } = renderApp();

    await screen.findByRole("heading", { name: "We couldn’t verify your session" });
    expect(container.textContent).not.toContain(markup);
    expect(container.textContent).not.toContain("pwned");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(Reflect.get(window, "pwned")).toBeUndefined();
    expect(screen.getByText(SERVER_ERROR_DETAIL)).toBeTruthy();
  });

  it.each(SENSITIVE_DETAILS)("keeps %j off the session-verification screen, the DOM, and the console", async (secret) => {
    const consoleSpies = spyOnConsole();
    backend({ me: () => jsonResponse(500, { detail: secret }) });

    const { container } = renderApp();
    await screen.findByRole("heading", { name: "We couldn’t verify your session" });

    expect(screen.getByText(SERVER_ERROR_DETAIL)).toBeTruthy();
    expect(container.textContent).not.toContain(secret);
    expect(document.documentElement.outerHTML).not.toContain(secret);
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it.each(SENSITIVE_DETAILS)("keeps %j off the logout-failure notice, the DOM, and the console", async (secret) => {
    const consoleSpies = spyOnConsole();
    const user = userEvent.setup();
    await signedInApp({ logout: () => jsonResponse(500, { detail: secret }) });

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain("still signed in");
    expect(alert.textContent).toContain(SERVER_ERROR_DETAIL);
    expect(alert.textContent).not.toContain(secret);
    expect(document.documentElement.outerHTML).not.toContain(secret);
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("does not render a backend logout detail, even markup, as HTML or text", async () => {
    const user = userEvent.setup();
    await signedInApp({ logout: () => jsonResponse(500, { detail: "<b>bold</b> failure" }) });

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("alert");

    expect(document.body.querySelector("b")).toBeNull();
    expect(document.body.textContent).not.toContain("bold");
  });
});

describe("browser storage and cookies", () => {
  it("never persists anything or writes cookies through a full sign-in and sign-out", async () => {
    document.cookie = "csrf_token=dev-csrf; Path=/";
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const cookieWrites = vi.spyOn(document, "cookie", "set");
    const user = userEvent.setup();
    await signedInApp({ logout: () => noContentResponse() });

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("link", { name: "Sign in with GitHub" });

    expect(setItem).not.toHaveBeenCalled();
    expect(cookieWrites).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("never puts the user id or CSRF token into a request URL", async () => {
    document.cookie = "csrf_token=dev-csrf; Path=/";
    const user = userEvent.setup();
    const { calls } = await signedInApp({ logout: () => noContentResponse() });
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("link", { name: "Sign in with GitHub" });

    for (const call of calls) {
      expect(call.url).not.toContain(SAMPLE_USER.id);
      expect(call.url).not.toContain("dev-csrf");
      expect(call.init.body).toBeUndefined();
    }
  });
});

describe("authenticated shell hierarchy", () => {
  it("makes Chat and then Documents the primary content, and keeps account and preferences out of it", async () => {
    await signedInApp();

    const main = screen.getByRole("main");
    const chat = within(main).getByRole("region", { name: "Ask the assistant" });
    const documents = within(main).getByRole("region", { name: "Documents" });
    expect(chat.compareDocumentPosition(documents) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(chat).getByRole("log", { name: "Conversation" })).toBeTruthy();
    expect(within(chat).getByRole("textbox", { name: "Your message" })).toBeTruthy();
    // Nothing else is in the workspace: account and preferences are in Settings.
    expect(main.querySelector(".account-panel, .settings-panel, .facts")).toBeNull();
    expect(main.textContent).not.toContain("Member since");
    expect(main.textContent).not.toContain("Account connections");
  });

  it("puts Account connections, the Settings preference and Member since in the Settings side panel, not in the workspace", async () => {
    await signedInApp();
    await openSettings();

    const panel = screen.getByRole("complementary", { name: "Account and settings" });
    expect(within(panel).getByRole("region", { name: "Account connections" })).toBeTruthy();
    expect(within(panel).getByRole("region", { name: "Settings" })).toBeTruthy();
    expect(within(panel).getByText("Member since")).toBeTruthy();
    expect(within(panel).getByText(/2026/)).toBeTruthy();
    expect(panel.contains(screen.getByRole("main"))).toBe(false);
    expect(screen.getByRole("main").contains(panel)).toBe(false);
    expect(within(panel).queryByRole("region", { name: "Documents" })).toBeNull();
    expect(within(panel).queryByRole("region", { name: "Ask the assistant" })).toBeNull();
  });

  it("keeps Sign out, the language switcher and the Settings button in the header, open or closed", async () => {
    await signedInApp();
    const header = screen.getByRole("banner");
    const inHeader = () => ({
      signOut: within(header).queryByRole("button", { name: "Sign out" }),
      language: within(header).queryByRole("group", { name: "Language" }),
      settings: within(header).queryByRole("button", { name: "Settings" }),
    });

    expect(Object.values(inHeader()).every((element) => element !== null)).toBe(true);
    await openSettings();
    expect(Object.values(inHeader()).every((element) => element !== null)).toBe(true);
  });

  it("names the product in the header without translating it", async () => {
    await signedInApp();

    expect(within(screen.getByRole("banner")).getByText("Multimodal Learning Assistant")).toBeTruthy();
  });

  it("is domain-neutral: no Python or tutor framing anywhere in the signed-in shell", async () => {
    await signedInApp();
    await openSettings();

    const visibleText = [screen.getByRole("banner"), screen.getByRole("main")].map((part) => part.textContent).join(" ");
    expect(visibleText).not.toMatch(/python|tutor/i);
  });
});

describe("Settings side panel", () => {
  const trigger = () => screen.getByRole<HTMLButtonElement>("button", { name: "Settings" });
  // A hidden panel is outside the accessibility tree, and its accessible name is not computed: ask for it
  // explicitly, and check its label separately.
  const panel = () => screen.getByRole("complementary", { hidden: true });
  const panelLabel = () => document.getElementById(panel().getAttribute("aria-labelledby") ?? "")?.textContent;

  it("starts closed, but mounted: a non-modal disclosure the trigger names and controls", async () => {
    await signedInApp();

    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().getAttribute("aria-controls")).toBe(panel().id);
    expect(panelLabel()).toBe("Account and settings");
    expect(panel().hidden).toBe(true);
    // Mounted: its contents exist (and would be reachable to assistive technology the moment it opens).
    expect(panel().querySelector(".account-panel")).not.toBeNull();
    expect(panel().querySelector(".settings-panel")).not.toBeNull();
    expect(screen.queryByRole("complementary", { name: "Account and settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Link Telegram" })).toBeNull();
    expect(within(panel()).getByRole("button", { name: "Link Telegram", hidden: true })).toBeTruthy();
  });

  it("is not a dialog: no dialog role, no aria-modal, nothing inert, in either state", async () => {
    await signedInApp();
    const check = () => {
      expect(document.querySelector("[aria-modal]")).toBeNull();
      expect(document.querySelector('[role="dialog"], [role="alertdialog"], dialog')).toBeNull();
      expect(document.querySelector("[inert]")).toBeNull();
      expect(panel().getAttribute("role")).toBeNull();
    };

    check();
    await openSettings();
    check();
  });

  it("opens on click: expanded and visible, focus moves into the panel, and the rest of the page stays live", async () => {
    const user = userEvent.setup();
    await signedInApp();

    await user.click(trigger());

    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(panel().hidden).toBe(false);
    expect(screen.getByRole("complementary", { name: "Account and settings" })).toBeTruthy();
    expect(document.activeElement).toBe(within(panel()).getByRole("heading", { name: "Account and settings" }));
    expect(panel().contains(document.activeElement)).toBe(true);

    // Non-modal: the chat and the header are neither inert nor hidden from assistive technology.
    const main = screen.getByRole("main");
    expect(main.hasAttribute("inert")).toBe(false);
    expect(main.closest("[aria-hidden]")).toBeNull();
    expect(screen.getByRole("banner").hasAttribute("inert")).toBe(false);
    await user.click(screen.getByRole("textbox", { name: "Your message" }));
    await user.paste("still typing");
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Your message" }).value).toBe("still typing");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Sign out" }).disabled).toBe(false);
    // Focus was free to leave the panel: there is no trap.
    expect(panel().contains(document.activeElement)).toBe(false);
  });

  it("closes with its Close button, and focus returns to the Settings button", async () => {
    const user = userEvent.setup();
    await signedInApp();
    await user.click(trigger());

    await user.click(within(panel()).getByRole("button", { name: "Close" }));

    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("closes with the Settings button itself", async () => {
    const user = userEvent.setup();
    await signedInApp();
    await user.click(trigger());

    await user.click(trigger());

    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on Escape from where focus landed when it opened, and focus returns to the Settings button", async () => {
    const user = userEvent.setup();
    await signedInApp();
    await user.click(trigger());
    expect(panel().contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");

    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on Escape from a control inside the panel", async () => {
    const user = userEvent.setup();
    await signedInApp();
    await user.click(trigger());
    const mode = within(panel()).getByRole<HTMLSelectElement>("combobox", { name: "Preferred mode" });
    await waitFor(() => expect(mode.disabled).toBe(false));
    mode.focus();
    expect(document.activeElement).toBe(mode);

    await user.keyboard("{Escape}");

    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on Escape from the Settings button while open", async () => {
    const user = userEvent.setup();
    await signedInApp();
    await user.click(trigger());
    trigger().focus();

    await user.keyboard("{Escape}");

    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on Escape when an action inside the panel has left focus nowhere, as removing the focused button does", async () => {
    const user = userEvent.setup();
    await signedInApp();
    await user.click(trigger());
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);

    await user.keyboard("{Escape}");

    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("ignores Escape while focus is in the workspace: it is not a modal, so it does not grab the key", async () => {
    const user = userEvent.setup();
    await signedInApp();
    await user.click(trigger());
    await user.click(screen.getByRole("textbox", { name: "Your message" }));

    await user.keyboard("{Escape}");

    expect(panel().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Your message" }));
  });

  it("does nothing on Escape while closed, and does not move focus", async () => {
    const user = userEvent.setup();
    await signedInApp();
    trigger().focus();

    await user.keyboard("{Escape}");

    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("opens again after closing, moving focus into the panel each time", async () => {
    const user = userEvent.setup();
    await signedInApp();

    for (let round = 0; round < 3; round += 1) {
      await user.click(trigger());
      expect(panel().hidden).toBe(false);
      expect(panel().contains(document.activeElement)).toBe(true);
      await user.keyboard("{Escape}");
      expect(panel().hidden).toBe(true);
      expect(document.activeElement).toBe(trigger());
    }
  });

  it("keeps an issued Telegram link, the very same element, across closing and reopening", async () => {
    const user = userEvent.setup();
    await signedInApp({
      other: (call) => (call.url === "/api/link/telegram/start" ? jsonResponse(200, ACCOUNT_LINK_RESPONSE) : jsonResponse(599, {})),
    });
    await openSettings();
    await user.click(screen.getByRole("button", { name: "Link Telegram" }));
    const link = await screen.findByRole("link", { name: "Open Telegram" });

    await user.keyboard("{Escape}");
    expect(panel().hidden).toBe(true);
    expect(link.isConnected).toBe(true);
    expect(panel().contains(link)).toBe(true);
    expect(screen.queryByRole("link", { name: "Open Telegram" })).toBeNull();

    await user.click(trigger());
    expect(screen.getByRole("link", { name: "Open Telegram" })).toBe(link);
    expect(link.getAttribute("href")).toBe(ACCOUNT_LINK_RESPONSE.deep_link);
  });

  it("does not disturb an account operation in flight when the panel is closed, and shows its result when reopened", async () => {
    const user = userEvent.setup();
    const gate = deferred<Response>();
    const { calls } = await signedInApp({
      other: (call) => (call.url === "/api/link/telegram/start" ? gate.promise : jsonResponse(599, {})),
    });
    await openSettings();
    await user.click(screen.getByRole("button", { name: "Link Telegram" }));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Sign out" }).disabled).toBe(true);

    await user.keyboard("{Escape}");
    expect(panel().hidden).toBe(true);
    // Still pending, still guarding sign-out, while the panel is out of sight.
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Sign out" }).disabled).toBe(true);

    await settle(gate, jsonResponse(200, ACCOUNT_LINK_RESPONSE));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Sign out" }).disabled).toBe(false));
    await user.click(trigger());

    expect(screen.getByRole("link", { name: "Open Telegram" }).getAttribute("href")).toBe(ACCOUNT_LINK_RESPONSE.deep_link);
    expect(calls.filter((call) => call.url === "/api/link/telegram/start")).toHaveLength(1);
  });

  it("loads Settings once, when the shell mounts, however often the panel is opened and closed", async () => {
    const user = userEvent.setup();
    const { calls } = await signedInApp({ settings: () => jsonResponse(200, { mode: "rag" }) });

    for (let round = 0; round < 3; round += 1) {
      await user.click(trigger());
      await user.keyboard("{Escape}");
    }
    await user.click(trigger());

    await waitFor(() =>
      expect(within(panel()).getByRole<HTMLSelectElement>("combobox", { name: "Preferred mode" }).value).toBe("rag"),
    );
    expect(calls.filter((call) => call.url === "/api/settings")).toHaveLength(1);
    expect(calls.filter((call) => call.url.startsWith("/api/documents"))).toHaveLength(1);
  });

  it("goes away with the rest of the shell when the session ends, open or closed", async () => {
    const user = userEvent.setup();
    await signedInApp({ logout: () => noContentResponse() });
    await user.click(trigger());

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { hidden: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  });
});

describe("interface language", () => {
  const languageGroup = () => screen.getByRole("group", { name: /^(Language|Язык)$/ });
  const pressedLanguages = () =>
    within(languageGroup())
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-pressed") === "true")
      .map((button) => button.textContent);
  const setBrowserLanguages = (languages: string[]) =>
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(languages);
  const anonymousApp = () => backend({ me: () => jsonResponse(401, { detail: "Not authenticated" }) });
  const storeLocale = (value: string) => localStorage.setItem(LOCALE_STORAGE_KEY, value);
  const storedKeys = () => Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));

  describe("switcher", () => {
    it("is on the loading screen", async () => {
      const gate = deferred<Response>();
      backend({ me: () => gate.promise });
      renderApp();

      expect(screen.getByRole("status")).toBeTruthy();
      expect(pressedLanguages()).toEqual(["English"]);
      expect(within(screen.getByRole("status")).queryByRole("button")).toBeNull();
      await settle(gate, jsonResponse(401, { detail: "Not authenticated" }));
    });

    it("is on the sign-in screen", async () => {
      anonymousApp();
      renderApp();
      await screen.findByRole("link", { name: "Sign in with GitHub" });

      expect(pressedLanguages()).toEqual(["English"]);
      expect(within(languageGroup()).getAllByRole("button").map((button) => button.textContent)).toEqual([
        "English",
        "Русский",
      ]);
    });

    it("is on the verification-error screen", async () => {
      backend({ me: networkDown });
      renderApp();
      await screen.findByRole("button", { name: "Try again" });

      expect(pressedLanguages()).toEqual(["English"]);
    });

    it("is in the authenticated shell", async () => {
      await signedInApp();

      expect(pressedLanguages()).toEqual(["English"]);
      expect(within(screen.getByRole("banner")).getByRole("group", { name: "Language" })).toBe(languageGroup());
    });

    it("names each language in itself, tagged with its own language", async () => {
      anonymousApp();
      renderApp();
      await screen.findByRole("link", { name: "Sign in with GitHub" });

      expect(screen.getByRole("button", { name: "English" }).getAttribute("lang")).toBe("en");
      expect(screen.getByRole("button", { name: "Русский" }).getAttribute("lang")).toBe("ru");
    });
  });

  describe("Russian", () => {
    it("renders the loading screen", async () => {
      storeLocale("ru");
      const gate = deferred<Response>();
      backend({ me: () => gate.promise });
      renderApp();

      expect(screen.getByRole("status").textContent).toContain("Проверяем вашу сессию");
      expect(screen.getByRole("group", { name: "Язык" })).toBeTruthy();
      expect(document.body.textContent).not.toContain("Checking your session");
      await settle(gate, jsonResponse(401, { detail: "Not authenticated" }));
    });

    it("renders the sign-in screen, with the same plain link to the backend", async () => {
      storeLocale("ru");
      anonymousApp();
      renderApp();

      const link = await screen.findByRole("link", { name: "Войти через GitHub" });
      expect(link.tagName).toBe("A");
      expect(link.getAttribute("href")).toBe("/api/auth/github/login");
      expect(link.getAttribute("target")).toBeNull();
      expect(screen.getByRole("heading", { level: 1, name: "Multimodal Learning Assistant" })).toBeTruthy();
      expect(screen.getByText("Чтобы продолжить, нужно войти.")).toBeTruthy();
      expect(document.body.textContent).not.toContain("Sign in with GitHub");
      expect(pressedLanguages()).toEqual(["Русский"]);
    });

    it("does not hijack the sign-in link's click either", async () => {
      storeLocale("ru");
      const user = userEvent.setup();
      const { calls } = anonymousApp();
      renderApp();
      const link = await screen.findByRole("link", { name: "Войти через GitHub" });

      const seen: boolean[] = [];
      const observer = (event: MouseEvent) => {
        seen.push(event.defaultPrevented);
        event.preventDefault();
      };
      document.addEventListener("click", observer);
      await user.click(link);
      document.removeEventListener("click", observer);

      expect(seen).toEqual([false]);
      expect(calls.map((call) => call.url)).toEqual(["/api/me"]);
    });

    it("renders the verification-error screen, its fixed message translated, without saying the user is signed out", async () => {
      storeLocale("ru");
      backend({ me: networkDown });
      renderApp();

      expect(await screen.findByRole("heading", { name: "Не удалось проверить вашу сессию" })).toBeTruthy();
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("Вы не вышли из аккаунта");
      expect(alert.textContent).toContain("Не удаётся связаться с сервером");
      expect(alert.textContent).not.toContain(NETWORK_ERROR_DETAIL);
      expect(screen.getByRole("button", { name: "Повторить" })).toBeTruthy();
      expect(screen.queryByRole("link", { name: /войти/i })).toBeNull();
    });

    it.each([
      [403, "Сервер отклонил запрос"],
      [429, "Слишком много запросов"],
      [500, "На сервере возникла проблема"],
    ])("translates the fixed message for HTTP %i on the verification-error screen", async (status, expected) => {
      storeLocale("ru");
      backend({ me: () => jsonResponse(status, { detail: "backend prose" }) });
      renderApp();

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(expected);
      expect(alert.textContent).not.toContain("backend prose");
    });

    it("renders the authenticated shell and the chat", async () => {
      storeLocale("ru");
      const user = userEvent.setup();
      await signedInApp();

      expect(screen.getByRole("heading", { level: 1, name: "Вы вошли в систему" })).toBeTruthy();
      const header = within(screen.getByRole("banner"));
      expect(header.getByText("Multimodal Learning Assistant")).toBeTruthy();
      expect(header.getByRole("button", { name: "Выйти" })).toBeTruthy();
      expect(header.getByRole("button", { name: "Настройки" })).toBeTruthy();
      expect(header.getByRole("group", { name: "Язык" })).toBeTruthy();
      const chat = within(screen.getByRole("region", { name: "Спросите ассистента" }));
      expect(chat.getByRole("log", { name: "Переписка" })).toBeTruthy();
      expect(chat.getByText("Задайте вопрос, чтобы начать.")).toBeTruthy();
      expect(chat.getByRole("textbox", { name: "Ваше сообщение" })).toBeTruthy();
      expect(chat.getByRole("button", { name: "Отправить" })).toBeTruthy();
      expect(chat.getByText(/Enter — отправить/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
      expect(document.body.textContent).not.toContain("Ask the assistant");

      await user.click(header.getByRole("button", { name: "Настройки" }));
      const panel = within(screen.getByRole("complementary", { name: "Аккаунт и настройки" }));
      expect(panel.getByText("Дата регистрации")).toBeTruthy();
      expect(panel.getByText(/января 2026/)).toBeTruthy();
      expect(panel.getByRole("button", { name: "Закрыть" })).toBeTruthy();
    });

    it("renders a failed sign-out in Russian, keeping the fixed message and hiding the backend's", async () => {
      storeLocale("ru");
      const user = userEvent.setup();
      await signedInApp({ logout: () => jsonResponse(500, { detail: SENSITIVE_DETAILS[0] }) });

      await user.click(screen.getByRole("button", { name: "Выйти" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Не удалось подтвердить выход");
      expect(alert.textContent).toContain("На сервере возникла проблема");
      expect(document.documentElement.outerHTML).not.toContain(SENSITIVE_DETAILS[0]);
    });

    it("renders a chat failure and the sending state in Russian", async () => {
      storeLocale("ru");
      const user = userEvent.setup();
      const gate = deferred<Response>();
      await signedInApp({ other: (call) => (call.url === "/api/chat" ? gate.promise : jsonResponse(599, {})) });
      await user.click(screen.getByRole("textbox", { name: "Ваше сообщение" }));
      await user.paste("Привет");

      await user.click(screen.getByRole("button", { name: "Отправить" }));

      expect(screen.getByRole("status").textContent).toContain("Ждём ответ");
      expect(screen.getByRole("button", { name: "Отправляем…" })).toBeTruthy();
      await settle(gate, jsonResponse(500, { detail: "boom" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Ваше сообщение не добавлено в переписку");
      expect(alert.textContent).toContain("На сервере возникла проблема");
    });
  });

  describe("switching", () => {
    it("updates the visible text, <html lang> and the title, both ways", async () => {
      const user = userEvent.setup();
      anonymousApp();
      renderApp();
      await screen.findByRole("link", { name: "Sign in with GitHub" });
      expect(document.documentElement.lang).toBe("en");
      expect(document.title).toBe("Sign in — Multimodal Learning Assistant");

      await user.click(screen.getByRole("button", { name: "Русский" }));

      expect(screen.getByRole("link", { name: "Войти через GitHub" })).toBeTruthy();
      expect(screen.queryByRole("link", { name: "Sign in with GitHub" })).toBeNull();
      expect(document.documentElement.lang).toBe("ru");
      expect(document.title).toBe("Вход — Multimodal Learning Assistant");
      expect(pressedLanguages()).toEqual(["Русский"]);

      await user.click(screen.getByRole("button", { name: "English" }));

      expect(screen.getByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
      expect(document.documentElement.lang).toBe("en");
      expect(document.title).toBe("Sign in — Multimodal Learning Assistant");
      expect(pressedLanguages()).toEqual(["English"]);
    });

    it("switches the verification-error screen without another request, and retranslates its message", async () => {
      const user = userEvent.setup();
      const { calls } = backend({ me: networkDown });
      renderApp();
      await screen.findByRole("button", { name: "Try again" });
      expect(document.title).toBe("Can’t verify your session — Multimodal Learning Assistant");

      await user.click(screen.getByRole("button", { name: "Русский" }));

      expect(screen.getByRole("heading", { name: "Не удалось проверить вашу сессию" })).toBeTruthy();
      expect(screen.getByText(/Не удаётся связаться с сервером/)).toBeTruthy();
      expect(document.title).toBe("Не удалось проверить сессию — Multimodal Learning Assistant");
      expect(calls).toHaveLength(1);
    });

    it("titles the loading and signed-in screens with the product name alone, in either language", async () => {
      const user = userEvent.setup();
      const gate = deferred<Response>();
      backend({ me: () => gate.promise, logout: () => noContentResponse() });
      renderApp();
      expect(document.title).toBe("Multimodal Learning Assistant");

      await user.click(screen.getByRole("button", { name: "Русский" }));
      expect(document.title).toBe("Multimodal Learning Assistant");

      await settle(gate, jsonResponse(200, SAMPLE_USER));
      await screen.findByRole("heading", { name: "Вы вошли в систему" });
      expect(document.title).toBe("Multimodal Learning Assistant");
      expect(document.documentElement.lang).toBe("ru");
    });

    it("switches the signed-in shell in place: same elements, same draft, same open panel, no requests", async () => {
      const user = userEvent.setup();
      const { calls } = await signedInApp({
        other: (call) => (call.url === "/api/link/telegram/start" ? jsonResponse(200, ACCOUNT_LINK_RESPONSE) : jsonResponse(599, {})),
      });
      await openSettings();
      await user.click(screen.getByRole("button", { name: "Link Telegram" }));
      const link = await screen.findByRole("link", { name: "Open Telegram" });
      const composer = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Your message" });
      await user.click(composer);
      await user.paste("half-written thought");
      const requestsBefore = calls.length;

      await user.click(screen.getByRole("button", { name: "Русский" }));

      // Nothing was remounted: not the composer (and its draft), not the issued link, not the panel.
      expect(screen.getByRole("textbox", { name: "Ваше сообщение" })).toBe(composer);
      expect(composer.value).toBe("half-written thought");
      expect(screen.getByRole("link", { name: "Open Telegram" })).toBe(link);
      expect(screen.getByRole("button", { name: "Настройки" }).getAttribute("aria-expanded")).toBe("true");
      expect(calls).toHaveLength(requestsBefore);
    });

    it("retranslates a chat error that is already on screen", async () => {
      const user = userEvent.setup();
      await signedInApp({ other: networkDown });
      await user.click(screen.getByRole("textbox", { name: "Your message" }));
      await user.paste("hello");
      await user.click(screen.getByRole("button", { name: "Send" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("wasn’t added to the conversation");
      expect(alert.textContent).toContain(NETWORK_ERROR_DETAIL);

      await user.click(screen.getByRole("button", { name: "Русский" }));

      expect(alert.textContent).toContain("Ваше сообщение не добавлено в переписку");
      expect(alert.textContent).toContain("Не удаётся связаться с сервером");
      expect(alert.textContent).not.toContain(NETWORK_ERROR_DETAIL);
    });

    it("formats the member-since date in the chosen language", async () => {
      const user = userEvent.setup();
      await signedInApp();
      await openSettings();
      const panel = () => within(screen.getByRole("complementary", { name: "Account and settings" }));
      expect(panel().getByText(/January 1[456], 2026/)).toBeTruthy();

      await user.click(screen.getByRole("button", { name: "Русский" }));

      expect(within(screen.getByRole("complementary", { name: "Аккаунт и настройки" })).getByText(/января 2026/)).toBeTruthy();
    });
  });

  describe("persistence", () => {
    it("writes nothing to storage or cookies until the user switches", async () => {
      document.cookie = "csrf_token=dev-csrf; Path=/";
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      const cookieWrites = vi.spyOn(document, "cookie", "set");
      setBrowserLanguages(["ru-RU"]);
      anonymousApp();

      renderApp();
      await screen.findByRole("link", { name: "Войти через GitHub" });

      // Detected from the browser, not stored.
      expect(setItem).not.toHaveBeenCalled();
      expect(cookieWrites).not.toHaveBeenCalled();
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    });

    it("writes exactly the approved locale key, and nothing else, when the user switches", async () => {
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      const removeItem = vi.spyOn(Storage.prototype, "removeItem");
      const cookieWrites = vi.spyOn(document, "cookie", "set");
      const user = userEvent.setup();
      anonymousApp();
      renderApp();
      await screen.findByRole("link", { name: "Sign in with GitHub" });

      await user.click(screen.getByRole("button", { name: "Русский" }));
      await user.click(screen.getByRole("button", { name: "English" }));
      await user.click(screen.getByRole("button", { name: "Русский" }));

      expect(setItem.mock.calls).toEqual([
        [LOCALE_STORAGE_KEY, "ru"],
        [LOCALE_STORAGE_KEY, "en"],
        [LOCALE_STORAGE_KEY, "ru"],
      ]);
      expect(removeItem).not.toHaveBeenCalled();
      expect(cookieWrites).not.toHaveBeenCalled();
      expect(localStorage.length).toBe(1);
      expect(storedKeys()).toEqual([LOCALE_STORAGE_KEY]);
      expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("ru");
      expect(sessionStorage.length).toBe(0);
    });

    it("stores no session, user, chat or document data even after a busy signed-in session in Russian", async () => {
      document.cookie = "csrf_token=dev-csrf; Path=/";
      const user = userEvent.setup();
      await signedInApp({
        other: (call) => (call.url === "/api/chat" ? jsonResponse(200, { text: "Ответ" }) : jsonResponse(599, {})),
        logout: () => noContentResponse(),
      });
      await user.click(screen.getByRole("button", { name: "Русский" }));
      await user.click(screen.getByRole("textbox", { name: "Ваше сообщение" }));
      await user.paste("Секретный вопрос");
      await user.click(screen.getByRole("button", { name: "Отправить" }));
      await within(screen.getByRole("log", { name: "Переписка" })).findByText("Ответ");
      await user.click(screen.getByRole("button", { name: "Выйти" }));
      await screen.findByRole("link", { name: "Войти через GitHub" });

      expect(storedKeys()).toEqual([LOCALE_STORAGE_KEY]);
      expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("ru");
      expect(sessionStorage.length).toBe(0);
    });

    it("remembers the choice for the next visit, across a sign-out too", async () => {
      const user = userEvent.setup();
      anonymousApp();
      const first = renderApp();
      await screen.findByRole("link", { name: "Sign in with GitHub" });
      await user.click(screen.getByRole("button", { name: "Русский" }));
      first.unmount();

      anonymousApp();
      renderApp();

      expect(await screen.findByRole("link", { name: "Войти через GitHub" })).toBeTruthy();
      expect(document.documentElement.lang).toBe("ru");
    });

    it("prefers a stored choice over the browser's language", async () => {
      storeLocale("en");
      setBrowserLanguages(["ru-RU", "en-US"]);
      anonymousApp();

      renderApp();

      expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
      expect(document.documentElement.lang).toBe("en");
    });

    it.each(["de", "EN", "ru ", "", "null", '{"locale":"ru"}', "русский"])(
      "ignores the invalid stored value %j and uses the browser's language",
      async (invalid) => {
        storeLocale(invalid);
        setBrowserLanguages(["ru-RU", "en-US"]);
        anonymousApp();

        renderApp();

        expect(await screen.findByRole("link", { name: "Войти через GitHub" })).toBeTruthy();
        expect(document.documentElement.lang).toBe("ru");
      },
    );

    it("uses the first supported browser language, by primary subtag, and English when there is none", async () => {
      setBrowserLanguages(["de-DE", "ru", "en"]);
      anonymousApp();
      const first = renderApp();
      expect(await screen.findByRole("link", { name: "Войти через GitHub" })).toBeTruthy();
      first.unmount();

      setBrowserLanguages(["de-DE", "fr"]);
      anonymousApp();
      renderApp();
      expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
      expect(document.documentElement.lang).toBe("en");
    });

    it("still works, in memory, when storage is unavailable", async () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
      const user = userEvent.setup();
      anonymousApp();
      renderApp();
      await screen.findByRole("link", { name: "Sign in with GitHub" });

      await user.click(screen.getByRole("button", { name: "Русский" }));

      expect(screen.getByRole("link", { name: "Войти через GitHub" })).toBeTruthy();
      expect(document.documentElement.lang).toBe("ru");
    });
  });
});

describe("waiting helpers sanity", () => {
  it("lets waitFor observe the loading state clear", async () => {
    backend({ me: () => jsonResponse(401, { detail: "Not authenticated" }) });
    renderApp();
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });
});
