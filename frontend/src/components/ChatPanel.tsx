import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { ApiError, toApiError } from "../api/client";
import {
  CHAT_MAX_MESSAGE_CODE_POINTS,
  CHAT_REQUEST_REFUSED_DETAIL,
  buildChatRequest,
  codePointLength,
  sendChatMessage,
  type ChatExchange,
} from "../api/chat";
import { apiErrorMessage } from "../i18n/apiErrors";
import { useI18n } from "../i18n/useI18n";

interface TranscriptEntry extends ChatExchange {
  id: number;
}

interface ChatPanelProps {
  disabled?: boolean;
}

/**
 * Text chat. Everything here is React state in this component and nowhere else:
 * there is no history endpoint and nothing is stored in the browser, so the
 * conversation ends when the component unmounts (refresh, sign-out, a 401).
 *
 * - `exchanges` is the visible transcript: completed exchanges only, in order.
 *   The request history is derived from it at send time (`buildChatRequest`).
 * - `pending` is the message currently being answered. It joins `exchanges`
 *   only together with its reply; on failure it is dropped and the text stays
 *   in `draft` for another try.
 * - Every piece of text is rendered as a plain React text node. Errors show
 *   only the client-owned `ApiError.detail` (translated), never anything the
 *   server said. The error itself is kept, not its text, so it follows a
 *   language switch.
 * - `disabled` (a sign-out is pending) makes the composer inert but keeps the
 *   draft: a failed sign-out leaves the session valid, and the user then finds
 *   the chat exactly as they left it. A reply that is already awaited is
 *   deliberately not aborted; a confirmed session end unmounts the panel, and
 *   the cleanup below handles that.
 */
export function ChatPanel({ disabled = false }: ChatPanelProps) {
  const [exchanges, setExchanges] = useState<TranscriptEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const { t } = useI18n();

  // `pending` only changes on the next render, so two submits in the same tick
  // would both see it null. The ref is the synchronous guard.
  const inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const nextId = useRef(0);
  const transcript = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const inputId = useId();
  const hintId = useId();

  // Leaving the page (or signing out) stops the browser waiting for a reply. It
  // cannot promise the server stops generating, and the UI does not say it does.
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  useEffect(() => {
    const element = transcript.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [exchanges, pending]);

  const draftLength = useMemo(() => codePointLength(draft), [draft]);
  const overLimit = draftLength > CHAT_MAX_MESSAGE_CODE_POINTS;
  const isPending = pending !== null;
  const canSend = !disabled && !isPending && !overLimit && draft.trim() !== "";

  const submit = () => {
    if (disabled || inFlight.current) {
      return;
    }
    const built = buildChatRequest(draft, exchanges);
    if (!built.ok) {
      // A blank draft is simply not sent; anything else is the size contract.
      if (built.problem !== "empty-message") {
        setError(new ApiError(0, CHAT_REQUEST_REFUSED_DETAIL));
      }
      return;
    }

    inFlight.current = true;
    const request = new AbortController();
    controller.current = request;
    const message = draft;
    setPending(message);
    setError(null);
    // Sending with the button would otherwise strand focus on a button that is
    // about to be disabled. The composer stays focusable while it is read-only.
    input.current?.focus();

    void (async () => {
      try {
        const reply = await sendChatMessage(built.request, { signal: request.signal });
        if (request.signal.aborted) {
          return;
        }
        const id = nextId.current;
        nextId.current += 1;
        setExchanges((previous) => [...previous, { id, user: message, assistant: reply.text }]);
        setDraft("");
        setPending(null);
      } catch (failure) {
        if (request.signal.aborted) {
          return;
        }
        setPending(null);
        setError(toApiError(failure));
      } finally {
        inFlight.current = false;
        if (controller.current === request) {
          controller.current = null;
        }
      }
    })();
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Plain Enter sends. Shift+Enter (and any other modifier) keeps its normal
    // behaviour, and so does the Enter that commits an IME composition: some
    // browsers report it with isComposing false but keyCode 229.
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    ) {
      return;
    }
    event.preventDefault();
    if (!event.repeat) {
      submit();
    }
  };

  return (
    <section className="chat" aria-labelledby={`${inputId}-title`}>
      <h2 id={`${inputId}-title`}>{t("chat.title")}</h2>
      <p className="muted chat-note">{t("chat.note")}</p>

      <div
        className="chat-transcript"
        ref={transcript}
        role="log"
        aria-label={t("chat.transcriptLabel")}
        aria-busy={isPending}
        tabIndex={0}
      >
        {exchanges.length === 0 && !isPending && <p className="muted chat-empty">{t("chat.empty")}</p>}
        <ol className="chat-messages">
          {exchanges.map((exchange) => (
            <li key={exchange.id} className="chat-exchange">
              <div className="chat-message chat-message-user">
                <span className="chat-author">{t("chat.you")}</span>
                <div className="chat-text">{exchange.user}</div>
              </div>
              <div className="chat-message chat-message-assistant">
                <span className="chat-author">{t("chat.assistant")}</span>
                <div className="chat-text">{exchange.assistant}</div>
              </div>
            </li>
          ))}
          {pending !== null && (
            <li className="chat-exchange">
              <div className="chat-message chat-message-user chat-message-pending">
                <span className="chat-author">{t("chat.you")}</span>
                <div className="chat-text">{pending}</div>
              </div>
            </li>
          )}
        </ol>
      </div>

      {/* Pinned to the bottom of the viewport, so the status and any error stay
          next to the box they are about instead of scrolling out of sight. The
          composer is its own raised card: the transcript above is for reading,
          this is where the user writes and acts. */}
      <div className="chat-compose">
        {isPending && (
          <p className="muted chat-status" role="status">
            {t("chat.waiting")}
          </p>
        )}

        {error !== null && (
          <div className="notice notice-error" role="alert">
            <p>{t("chat.notAdded")}</p>
            <p className="muted">{apiErrorMessage(error, t)}</p>
          </div>
        )}

        <form className="chat-composer" onSubmit={onSubmit} noValidate>
          <label className="visually-hidden" htmlFor={inputId}>
            {t("chat.messageLabel")}
          </label>
          <textarea
            id={inputId}
            ref={input}
            className="chat-input"
            name="message"
            rows={3}
            value={draft}
            readOnly={isPending}
            disabled={disabled}
            aria-invalid={overLimit}
            aria-describedby={hintId}
            autoComplete="off"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="chat-composer-row">
            <span id={hintId} className={overLimit ? "chat-hint chat-hint-over" : "chat-hint"}>
              {overLimit
                ? t("chat.tooLong", { length: draftLength, max: CHAT_MAX_MESSAGE_CODE_POINTS })
                : t("chat.hint", { length: draftLength, max: CHAT_MAX_MESSAGE_CODE_POINTS })}
            </span>
            <button type="submit" className="button" disabled={!canSend}>
              {isPending ? t("chat.sending") : t("chat.send")}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
