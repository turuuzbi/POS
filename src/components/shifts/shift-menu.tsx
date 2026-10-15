"use client";

import { ArrowLeftRight, ChartNoAxesColumn, Clock, DoorClosed } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { hasPermission, type Role } from "@/domain/permissions";
import { CashDialog } from "./cash-dialog";
import { CloseShiftDialog } from "./close-shift-dialog";
import { XReportDialog } from "./x-report-dialog";

type Dialog = null | "x" | "cash" | "close";

/**
 * The register header's Shift menu: X report, cash in/out, close shift. Cashiers
 * do a blind close: the expected cash stays hidden until they have counted.
 */
export function ShiftMenu({
  shiftId,
  role,
  heldCount,
  cartCount,
  charging,
}: {
  shiftId: string;
  role: Role;
  heldCount: number;
  cartCount: number;
  charging: boolean;
}) {
  const t = useTranslations("shifts.menu");
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>(null);
  const seesExpected = hasPermission(role, "reports.view");
  const close = () => setDialog(null);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="gap-2 px-2" data-testid="shift-menu">
            <Clock className="size-5" aria-hidden />
            <span className="hidden md:inline">{t("label")}</span>
            <span className="sr-only md:hidden">{t("label")}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem className="min-h-11" onSelect={() => setDialog("x")}>
            <ChartNoAxesColumn aria-hidden />
            {t("xReport")}
          </DropdownMenuItem>
          <DropdownMenuItem className="min-h-11" onSelect={() => setDialog("cash")}>
            <ArrowLeftRight aria-hidden />
            {t("cash")}
          </DropdownMenuItem>
          <DropdownMenuItem className="min-h-11" onSelect={() => setDialog("close")}>
            <DoorClosed aria-hidden />
            {t("close")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <XReportDialog
        open={dialog === "x"}
        onClose={close}
        shiftId={shiftId}
        hideExpected={!seesExpected}
      />
      <CashDialog open={dialog === "cash"} onClose={close} />
      <CloseShiftDialog
        open={dialog === "close"}
        onClose={close}
        shiftId={shiftId}
        heldCount={heldCount}
        cartCount={cartCount}
        charging={charging}
        onFinished={() => router.refresh()}
      />
    </>
  );
}
