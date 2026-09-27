import { describe, expect, it } from "vitest";

import { CHAT_REQUEST_REFUSED_DETAIL } from "../api/chat";
import * as client from "../api/client";
import { ApiError } from "../api/client";
import { apiErrorMessage } from "./apiErrors";
import { translatorFor } from "./translate";

/** Every fixed, client-owned failure message that an ApiError can carry. */
const DETAILS = [
  ...Object.entries(client).filter(([name, value]) => name.endsWith("_DETAIL") && typeof value === "string"),
  ["CHAT_REQUEST_REFUSED_DETAIL", CHAT_REQUEST_REFUSED_DETAIL],
] as [string, string][];

describe("apiErrorMessage", () => {
  it("finds the fixed messages to translate", () => {
    expect(DETAILS.map(([name]) => name).sort()).toEqual([
      "CHAT_REQUEST_REFUSED_DETAIL",
      "FORBIDDEN_ERROR_DETAIL",
      "GENERIC_ERROR_DETAIL",
      "NETWORK_ERROR_DETAIL",
      "RATE_LIMITED_ERROR_DETAIL",
      "SERVER_ERROR_DETAIL",
      "TIMEOUT_ERROR_DETAIL",
      "UNAUTHORIZED_ERROR_DETAIL",
      "UNEXPECTED_RESPONSE_DETAIL",
    ]);
  });

  it.each(DETAILS)("shows %s in English exactly as the client words it", (_name, detail) => {
    expect(apiErrorMessage(new ApiError(0, detail), translatorFor("en"))).toBe(detail);
  });

  it.each(DETAILS)("translates %s into Russian", (_name, detail) => {
    const russian = apiErrorMessage(new ApiError(0, detail), translatorFor("ru"));

    expect(russian).not.toBe(detail);
    expect(russian).toMatch(/[А-Яа-яЁё]/);
  });

  it("gives every fixed message its own translation", () => {
    const translated = DETAILS.map(([, detail]) => apiErrorMessage(new ApiError(0, detail), translatorFor("ru")));

    expect(new Set(translated).size).toBe(DETAILS.length);
  });

  it("never shows a message it does not own: anything else is the generic failure", () => {
    for (const text of ["backend prose", "<b>markup</b>", "OPENAI_API_KEY=secret", ""]) {
      expect(apiErrorMessage(new ApiError(500, text), translatorFor("en"))).toBe(client.GENERIC_ERROR_DETAIL);
      expect(apiErrorMessage(new ApiError(500, text), translatorFor("ru"))).toBe(
        apiErrorMessage(new ApiError(0, client.GENERIC_ERROR_DETAIL), translatorFor("ru")),
      );
    }
  });

  it("goes by the message, not the status", () => {
    expect(apiErrorMessage(new ApiError(200, client.UNEXPECTED_RESPONSE_DETAIL), translatorFor("ru"))).toBe(
      "Сервер прислал неожиданный ответ.",
    );
    expect(apiErrorMessage(new ApiError(0, client.TIMEOUT_ERROR_DETAIL), translatorFor("ru"))).toBe(
      "Сервер слишком долго не отвечает. Повторите попытку.",
    );
  });
});
