"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { shiftCodeFromFailure } from "@/domain/shift-failure";
import type { ActionFailure } from "@/server/actions/define-action";

/** Message for any action failure: the shift code when there is one, else the generic code. */
export function useShiftErrorMessage() {
  const ts = useTranslations("shifts.errors");
  const te = useTranslations("errors");
  return useCallback(
    (failure: ActionFailure): string => {
      const shift = shiftCodeFromFailure(failure);
      return shift ? ts(shift.code) : te(failure.code);
    },
    [ts, te],
  );
}
