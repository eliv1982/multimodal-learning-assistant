import { useI18n } from "../i18n/useI18n";
import { ScreenLayout } from "./ScreenLayout";

export function LoadingScreen() {
  const { t } = useI18n();

  return (
    <ScreenLayout>
      <div className="card" role="status" aria-live="polite">
        <p className="muted">{t("loading.session")}</p>
      </div>
    </ScreenLayout>
  );
}
