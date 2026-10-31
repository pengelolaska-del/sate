// ─── Rows: numeric casting for frontend ───────────────────────

const NUMERIC_FIELDS = new Set([
  "id", "bulan", "tahun", "pagu", "pagu_rup", "nilai_kontrak", "nilai_pdn",
  "efisiensi", "persen_efisiensi", "similarity_score",
  "total_pagu", "total_kontrak", "total_efisiensi", "total_nilai_pdn", "persen_pdn",
  "total_pagu_selesai", "total_kontrak_selesai", "total_efisiensi_selesai",
  "persen_efisiensi_selesai", "total_nilai", "value",
]);

export function castRow(row: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...row };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== "string" && typeof v !== "number") continue;
    if (NUMERIC_FIELDS.has(k) || k.startsWith("jumlah_")) {
      const n = Number(v);
      if (!isNaN(n)) out[k] = n;
    }
  }
  return out;
}

export function castAll(rows: any[]): Record<string, any>[] {
  return rows.map(r => castRow(typeof r === "object" ? { ...r } : r));
}
