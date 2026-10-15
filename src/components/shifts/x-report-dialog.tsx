"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState, useTransition } from "react";
import { PosDialog } from "@/components/pos/pos-dialog";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import type { ShiftDetail } from "@/server/queries/shifts";
import { shiftReportAction } from "@/server/actions/shifts";
import { parseShiftDetailJson } from "./detail-json";
import { PrintableReport } from "./report-view";
import { useShiftErrorMessage } from "./use-shift-error";

/** Loads a shift's report (live X for an open shift, frozen Z for a closed one). */
export function useShiftReport(shiftId: string, active: boolean) {
  const errorMessage = useShiftErrorMessage();
  const [detail, setDetail] = useState<ShiftDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, startTransition] = useTransition();

  const load = useCallback(() => {
    startTransition(async () => {
      try {
        const result = await shiftReportAction({ shiftId });
        if (!result.ok) {
          setError(errorMessage(result.error));
          return;
        }
        const parsed = parseShiftDetailJson(result.data);
        if (parsed) {
          setDetail(parsed);
          setError(null);
        } else setError(errorMessage({ code: "INTERNAL" }));
      } catch {
        setError(errorMessage({ code: "INTERNAL" }));
      }
    });
  }, [shiftId, errorMessage]);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  return { detail, loading, error, reload: load };
}

/** Print-friendly X report of the open shift. The expected cash stays hidden for a blind close. */
export function XReportDialog(props: XReportDialogProps) {
  return props.open ? <XReportBody {...props} /> : null;
}

interface XReportDialogProps {
  open: boolean;
  onClose: () => void;
  shiftId: string;
  hideExpected: boolean;
}

function XReportBody({
  open,
  onClose,
  shiftId,
  hideExpected,
}: {
  open: boolean;
  onClose: () => void;
  shiftId: string;
  hideExpected: boolean;
}) {
  const t = useTranslations("shifts");
  const { detail, loading, error, reload } = useShiftReport(shiftId, open);
  return (
    <PosDialog
      open={open}
      onClose={onClose}
      title={t("report.titleX")}
      description={t("report.subtitleX")}
      className="grid-cols-[minmax(0,1fr)] sm:max-w-2xl"
    >
      <div data-testid="x-report">
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {detail ? (
          <PrintableReport
            report={detail.report}
            meta={{
              registerName: detail.shift.registerName,
              locationName: detail.shift.locationName,
              openedByName: detail.shift.openedByName,
              closedByName: detail.shift.closedByName,
              zNumber: detail.shift.zReportNumber,
            }}
            movements={detail.movements}
            hideExpected={hideExpected}
            onRefresh={reload}
            refreshing={loading}
          />
        ) : loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("report.loading")}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {t("cash.back")}
        </Button>
      </DialogFooter>
    </PosDialog>
  );
}
