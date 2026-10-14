/** Basis points → the percentage a person types: 1000 → "10", 250 → "2.5". */
export function bpsToPercent(bps: number): string {
  return (bps / 100).toFixed(2).replace(/\.?0+$/, "");
}
