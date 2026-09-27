import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import { ApiError, isUnauthorized, toApiError } from "../api/client";
import { getSettings, saveSettings } from "../api/settings";
import { TUTOR_MODES, isTutorMode, type TutorMode } from "../api/types";
import { apiErrorMessage } from "../i18n/apiErrors";
import type { PlainMessageKey } from "../i18n/translate";
import { useI18n } from "../i18n/useI18n";

const MODE_LABEL_KEYS: Record<TutorMode, PlainMessageKey> = {
  text: "settings.modeText",
  voice: "settings.modeVoice",
  vision: "settings.modeVision",
  rag: "settings.modeRag",
};

type Load = { status: "loading" } | { status: "ready" } | { status: "failed"; error: ApiError };
/** A semantic outcome, not rendered text: translated at render time from the current `t`. */
type Notice = { kind: "saved" } | { kind: "save-failed"; error: ApiError };

interface SettingsPanelProps {
  /** True while a sign-out is pending: nothing here may start a request then. */
  disabled?: boolean;
}

/**
 * The saved-mode preference. It is shared with Telegram; the web chat is fixed
 * to text on the server and never reads it, so nothing here touches the chat.
 *
 * - The mode is unknown until `GET /api/settings` answers (the server default
 *   may be any mode), so nothing is assumed while loading and the controls
 *   stay disabled.
 * - The select only edits a local draft. Save always sends a request, even for
 *   the value that was just loaded: an effective default is not yet an explicit
 *   choice, so an unchanged form is not a no-op. The server's answer replaces
 *   the draft.
 * - The select is disabled while a save is pending, so the draft that was sent
 *   and the value that comes back cannot disagree with a newer edit.
 * - Errors show only client-owned text. A 401 shows nothing here: the central
 *   handler already ends the authenticated UI. No auth state is kept in this
 *   component, and nothing is persisted or retried on its own.
 */
export function SettingsPanel({ disabled = false }: SettingsPanelProps) {
  const { t } = useI18n();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<TutorMode | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  // `saving` only changes on the next render, so two submits in the same tick
  // would both see it false. The ref is the synchronous guard.
  const saveInFlight = useRef(false);
  const saveController = useRef<AbortController | null>(null);

  const selectId = useId();
  const noteId = useId();

  // One read per attempt; leaving (unmount, sign-out, a 401) or retrying
  // aborts the previous one, and an aborted request never updates state.
  useEffect(() => {
    const request = new AbortController();
    void (async () => {
      try {
        const settings = await getSettings({ signal: request.signal });
        if (!request.signal.aborted) {
          setSelected(settings.mode);
          setLoad({ status: "ready" });
        }
      } catch (error) {
        if (!request.signal.aborted && !isUnauthorized(error)) {
          setLoad({ status: "failed", error: toApiError(error) });
        }
      }
    })();
    return () => request.abort();
  }, [attempt]);

  useEffect(
    () => () => {
      saveController.current?.abort();
    },
    [],
  );

  const retryLoad = () => {
    if (disabled || load.status !== "failed") {
      return;
    }
    setLoad({ status: "loading" });
    setAttempt((current) => current + 1);
  };

  const onChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value;
    if (isTutorMode(next)) {
      setSelected(next);
      setNotice(null);
    }
  };

  const save = () => {
    if (disabled || saveInFlight.current || load.status !== "ready" || selected === null) {
      return;
    }
    saveInFlight.current = true;
    const request = new AbortController();
    saveController.current = request;
    const mode = selected;
    setSaving(true);
    setNotice(null);

    void (async () => {
      try {
        const saved = await saveSettings(mode, { signal: request.signal });
        if (!request.signal.aborted) {
          setSelected(saved.mode);
          setNotice({ kind: "saved" });
        }
      } catch (error) {
        if (!request.signal.aborted && !isUnauthorized(error)) {
          setNotice({ kind: "save-failed", error: toApiError(error) });
        }
      } finally {
        saveInFlight.current = false;
        if (saveController.current === request) {
          saveController.current = null;
        }
        if (!request.signal.aborted) {
          setSaving(false);
        }
      }
    })();
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save();
  };

  const ready = load.status === "ready";
  const controlsDisabled = disabled || saving || !ready;

  return (
    <section className="settings-panel" aria-labelledby={`${selectId}-title`}>
      <h2 id={`${selectId}-title`}>{t("settings.title")}</h2>
      <p className="muted settings-note" id={noteId}>
        {t("settings.note")}
      </p>

      <form onSubmit={onSubmit} aria-busy={saving || load.status === "loading"}>
        <div className="settings-field">
          <label className="settings-label" htmlFor={selectId}>
            {t("settings.preferredMode")}
          </label>
          <select
            id={selectId}
            className="settings-select"
            name="mode"
            value={selected ?? ""}
            onChange={onChange}
            disabled={controlsDisabled}
            aria-describedby={noteId}
          >
            {selected === null ? (
              <option value="">{load.status === "loading" ? t("settings.loadingOption") : t("settings.unavailable")}</option>
            ) : (
              TUTOR_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(MODE_LABEL_KEYS[mode])}
                </option>
              ))
            )}
          </select>
        </div>

        <div className="settings-actions">
          <button type="submit" className="button" disabled={controlsDisabled}>
            {saving ? t("settings.saving") : t("settings.save")}
          </button>
          {load.status === "failed" && (
            <button type="button" className="button button-secondary" onClick={retryLoad} disabled={disabled}>
              {t("settings.retry")}
            </button>
          )}
        </div>
      </form>

      {load.status === "loading" && (
        <p className="muted settings-status" role="status">
          {t("settings.loadingStatus")}
        </p>
      )}
      {saving && (
        <p className="muted settings-status" role="status">
          {t("settings.savingStatus")}
        </p>
      )}
      {load.status === "failed" && (
        <div className="notice notice-error" role="alert">
          {t("settings.loadFailed", { detail: apiErrorMessage(load.error, t) })}
        </div>
      )}
      {notice !== null && (
        <div
          className={notice.kind === "save-failed" ? "notice notice-error" : "notice"}
          role={notice.kind === "save-failed" ? "alert" : "status"}
        >
          {notice.kind === "saved" ? t("settings.saved") : t("settings.saveFailed", { detail: apiErrorMessage(notice.error, t) })}
        </div>
      )}
    </section>
  );
}
