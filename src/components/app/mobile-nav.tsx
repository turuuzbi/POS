"use client";

import { Menu } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { NavLinks, type NavKey } from "./nav-links";

export function MobileNav({ items }: { items: NavKey[] }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden" aria-label={t("common.openMenu")}>
          <Menu className="size-5" aria-hidden />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" closeLabel={t("common.close")} aria-describedby={undefined}>
        <SheetTitle className="px-4 pt-5">{t("common.appName")}</SheetTitle>
        <nav aria-label={t("nav.label")} className="px-2">
          <NavLinks items={items} onNavigate={() => setOpen(false)} />
        </nav>
      </SheetContent>
    </Sheet>
  );
}
