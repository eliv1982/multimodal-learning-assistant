import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import { ApiError, TIMEOUT_ERROR_DETAIL, isUnauthorized, toApiError } from "../api/client";
import {
  DOCUMENTS_PAGE_SIZE,
  MAX_FILENAME_CODE_POINTS,
  MAX_UPLOAD_BYTES,
  UPLOAD_ACCEPT,
  checkUploadFile,
  deleteDocument,
  listDocuments,
  normalizeTimestamp,
  uploadDocument,
  type UploadFileProblem,
} from "../api/documents";
import type { DocumentSummary } from "../api/types";
import { apiErrorMessage } from "../i18n/apiErrors";
import type { Locale } from "../i18n/locale";
import type { Translate } from "../i18n/translate";
import { useI18n } from "../i18n/useI18n";

/**
 * Semantic classification of an upload/delete failure: never rendered text.
 * Only the "generic" case carries data (the client-owned `ApiError`, whose
 * `detail` is translated through the shared `apiErrorMessage` mapping); every
 * other case needs no data of its own, so a message is derived from the tag
 * alone at render time, in whatever locale is then current.
 */
type UploadFailureReason =
  | "timed-out"
  | "unconfirmed"
  | "too-large-for-server"
  | "not-accepted"
  | "unavailable"
  | "server-failure"
  | { kind: "generic"; error: ApiError };

type DeleteFailureReason =
  | "unconfirmed"
  | "not-found"
  | "unavailable"
  | "server-failure"
  | { kind: "generic"; error: ApiError };

/**
 * What is shown below the upload form: a semantic outcome, not rendered text.
 * `name` is the server's `display_name`, kept as data so it interpolates into
 * whichever language's template is current, never baked into a string ahead
 * of time.
 */
type Notice =
  | { kind: "uploaded"; name: string }
  | { kind: "deleted"; name: string }
  | { kind: "upload-failed"; reason: UploadFailureReason }
  | { kind: "delete-failed"; reason: DeleteFailureReason };

type Mutation = { kind: "upload" } | { kind: "delete"; id: string };

/** What the list shows. `page` and `nonce` are the only inputs of the list read; the rest is its latest result. */
interface ListView {
  page: number;
  /** Bumped to ask for another read of the same or a new page. */
  nonce: number;
  items: DocumentSummary[];
  hasNext: boolean;
  status: "loading" | "ready" | "failed";
  error: ApiError | null;
}

const MIB = 1024 * 1024;
const MAX_UPLOAD_MIB = MAX_UPLOAD_BYTES / MIB;

function fileProblemText(problem: UploadFileProblem, t: Translate): string {
  switch (problem) {
    case "extension":
      return t("documents.problemExtension");
    case "empty":
      return t("documents.problemEmpty");
    case "too-large":
      return t("documents.problemTooLarge", { max: MAX_UPLOAD_MIB });
    case "name-too-long":
      return t("documents.problemNameTooLong", { max: MAX_FILENAME_CODE_POINTS });
  }
}

const HAS_UTC_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/;
const OFFSET_LESS_WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/**
 * Formats an offset-less wall-clock reading in the given locale, without ever
 * letting the machine's time zone shift the digits.
 *
 * The year/month/day/hour/minute are parsed out of the string deterministically
 * (never through `Date` parsing, which is locale- and implementation-defined)
 * and handed to `Date.UTC`, which only does calendar arithmetic on the values
 * given it — UTC has no DST, so no wall-clock reading is ever skipped or
 * repeated. `Intl.DateTimeFormat` is then pinned to `timeZone: "UTC"` too, so
 * it reads back exactly the components that went in, regardless of the
 * browser's real zone, and renders them with the selected locale's date/time
 * conventions.
 */
function formatOffsetLessWallClock(value: string, locale: Locale): string {
  const match = OFFSET_LESS_WALL_CLOCK.exec(value);
  if (match === null) {
    // Defensive only: every caller already validated the shape (see documents.ts).
    return value.slice(0, "YYYY-MM-DDTHH:MM".length).replace("T", " ");
  }
  const wallClockMillis = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(
    wallClockMillis,
  );
}

