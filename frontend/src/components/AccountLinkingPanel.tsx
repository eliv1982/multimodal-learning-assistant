import { useCallback, useEffect, useRef, useState } from "react";

import { unlinkGithub, startTelegramLink } from "../api/accountLinking";
import { ApiError, isUnauthorized, toApiError } from "../api/client";
import type { CurrentUser, TelegramLinkStartResponse } from "../api/types";
import { useAuth } from "../auth/useAuth";
import { apiErrorMessage } from "../i18n/apiErrors";
import type { Locale } from "../i18n/locale";
import type { Translate } from "../i18n/translate";
import { useI18n } from "../i18n/useI18n";

type Operation = "start" | "check" | "unlink";

/**
 * Semantic classification of an operation failure, never rendered text. Only
 * "generic" carries data (the client-owned `ApiError`, translated through the
 * shared `apiErrorMessage` mapping); the three special cases need no data of
 * their own.
 */
type OperationFailure =
  | { kind: "link-unavailable" }
  | { kind: "link-conflict" }
  | { kind: "unlink-conflict" }
  | { kind: "generic"; error: ApiError };

/** A semantic outcome to show below the connections, not rendered text. */
type Notice =
  | { kind: "link-ready" }
  | { kind: "is-linked" }
  | { kind: "not-linked-yet" }
  | { kind: "operation-failed"; failure: OperationFailure };

