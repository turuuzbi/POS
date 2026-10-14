"use client";

import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";
import { formatMoney, type Money } from "@/domain/money";
import { formatQty, type Unit } from "@/domain/qty";

/** Locale-aware money / quantity text for the register. */
export function useFormat() {
  const locale = useLocale();
  const tu = useTranslations("units");
  return useMemo(
    () => ({
      locale,
      money: (amount: Money) => formatMoney(amount, { locale }),
      qty: (qtyMilli: number, unit: Unit) => formatQty(qtyMilli, unit, { locale }),
      unit: (unit: Unit) => tu(unit),
    }),
    [locale, tu],
  );
}

export type Format = ReturnType<typeof useFormat>;
