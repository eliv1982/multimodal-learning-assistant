import type { ApiError } from "../api/client";
import { apiErrorMessage } from "../i18n/apiErrors";
import { useI18n } from "../i18n/useI18n";
import { ScreenLayout } from "./ScreenLayout";

/**
 * Shown when the session could not be checked (network/server problem).
 * Deliberately not the sign-in screen: nothing says the user is signed out.
 */
export function VerificationErrorScreen({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const { t } = useI18n();

  return (
    <ScreenLayout>
      <div className="card card-error" role="alert">
        <h1>{t("verification.title")}</h1>
        <p>{t("verification.body")}</p>
        <p className="muted">{apiErrorMessage(error, t)}</p>
        <button type="button" className="button" onClick={onRetry}>
          {t("verification.retry")}
        </button>
      </div>
    </ScreenLayout>
  );
}
