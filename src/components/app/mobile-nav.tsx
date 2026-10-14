"use client";

import { Menu } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import type { VisibleNav } from "./nav-config";
import { NavLinks } from "./nav-links";

export function MobileNav({ nav }: { nav: VisibleNav }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden" aria-label={t("common.openMenu")}>
          <Menu className="size-5" aria-hidden />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="overflow-y-auto"
        closeLabel={t("common.close")}
        aria-describedby={undefined}
      >
        <SheetTitle className="px-4 pt-5">{t("common.appName")}</SheetTitle>
        <nav aria-label={t("nav.label")} className="px-2">
          <NavLinks nav={nav} onNavigate={() => setOpen(false)} />
        </nav>
      </SheetContent>
    </Sheet>
  );
}