/**
 * How a document's `created_at` is shown.
 *
 * The backend column is a timestamp WITHOUT time zone, so a real value has no
 * offset and names no instant: parsing it with `Date` would give it the
 * browser's zone, and a wall-clock time that zone skips (a DST gap, such as
 * 2026-03-08T02:30:00 in America/New_York) would be shifted to a different
 * hour. Such a value is therefore shown as its own wall-clock digits,
 * formatted for the selected interface locale but never shifted by the
 * browser's zone (see `formatOffsetLessWallClock`). A value with "Z" or a
 * numeric offset does name an instant, and is shown in the given interface
 * locale and the browser's zone.
 *
 * `value` must already be a validated server timestamp (see `documents.ts`).
 */
export function formatDocumentCreatedAt(value: string, locale: Locale): string {
  if (HAS_UTC_OFFSET.test(value)) {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(normalizeTimestamp(value)),
    );
  }
  return formatOffsetLessWallClock(value, locale);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return bytes < MIB ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / MIB).toFixed(2)} MiB`;
}

/**
 * No answer at all (a timeout or a lost connection) or a 2xx that was not the
 * expected confirmation: the request may or may not have taken effect.
 */
function isUnconfirmed(status: number): boolean {
  return status === 0 || (status >= 200 && status < 300);
}

/**
 * Classifies an upload failure into a semantic reason, never rendered text:
 * nothing from the response body ever reaches this or anything derived from it.
 */
function classifyUploadFailure(error: unknown): UploadFailureReason {
  const apiError = toApiError(error);
  const { status, detail } = apiError;
  if (status === 0) {
    return detail === TIMEOUT_ERROR_DETAIL ? "timed-out" : "unconfirmed";
  }
  if (isUnconfirmed(status)) {
    return "unconfirmed";
  }
  if (status === 413) {
    return "too-large-for-server";
  }
  if (status === 422) {
    return "not-accepted";
  }
  if (status === 503) {
    return "unavailable";
  }
  if (status === 500) {
    return "server-failure";
  }
  return { kind: "generic", error: apiError };
}

function uploadFailureMessage(reason: UploadFailureReason, t: Translate): string {
  if (typeof reason === "object") {
    return t("documents.uploadGeneric", { detail: apiErrorMessage(reason.error, t) });
  }
  switch (reason) {
    case "timed-out":
      return t("documents.uploadTimedOut");
    case "unconfirmed":
      return t("documents.uploadUnconfirmed");
    case "too-large-for-server":
      return t("documents.tooLargeForServer", { max: MAX_UPLOAD_MIB });
    case "not-accepted":
      return t("documents.notAccepted");
    case "unavailable":
      return t("documents.unavailable");
    case "server-failure":
      return t("documents.uploadServerFailure");
  }
}

function classifyDeleteFailure(error: unknown): DeleteFailureReason {
  const apiError = toApiError(error);
  const { status } = apiError;
  if (isUnconfirmed(status)) {
    return "unconfirmed";
  }
  if (status === 404) {
    return "not-found";
  }
  if (status === 503) {
    return "unavailable";
  }
  if (status === 500) {
    return "server-failure";
  }
  return { kind: "generic", error: apiError };
}

function deleteFailureMessage(reason: DeleteFailureReason, t: Translate): string {
  if (typeof reason === "object") {
    return t("documents.deleteGeneric", { detail: apiErrorMessage(reason.error, t) });
  }
  switch (reason) {
    case "unconfirmed":
      return t("documents.deleteUnconfirmed");
    case "not-found":
      return t("documents.deleteNotFound");
    case "unavailable":
      return t("documents.unavailable");
    case "server-failure":
      return t("documents.deleteServerFailure");
  }
}

function noticeMessage(notice: Notice, t: Translate): string {
  switch (notice.kind) {
    case "uploaded":
      return t("documents.uploaded", { name: notice.name });
    case "deleted":
      return t("documents.deleted", { name: notice.name });
    case "upload-failed":
      return uploadFailureMessage(notice.reason, t);
    case "delete-failed":
      return deleteFailureMessage(notice.reason, t);
  }
}

function noticeIsError(notice: Notice): boolean {
  return notice.kind === "upload-failed" || notice.kind === "delete-failed";
}

interface DocumentsPanelProps {
  /** Drives an informational hint only: an unlinked account is never blocked from uploading. */
  telegramLinked: boolean;
  /** True while a sign-out is pending: nothing here may start a request then. */
  disabled?: boolean;
}

/**
 * The signed-in user's private documents. Everything here is local to this
 * panel; it neither reads nor changes the authentication state.
 *
 * - Identity is the session cookie. The list is only what the server returns
 *   for it; a delete names a document only by its canonical id, and only a 204
 *   removes a row (nothing is deleted optimistically).
 * - Reads are 20 rows per page (21 are requested to learn whether a next page
 *   exists), never polled, and never retried on their own; Refresh is explicit.
 * - Stale reads cannot win. Every read takes a fresh `listRequestId` and the
 *   current `catalogEpoch`; the epoch advances on each confirmed upload or
 *   delete, and that same moment aborts any read in flight. A response is used
 *   only if its request is still the latest, its epoch is still current, and
 *   its signal is not aborted. So an old read can neither erase a new upload,
 *   bring back a deleted document, nor overwrite a newer Refresh.
 * - One upload or delete at a time, guarded by a ref so two events in the same
 *   tick cannot both start one. Unmounting (sign-out, a 401 elsewhere) aborts
 *   every request, and an aborted request never updates state.
 * - Errors show client-owned text only. A 401 shows nothing here: the central
 *   handler already ends the authenticated UI. A timeout leaves an upload's
 *   outcome unknown, so it is never retried and the user is sent to Refresh.
 * - The chosen `File` lives only in this component's state: no browser storage.
 */
export function DocumentsPanel({ telegramLinked, disabled = false }: DocumentsPanelProps) {
  const { t, locale } = useI18n();
  const [view, setView] = useState<ListView>({
    page: 0,
    nonce: 0,
    items: [],
    hasNext: false,
    status: "loading",
    error: null,
  });
  const [file, setFile] = useState<File | null>(null);
  const [mutation, setMutation] = useState<Mutation | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; reason: DeleteFailureReason } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const listRequestId = useRef(0);
  const catalogEpoch = useRef(0);
  const listController = useRef<AbortController | null>(null);
  // `mutation` only changes on the next render, so two events in the same tick
  // would both see it null. The ref is the synchronous guard.
  const mutationInFlight = useRef(false);
  const mutationController = useRef<AbortController | null>(null);
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>());

  const titleId = useId();
  const fileInputId = useId();
  const hintId = useId();

  // One list read per (page, nonce). Leaving the panel, or asking for another
  // read, aborts this one; StrictMode's extra run therefore leaves one live read.
  useEffect(() => {
    const request = new AbortController();
    listController.current = request;
    listRequestId.current += 1;
    const requestId = listRequestId.current;
    const epoch = catalogEpoch.current;
    const isCurrent = () =>
      !request.signal.aborted && listRequestId.current === requestId && catalogEpoch.current === epoch;

    void (async () => {
      try {
        const result = await listDocuments(view.page * DOCUMENTS_PAGE_SIZE, { signal: request.signal });
        if (!isCurrent()) {
          return;
        }
        if (result.items.length === 0 && view.page > 0) {
          // The page emptied (documents were removed elsewhere): step back one page.
          setView((prev) => ({ page: prev.page - 1, nonce: prev.nonce + 1, items: [], hasNext: false, status: "loading", error: null }));
          return;
        }
        setView((prev) => ({ ...prev, items: result.items, hasNext: result.hasNext, status: "ready", error: null }));
      } catch (error) {
        if (isCurrent() && !isUnauthorized(error)) {
          setView((prev) => ({ ...prev, status: "failed", error: toApiError(error) }));
        }
      }
    })();

    return () => {
      request.abort();
      if (listController.current === request) {
        listController.current = null;
      }
    };
  }, [view.page, view.nonce]);

  useEffect(
    () => () => {
      mutationController.current?.abort();
      listController.current?.abort();
    },
    [],
  );

  /** From now on no read that is already in flight may be applied. */
  const invalidateListReads = () => {
    listController.current?.abort();
    listRequestId.current += 1;
  };

  /** Asks for a fresh read; `page` null keeps the current page and its rows on screen until the answer arrives. */
  const reload = (page: number | null) => {
    invalidateListReads();
    setConfirmingId(null);
    setRowError(null);
    setView((prev) => ({
      page: page ?? prev.page,
      nonce: prev.nonce + 1,
      items: page === null ? prev.items : [],
      hasNext: page === null ? prev.hasNext : false,
      status: "loading",
      error: null,
    }));
  };

  const beginMutation = (next: Mutation): AbortController | null => {
    if (disabled || mutationInFlight.current) {
      return null;
    }
    mutationInFlight.current = true;
    const request = new AbortController();
    mutationController.current = request;
    setMutation(next);
    setNotice(null);
    setRowError(null);
    return request;
  };

  const endMutation = (request: AbortController) => {
    if (mutationController.current !== request) {
      return;
    }
    mutationController.current = null;
    mutationInFlight.current = false;
    if (!request.signal.aborted) {
      setMutation(null);
    }
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0] ?? null;
    // The File is kept in state; the native value is cleared so choosing the
    // same file again still counts as a change.
    event.target.value = "";
    if (chosen !== null && !mutationInFlight.current) {
      setFile(chosen);
      setNotice(null);
    }
  };

  const problem = file === null ? null : checkUploadFile(file);

  const upload = () => {
    if (disabled || file === null || problem !== null) {
      return;
    }
    const request = beginMutation({ kind: "upload" });
    if (request === null) {
      return;
    }
    const chosen = file;
    void (async () => {
      try {
        const created = await uploadDocument(chosen, { signal: request.signal });
        if (!request.signal.aborted) {
          catalogEpoch.current += 1;
          invalidateListReads();
          setFile(null);
          setConfirmingId(null);
          setNotice({ kind: "uploaded", name: created.display_name });
          setView((prev) => {
            // Newest first: on the first page the new document leads it; from
            // any other page the list returns to the first page and is read again.
            if (prev.page !== 0) {
              return { page: 0, nonce: prev.nonce + 1, items: [], hasNext: false, status: "loading", error: null };
            }
            const rows = [created, ...prev.items.filter((item) => item.id !== created.id)];
            return {
              ...prev,
              nonce: prev.nonce + 1,
              items: rows.slice(0, DOCUMENTS_PAGE_SIZE),
              hasNext: prev.hasNext || rows.length > DOCUMENTS_PAGE_SIZE,
              status: "loading",
              error: null,
            };
          });
        }
      } catch (error) {
        if (!request.signal.aborted && !isUnauthorized(error)) {
          setNotice({ kind: "upload-failed", reason: classifyUploadFailure(error) });
        }
      } finally {
        endMutation(request);
      }
    })();
  };

  const confirmDelete = (item: DocumentSummary) => {
    const request = beginMutation({ kind: "delete", id: item.id });
    if (request === null) {
      return;
    }
    void (async () => {
      try {
        await deleteDocument(item.id, { signal: request.signal });
        if (!request.signal.aborted) {
          catalogEpoch.current += 1;
          invalidateListReads();
          setConfirmingId(null);
          setNotice({ kind: "deleted", name: item.display_name });
          setView((prev) => ({
            ...prev,
            nonce: prev.nonce + 1,
            items: prev.items.filter((row) => row.id !== item.id),
            status: "loading",
            error: null,
          }));
        }
      } catch (error) {
        if (!request.signal.aborted && !isUnauthorized(error)) {
          setRowError({ id: item.id, reason: classifyDeleteFailure(error) });
        }
      } finally {
        endMutation(request);
      }
    })();
  };

  const cancelDelete = (id: string) => {
    setConfirmingId(null);
    setRowError(null);
    deleteButtons.current.get(id)?.focus();
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    upload();
  };

  const uploading = mutation?.kind === "upload";
  const busy = disabled || mutation !== null;
  const loading = view.status === "loading";

  return (
    <section className="documents-panel" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("documents.title")}</h2>
      <p className="muted documents-note">{t("documents.note")}</p>
      {!telegramLinked && (
        <p className="notice documents-warning" role="note">
          {t("documents.linkWarning")}
        </p>
      )}

      <form className="documents-upload" onSubmit={onSubmit} aria-busy={uploading}>
        <label className="documents-label" htmlFor={fileInputId}>
          {t("documents.chooseFile")}
        </label>
        <input
          id={fileInputId}
          className="documents-file-input"
          type="file"
          accept={UPLOAD_ACCEPT}
          onChange={onFileChange}
          disabled={busy}
          aria-describedby={hintId}
        />
        <p className="muted documents-hint" id={hintId}>
          {t("documents.hint", { max: MAX_UPLOAD_MIB })}
        </p>
        {file !== null && (
          <p className="documents-selected">
            <span className="documents-name">{file.name}</span> <span className="muted">({formatSize(file.size)})</span>
          </p>
        )}
        {problem !== null && (
          <p className="documents-problem" role="alert">
            {fileProblemText(problem, t)}
          </p>
        )}
        <div className="documents-actions">
          <button type="submit" className="button" disabled={busy || file === null || problem !== null}>
            {uploading ? t("documents.uploading") : t("documents.upload")}
          </button>
        </div>
      </form>

      {uploading && (
        <p className="muted documents-status" role="status">
          {t("documents.uploadingStatus")}
        </p>
      )}
      {notice !== null && (
        <div
          className={noticeIsError(notice) ? "notice notice-error" : "notice"}
          role={noticeIsError(notice) ? "alert" : "status"}
        >
          {noticeMessage(notice, t)}
        </div>
      )}

      <div className="documents-toolbar">
        <h3>{t("documents.yourDocuments")}</h3>
        <button type="button" className="button button-secondary" onClick={() => reload(null)} disabled={busy}>
          {t("documents.refresh")}
        </button>
      </div>

      {loading && (
        <p className="muted documents-status" role="status">
          {t("documents.loading")}
        </p>
      )}
      {view.status === "failed" && (
        <div className="notice notice-error" role="alert">
          <p>{t("documents.loadFailed", { detail: view.error === null ? "" : apiErrorMessage(view.error, t) })}</p>
          <button type="button" className="button button-secondary" onClick={() => reload(null)} disabled={busy}>
            {t("documents.retry")}
          </button>
        </div>
      )}
      {view.status === "ready" && view.items.length === 0 && (
        <p className="muted documents-empty">{t("documents.empty")}</p>
      )}

      {view.items.length > 0 && (
        <ul className="documents-list" aria-label={t("documents.yourDocuments")} aria-busy={loading}>
          {view.items.map((item, index) => {
            const nameId = `${titleId}-name-${index}`;
            const deleting = mutation?.kind === "delete" && mutation.id === item.id;
            const confirming = confirmingId === item.id;
            const normalized = normalizeTimestamp(item.created_at);
            return (
              <li className="documents-item" key={item.id} aria-busy={deleting}>
                <div className="documents-item-main">
                  <span className="documents-name" id={nameId}>
                    {item.display_name}
                  </span>
                  <span className="muted documents-time">
                    {t("documents.uploadedPrefix")}{" "}
                    <time dateTime={normalized}>{formatDocumentCreatedAt(item.created_at, locale)}</time>
                  </span>
                </div>
                <button
                  type="button"
                  className="button button-danger"
                  onClick={() => {
                    setRowError(null);
                    setConfirmingId(item.id);
                  }}
                  disabled={busy}
                  aria-describedby={nameId}
                  aria-expanded={confirming}
                  ref={(node) => {
                    if (node === null) {
                      deleteButtons.current.delete(item.id);
                    } else {
                      deleteButtons.current.set(item.id, node);
                    }
                  }}
                >
                  {t("documents.delete")}
                </button>
                {confirming && (
                  <div className="documents-confirmation" role="group" aria-label={t("documents.confirmDeletionLabel")}>
                    <p>{t("documents.confirmDeleteQuestion")}</p>
                    <div className="documents-actions">
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => cancelDelete(item.id)}
                        disabled={busy}
                      >
                        {t("documents.cancel")}
                      </button>
                      <button
                        type="button"
                        className="button button-danger"
                        onClick={() => confirmDelete(item)}
                        disabled={busy}
                        aria-describedby={nameId}
                      >
                        {deleting ? t("documents.deleting") : t("documents.confirmDelete")}
                      </button>
                    </div>
                    {deleting && (
                      <p className="muted documents-status" role="status">
                        {t("documents.deletingStatus")}
                      </p>
                    )}
                    {rowError?.id === item.id && (
                      <p className="documents-problem" role="alert">
                        {deleteFailureMessage(rowError.reason, t)}
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <nav className="documents-pager" aria-label={t("documents.pagerLabel")}>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => reload(view.page - 1)}
          disabled={busy || loading || view.page === 0}
        >
          {t("documents.previous")}
        </button>
        <span className="muted">{t("documents.page", { n: view.page + 1 })}</span>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => reload(view.page + 1)}
          disabled={busy || loading || !view.hasNext}
        >
          {t("documents.next")}
        </button>
      </nav>
    </section>
  );
}
