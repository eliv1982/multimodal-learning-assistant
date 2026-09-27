import { useAuth } from "./auth/useAuth";
import { AuthenticatedShell } from "./components/AuthenticatedShell";
import { LoadingScreen } from "./components/LoadingScreen";
import { SignInScreen } from "./components/SignInScreen";
import { VerificationErrorScreen } from "./components/VerificationErrorScreen";
import { PRODUCT_NAME } from "./branding";
import { useDocumentTitle } from "./i18n/useDocumentTitle";
import { useI18n } from "./i18n/useI18n";

export function App() {
  const { state, logoutState, retryVerification, logout } = useAuth();
  const { t } = useI18n();

  // Every screen is titled in the interface language; the two the user did not
  // ask for by signing in (sign-in, a failed session check) say which one it is.
  useDocumentTitle(
    state.status === "anonymous"
      ? t("title.signIn", { product: PRODUCT_NAME })
      : state.status === "error"
        ? t("title.verificationError", { product: PRODUCT_NAME })
        : PRODUCT_NAME,
  );

  switch (state.status) {
    case "unknown":
      return <LoadingScreen />;
    case "anonymous":
      return <SignInScreen />;
    case "error":
      return <VerificationErrorScreen error={state.error} onRetry={retryVerification} />;
    case "authenticated":
      return <AuthenticatedShell user={state.user} logoutState={logoutState} onLogout={logout} />;
  }
}