function formatExpiration(value: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function classifyOperationError(operation: Operation, error: unknown): OperationFailure {
  const apiError = toApiError(error);
  if (operation === "start" && apiError.status === 503) {
    return { kind: "link-unavailable" };
  }
  if (operation === "start" && apiError.status === 409) {
    return { kind: "link-conflict" };
  }
  if (operation === "unlink" && apiError.status === 409) {
    return { kind: "unlink-conflict" };
  }
  return { kind: "generic", error: apiError };
}

function operationFailureMessage(failure: OperationFailure, t: Translate): string {
  switch (failure.kind) {
    case "link-unavailable":
      return t("account.linkUnavailable");
    case "link-conflict":
      return t("account.linkConflict");
    case "unlink-conflict":
      return t("account.unlinkConflict");
    case "generic":
      return apiErrorMessage(failure.error, t);
  }
}

function noticeMessage(notice: Notice, t: Translate): string {
  switch (notice.kind) {
    case "link-ready":
      return t("account.linkReady");
    case "is-linked":
      return t("account.isLinked");
    case "not-linked-yet":
      return t("account.notLinkedYet");
    case "operation-failed":
      return operationFailureMessage(notice.failure, t);
  }
}

function noticeIsError(notice: Notice): boolean {
  return notice.kind === "operation-failed";
}

interface AccountLinkingPanelProps {
  user: CurrentUser;
  disabled?: boolean;
  onOperationPendingChange?: (pending: boolean) => void;
}

export function AccountLinkingPanel({
  user,
  disabled = false,
  onOperationPendingChange,
}: AccountLinkingPanelProps) {
  const { refreshCurrentUser, finishAuthenticatedSession } = useAuth();
  const { t, locale } = useI18n();
  const [link, setLink] = useState<TelegramLinkStartResponse | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);
  const operationInFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const disconnectTrigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      controller.current = null;
      operationInFlight.current = false;
    };
  }, []);

  const begin = useCallback(
    (next: Operation): AbortController | null => {
      if (disabled || operationInFlight.current) {
        return null;
      }
      operationInFlight.current = true;
      const nextController = new AbortController();
      controller.current = nextController;
      setOperation(next);
      setNotice(null);
      onOperationPendingChange?.(true);
      return nextController;
    },
    [disabled, onOperationPendingChange],
  );

  const finish = useCallback(
    (activeController: AbortController) => {
      if (controller.current !== activeController) {
        return;
      }
      controller.current = null;
      operationInFlight.current = false;
      if (mounted.current) {
        setOperation(null);
        onOperationPendingChange?.(false);
      }
    },
    [onOperationPendingChange],
  );

  const issueLink = useCallback(() => {
    const activeController = begin("start");
    if (activeController === null) {
      return;
    }
    // A start may supersede the prior attempt server-side even if its
    // response is later lost. Stop offering the old bearer immediately.
    setLink(null);
    void (async () => {
      try {
        const issued = await startTelegramLink({ signal: activeController.signal });
        if (!activeController.signal.aborted && mounted.current) {
          setLink(issued);
          setNotice({ kind: "link-ready" });
        }
      } catch (error) {
        if (!activeController.signal.aborted && mounted.current && !isUnauthorized(error)) {
          setNotice({ kind: "operation-failed", failure: classifyOperationError("start", error) });
        }
      } finally {
        finish(activeController);
      }
    })();
  }, [begin, finish]);

  const checkStatus = useCallback(() => {
    const activeController = begin("check");
    if (activeController === null) {
      return;
    }
    void (async () => {
      try {
        const refreshed = await refreshCurrentUser({ signal: activeController.signal });
        if (!activeController.signal.aborted && mounted.current) {
          if (refreshed.telegram_linked) {
            setLink(null);
            setNotice({ kind: "is-linked" });
          } else {
            setNotice({ kind: "not-linked-yet" });
          }
        }
      } catch (error) {
        if (!activeController.signal.aborted && mounted.current && !isUnauthorized(error)) {
          setNotice({ kind: "operation-failed", failure: classifyOperationError("check", error) });
        }
      } finally {
        finish(activeController);
      }
    })();
  }, [begin, finish, refreshCurrentUser]);

  const disconnectGithub = useCallback(() => {
    const activeController = begin("unlink");
    if (activeController === null) {
      return;
    }
    void (async () => {
      try {
        await unlinkGithub({ signal: activeController.signal });
        if (!activeController.signal.aborted && mounted.current) {
          finishAuthenticatedSession();
        }
      } catch (error) {
        if (!activeController.signal.aborted && mounted.current && !isUnauthorized(error)) {
          setNotice({ kind: "operation-failed", failure: classifyOperationError("unlink", error) });
        }
      } finally {
        finish(activeController);
      }
    })();
  }, [begin, finish, finishAuthenticatedSession]);

  // Cancel removes the very button that has focus, so focus goes back to the
  // control that opened the confirmation instead of dropping to the page.
  const cancelDisconnect = () => {
    setConfirmingUnlink(false);
    disconnectTrigger.current?.focus();
  };

  const pending = operation !== null;
  const controlsDisabled = disabled || pending;

  return (
    <section className="account-panel" aria-labelledby="account-connections-heading">
      <h2 id="account-connections-heading">{t("account.title")}</h2>

      <div className="account-connection">
        <div>
          <h3>{t("account.telegram")}</h3>
          <p className="account-status">{user.telegram_linked ? t("account.linked") : t("account.notLinked")}</p>
        </div>

        {!user.telegram_linked && link === null && (
          <button type="button" className="button" onClick={issueLink} disabled={controlsDisabled}>
            {operation === "start" ? t("account.creatingLink") : t("account.linkTelegram")}
          </button>
        )}

        {!user.telegram_linked && link !== null && (
          <div className="account-link-details">
            <p>{t("account.openInTelegram")}</p>
            <p className="account-expiry muted">
              {t("account.expiresPrefix")}{" "}
              <time dateTime={link.expires_at}>{formatExpiration(link.expires_at, locale)}</time>
            </p>
            <div className="account-actions">
              {controlsDisabled ? (
                <span className="button" aria-disabled="true">
                  {t("account.openTelegram")}
                </span>
              ) : (
                <a className="button" href={link.deep_link} target="_blank" rel="noopener noreferrer">
                  {t("account.openTelegram")}
                </a>
              )}
              <button type="button" className="button button-secondary" onClick={checkStatus} disabled={controlsDisabled}>
                {operation === "check" ? t("account.checking") : t("account.checkLinkStatus")}
              </button>
              <button type="button" className="button button-secondary" onClick={issueLink} disabled={controlsDisabled}>
                {operation === "start" ? t("account.creatingLink") : t("account.issueNewLink")}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="account-connection account-connection-github">
        <div>
          <h3>{t("account.githubTitle")}</h3>
          <p className="account-status">{t("account.connected")}</p>
        </div>
        <button
          ref={disconnectTrigger}
          type="button"
          className="button button-danger"
          onClick={() => setConfirmingUnlink(true)}
          disabled={controlsDisabled}
          aria-expanded={confirmingUnlink}
          aria-controls="github-disconnect-confirmation"
        >
          {t("account.disconnectGithub")}
        </button>
        {confirmingUnlink && (
          <div
            id="github-disconnect-confirmation"
            className="account-confirmation"
            role="group"
            aria-label={t("account.confirmDisconnectionLabel")}
          >
            <p>
              {t("account.disconnectEndsAccess")}{" "}
              {user.telegram_linked ? t("account.telegramDataRemains") : t("account.emptyAccountMayBeRemoved")}
            </p>
            <div className="account-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={cancelDisconnect}
                disabled={controlsDisabled}
              >
                {t("account.cancel")}
              </button>
              <button type="button" className="button button-danger" onClick={disconnectGithub} disabled={controlsDisabled}>
                {operation === "unlink" ? t("account.disconnecting") : t("account.confirmDisconnect")}
              </button>
            </div>
          </div>
        )}
      </div>

      {operation !== null && (
        <p className="muted account-operation" role="status" aria-live="polite">
          {operation === "start" && t("account.creatingLinkStatus")}
          {operation === "check" && t("account.checkingLinkStatus")}
          {operation === "unlink" && t("account.disconnectingStatus")}
        </p>
      )}
      {notice !== null && (
        <div className={noticeIsError(notice) ? "notice notice-error" : "notice"} role={noticeIsError(notice) ? "alert" : "status"}>
          {noticeMessage(notice, t)}
        </div>
      )}
    </section>
  );
}
