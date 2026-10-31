// ─── SumberTransaksi filter ───────────────────────────────────

const GABUNGAN: Record<string, string[]> = {
  Tender: ["Tender", "Seleksi"],
};

export function sumberTransaksiMatch(rowValue: string | null, filter: string | null): boolean {
  if (!filter) return true;
  const group = GABUNGAN[filter];
  return group ? group.includes(rowValue ?? "") : rowValue === filter;
}

export function sumberTransaksiRowMatches(row: Record<string, any>, filter: string | null): boolean {
  if (!filter) return true;
  if (row.ada_realisasi) {
    return sumberTransaksiMatch(row.sumber_transaksi ?? null, filter);
  }
  const group = GABUNGAN[filter];
  return group != null && group.includes(row.metode_pengadaan_rup ?? "");
}

export function sumberTransaksiGroupLabel(metodeRup: string | null): string | null {
  for (const [label, members] of Object.entries(GABUNGAN)) {
    if (members.includes(metodeRup ?? "")) return label;
  }
  return null;
}
