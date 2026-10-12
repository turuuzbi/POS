import type * as React from "react";
import { PreferencesMenu } from "@/components/app/preferences-menu";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-muted/40">
      <header className="flex justify-end p-3">
        <PreferencesMenu />
      </header>
      <main id="main" className="flex flex-1 items-start justify-center px-4 pb-10 sm:items-center">
        {children}
      </main>
    </div>
  );
}
