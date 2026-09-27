import { CHAT_REQUEST_REFUSED_DETAIL } from "../api/chat";
import {
  FORBIDDEN_ERROR_DETAIL,
  GENERIC_ERROR_DETAIL,
  NETWORK_ERROR_DETAIL,
  RATE_LIMITED_ERROR_DETAIL,
  SERVER_ERROR_DETAIL,
  TIMEOUT_ERROR_DETAIL,
  UNAUTHORIZED_ERROR_DETAIL,
  UNEXPECTED_RESPONSE_DETAIL,
  type ApiError,
} from "../api/client";
import type { PlainMessageKey, Translate } from "./translate";

/**
 * `ApiError.detail` is one of a closed set of fixed English messages owned by
 * the client (never text from a response). This maps each to its translation,
 * so an error is shown in the interface language, and follows a language switch.
 */
const DETAIL_KEYS: ReadonlyMap<string, PlainMessageKey> = new Map<string, PlainMessageKey>([
  [NETWORK_ERROR_DETAIL, "error.network"],
  [TIMEOUT_ERROR_DETAIL, "error.timeout"],
  [UNEXPECTED_RESPONSE_DETAIL, "error.unexpectedResponse"],
  [GENERIC_ERROR_DETAIL, "error.generic"],
  [UNAUTHORIZED_ERROR_DETAIL, "error.unauthorized"],
  [FORBIDDEN_ERROR_DETAIL, "error.forbidden"],
  [RATE_LIMITED_ERROR_DETAIL, "error.rateLimited"],
  [SERVER_ERROR_DETAIL, "error.server"],
  [CHAT_REQUEST_REFUSED_DETAIL, "error.chatRequestRefused"],
]);

/** The translated message for an API failure; anything unrecognized is the generic failure message. */
export function apiErrorMessage(error: ApiError, t: Translate): string {
  return t(DETAIL_KEYS.get(error.detail) ?? "error.generic");
}
