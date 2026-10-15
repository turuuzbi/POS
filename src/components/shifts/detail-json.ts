import { z } from "zod";
import { shiftReportJsonSchema } from "@/domain/report-json";
import type { ShiftDetail } from "@/server/queries/shifts";

const money = z
  .string()
  .regex(/^-?\d+$/)
  .transform((v) => BigInt(v));
const date = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

/** `shiftReportAction`'s JSON → the typed detail (money back to bigint, dates to Date). */
const detailJsonSchema = z.object({
  shift: z.object({
    id: z.string(),
    status: z.enum(["OPEN", "CLOSED"]),
    locationId: z.string(),
    locationName: z.string(),
    registerId: z.string(),
    registerName: z.string(),
    openedAt: date,
    openedByName: z.string(),
    closedAt: date.nullable(),
    closedByName: z.string().nullable(),
    openingFloat: money,
    expectedCash: money.nullable(),
    countedCash: money.nullable(),
    cashVariance: money.nullable(),
    closingNote: z.string().nullable(),
    zReportNumber: z.number().int().nullable(),
  }),
  report: shiftReportJsonSchema,
  movements: z.array(
    z.object({
      id: z.string(),
      type: z.enum(["CASH_IN", "CASH_OUT"]),
      amount: money,
      reason: z.string(),
      createdAt: date,
      createdByName: z.string(),
      approvedByName: z.string().nullable(),
    }),
  ),
});

export function parseShiftDetailJson(json: unknown): ShiftDetail | null {
  const parsed = detailJsonSchema.safeParse(json);
  return parsed.success ? (parsed.data as unknown as ShiftDetail) : null;
}
