// ─── Periode helper ───────────────────────────────────────────

/** "2026-08" → "2026-07", "2026-01" → "2025-12" */
export function prevPeriode(periode: string): string {
  const parts = periode.split("-").map(Number);
  let [y, m] = parts;
  m--;
  if (m < 1) { m = 12; y--; }
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}
