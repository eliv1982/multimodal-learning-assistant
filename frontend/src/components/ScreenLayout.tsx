import type { ReactNode } from "react";

import { LanguageSwitcher } from "./LanguageSwitcher";

/** The frame of the centred single-card screens (loading, sign-in, verification error). */
export function ScreenLayout({ children }: { children: ReactNode }) {
  return (
    <div className="screen">
      <header className="screen-header">
        <LanguageSwitcher />
      </header>
      <main className="screen-main">{children}</main>
    </div>
  );
}
