/**
 * Line tax (VAT / НӨАТ + city tax / НХАТ). Pure; bigint möngö, rates in bps.
 *
 * Tax is computed per line on the amount left AFTER that line's discounts
 * (line discounts and the line's share of cart discounts). Sale tax totals are
 * the sums of line taxes and are never recomputed from rounded totals.
 *
 * `amount` is expressed in the line's pricing mode:
 *   - tax-inclusive (default in Mongolia): `amount` is the gross to pay;
 *   - tax-exclusive: `amount` is the net before tax.
 *
 * Formulas (D = 10 000, v = effective VAT bps, c = city tax bps):
 *   inclusive:  vat  = round(gross × v / (D + v + c))
 *               city = round(gross × c / (D + v + c))
 *               net  = gross − vat − city
 *   exclusive:  vat  = round(net × v / D)
 *               city = round(net × c / D)
 *               gross = net + vat + city
 * Rounding is half away from zero (money.ts HALF_UP), once per component.
 */
import { BPS_DENOMINATOR, mulDiv, type Money } from "./money";

export type TaxTreatment = "STANDARD" | "ZERO_RATED" | "EXEMPT";

export interface TaxRule {
  treatment: TaxTreatment;
  /** VAT rate in bps (1000 = 10%). Ignored (treated as 0) unless STANDARD. */
  vatRateBps: number;
  /** City tax rate in bps (100 = 1%). Applies for any treatment. */
  cityTaxRateBps: number;
  pricesIncludeTax: boolean;
}

export interface LineTax {
  net: Money;
  vat: Money;
  cityTax: Money;
  gross: Money;
}

const MAX_RATE_BPS = 10_000;

function assertRate(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_RATE_BPS) {
    throw new RangeError(`${label} must be an integer in 0..${MAX_RATE_BPS} bps, got ${value}`);
  }
}

/** VAT rate that actually applies for a treatment. */
export function effectiveVatBps(rule: Pick<TaxRule, "treatment" | "vatRateBps">): number {
  return rule.treatment === "STANDARD" ? rule.vatRateBps : 0;
}

/**
 * Split a post-discount line amount into net / vat / city tax / gross.
 * Invariants: `net + vat + cityTax === gross`, every part ≥ 0.
 */
export function computeLineTax(amount: Money, rule: TaxRule): LineTax {
  if (amount < 0n) throw new RangeError("computeLineTax: amount must not be negative");
  assertRate(rule.vatRateBps, "vatRateBps");
  assertRate(rule.cityTaxRateBps, "cityTaxRateBps");
  const v = BigInt(effectiveVatBps(rule));
  const c = BigInt(rule.cityTaxRateBps);

  if (rule.pricesIncludeTax) {
    const gross = amount;
    const divisor = BPS_DENOMINATOR + v + c;
    const vat = mulDiv(gross, v, divisor);
    // Guard: with pathological rates two round-ups could exceed the gross.
    const cityTax = clampTo(mulDiv(gross, c, divisor), gross - vat);
    return { net: gross - vat - cityTax, vat, cityTax, gross };
  }
  const net = amount;
  const vat = mulDiv(net, v, BPS_DENOMINATOR);
  const cityTax = mulDiv(net, c, BPS_DENOMINATOR);
  return { net, vat, cityTax, gross: net + vat + cityTax };
}

function clampTo(value: Money, ceiling: Money): Money {
  return value > ceiling ? ceiling : value;
}
