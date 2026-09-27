import { PRODUCT_NAME } from "../branding";
import { useI18n } from "../i18n/useI18n";
import { ScreenLayout } from "./ScreenLayout";

/** Full browser navigation (a plain link), never fetch: the backend owns the OAuth state, PKCE and redirect. */
export const GITHUB_LOGIN_PATH = "/api/auth/github/login";

export function SignInScreen() {
  const { t } = useI18n();

  return (
    <ScreenLayout>
      <div className="card">
        <h1>{PRODUCT_NAME}</h1>
        <p>{t("signIn.prompt")}</p>
        <a className="button" href={GITHUB_LOGIN_PATH}>
          {t("signIn.github")}
        </a>
      </div>
    </ScreenLayout>
  );
}
