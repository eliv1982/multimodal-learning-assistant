import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { CurrentUser } from "../api/types";
import type { LogoutState } from "../auth/AuthContext";
import { PRODUCT_NAME } from "../branding";
import { apiErrorMessage } from "../i18n/apiErrors";
import type { Locale } from "../i18n/locale";
import { useI18n } from "../i18n/useI18n";
import { AccountLinkingPanel } from "./AccountLinkingPanel";
import { ChatPanel } from "./ChatPanel";
import { DocumentsPanel } from "./DocumentsPanel";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { SettingsPanel } from "./SettingsPanel";

function formatMemberSince(createdAt: string, locale: Locale): string | null {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(date);
}

interface AuthenticatedShellProps {
  user: CurrentUser;
  logoutState: LogoutState;
  onLogout: () => void;
}

/**
 * The signed-in shell. The canonical user id is intentionally never shown.
 *
 * Chat and Documents are the workspaces. Account and preferences live in a
 * Settings side panel that the header button discloses. It is deliberately
 * non-modal: it is a plain `aside` (not a dialog, no `aria-modal`), the rest of
 * the page stays available and is never made inert, and so there is no focus
 * trap. Opening moves focus into it; Escape or Close closes it and returns focus
 * to the button. Escape counts while focus is in the panel, on its button, or
 * nowhere (an action inside the panel can remove the focused control, which
 * drops focus to the page); never while focus is in the workspace, so the key is
 * not taken from whatever the user is doing there.
 *
 * The panel is always mounted and only hidden while closed. Closing it must not
 * discard an issued Telegram link, a pending confirmation or an in-flight
 * account operation, which live in the panels inside it.
 */
export function AuthenticatedShell({ user, logoutState, onLogout }: AuthenticatedShellProps) {
  const { locale, t } = useI18n();
  const memberSince = formatMemberSince(user.created_at, locale);
  const [accountOperationPending, setAccountOperationPending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const settingsPanel = useRef<HTMLElement>(null);
  const settingsTitle = useRef<HTMLHeadingElement>(null);
  const settingsPanelId = useId();
  const settingsTitleId = useId();

  useEffect(() => {
    if (settingsOpen) {
      settingsTitle.current?.focus();
    }
  }, [settingsOpen]);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    settingsTrigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      const target = event.target;
      const focusIsNowhere = target === document.body || target === document.documentElement;
      const focusIsHere =
        target instanceof Node &&
        (settingsPanel.current?.contains(target) === true || settingsTrigger.current?.contains(target) === true);
      if (focusIsNowhere || focusIsHere) {
        closeSettings();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [settingsOpen, closeSettings]);

  return (
    <div className="shell">
      <header className="shell-header">
        <span className="brand">{PRODUCT_NAME}</span>
        <div className="shell-actions">
          <LanguageSwitcher />
          <button
            ref={settingsTrigger}
            type="button"
            className="button button-secondary"
            aria-expanded={settingsOpen}
            aria-controls={settingsPanelId}
            onClick={() => (settingsOpen ? closeSettings() : setSettingsOpen(true))}
          >
            {t("shell.settings")}
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={onLogout}
            disabled={logoutState.pending || accountOperationPending}
          >
            {logoutState.pending ? t("shell.signingOut") : t("shell.signOut")}
          </button>
        </div>
      </header>
      <div className="shell-body">
        <aside
          ref={settingsPanel}
          id={settingsPanelId}
          className="settings-drawer"
          aria-labelledby={settingsTitleId}
          hidden={!settingsOpen}
        >
          <div className="settings-drawer-header">
            <h2 id={settingsTitleId} ref={settingsTitle} tabIndex={-1}>
              {t("shell.settingsTitle")}
            </h2>
            <button type="button" className="button button-secondary" onClick={closeSettings}>
              {t("shell.settingsClose")}
            </button>
          </div>
          {memberSince !== null && (
            <dl className="facts">
              <div>
                <dt>{t("shell.memberSince")}</dt>
                <dd>{memberSince}</dd>
              </div>
            </dl>
          )}
          <AccountLinkingPanel
            user={user}
            disabled={logoutState.pending}
            onOperationPendingChange={setAccountOperationPending}
          />
          <SettingsPanel disabled={logoutState.pending} />
        </aside>
        <main className="shell-main">
          <h1 className="visually-hidden">{t("shell.signedIn")}</h1>
          {logoutState.error !== null && (
            <div className="notice notice-error" role="alert">
              <p>{t("shell.signOutFailed")}</p>
              <p className="muted">{apiErrorMessage(logoutState.error, t)}</p>
            </div>
          )}
          <div className="workspaces">
            <ChatPanel disabled={logoutState.pending} />
            <DocumentsPanel telegramLinked={user.telegram_linked} disabled={logoutState.pending} />
          </div>
        </main>
      </div>
    </div>
  );
}
