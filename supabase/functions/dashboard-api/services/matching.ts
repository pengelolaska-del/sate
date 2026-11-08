// ─── MatchingService ──────────────────────────────────────────
// Uses PostgreSQL function run_matching() to avoid Edge Function memory limits
import { Api, ApiException } from "../lib/api.ts";
import * as N from "../lib/normalizer.ts";

export class MatchingService {
  constructor(private sql: any) {}

  async handleRun(p: Record<string, any>) {
    const periode = p.periode;
    if (typeof periode !== "string" || !/^\d{4}-\d{2}$/.test(periode)) {
      throw new ApiException("Periode wajib.");
    }
    const [tahun, bulan] = periode.split("-").map(Number);
    const res = await this.run(periode);
    await this.buildAggregate(periode, bulan, tahun);
    return Api.ok({ ...res, periode }, "Matching selesai.");
  }

  async buildAggregate(periode: string, bulan: number, tahun: number) {
    const agg = await this.computeAggregate(periode);
    const existing = await this.sql`SELECT 1 FROM dashboard_aggregates WHERE periode = ${periode}`;
    if (existing.length > 0) {
      const updateData = { ...agg, bulan, tahun, created_at: new Date().toISOString() };
      const setClauses = Object.keys(updateData).map((k, i) => `"${k}" = $${i + 1}`).join(", ");
      const vals = Object.values(updateData);
      await this.sql.unsafe(
        `UPDATE dashboard_aggregates SET ${setClauses} WHERE periode = $${vals.length + 1}`,
        [...vals, periode]
      );
    } else {
      const insertData: Record<string, any> = { aggregate_id: crypto.randomUUID(), periode, ...agg, bulan, tahun, created_at: new Date().toISOString() };
      const cols = Object.keys(insertData);
      const vals = Object.values(insertData);
      await this.sql.unsafe(
        `INSERT INTO dashboard_aggregates (${cols.map(c => `"${c}"`).join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
        vals
      );
    }
  }

  async computeAggregate(periode: string, satkers?: string[]) {
    const satkerFilter = satkers && satkers.length > 0;

    let rup;
    if (satkerFilter) {
      rup = (await this.sql`SELECT count(*) AS n, COALESCE(sum(pagu),0) AS pagu FROM rup_records WHERE periode = ${periode} AND kode_satker = ANY(${satkers})`)[0];
    } else {
      rup = (await this.sql`SELECT count(*) AS n, COALESCE(sum(pagu),0) AS pagu FROM rup_records WHERE periode = ${periode}`)[0];
    }

    let real;
    if (satkerFilter) {
      real = (await this.sql`SELECT count(*) AS n, COALESCE(sum(nilai_pdn),0) AS pdn,
        count(*) FILTER (WHERE status_paket = 'Selesai') AS selesai,
        count(*) FILTER (WHERE status_paket = 'Sedang Berjalan') AS berjalan,
        count(*) FILTER (WHERE status_paket = 'Belum Berproses') AS belum
        FROM realisasi_records WHERE periode = ${periode} AND kode_satker = ANY(${satkers})`)[0];
    } else {
      real = (await this.sql`SELECT count(*) AS n, COALESCE(sum(nilai_pdn),0) AS pdn,
        count(*) FILTER (WHERE status_paket = 'Selesai') AS selesai,
        count(*) FILTER (WHERE status_paket = 'Sedang Berjalan') AS berjalan,
        count(*) FILTER (WHERE status_paket = 'Belum Berproses') AS belum
        FROM realisasi_records WHERE periode = ${periode}`)[0];
    }

    let match;
    if (satkerFilter) {
      match = (await this.sql`SELECT
        count(*) FILTER (WHERE status_matching = 'MATCHED') AS matched,
        COALESCE(sum(nilai_kontrak) FILTER (WHERE status_matching = 'MATCHED'), 0) AS kontrak,
        count(*) FILTER (WHERE status_matching = 'UNMATCHED' AND COALESCE(kode_rup,'') <> '' AND COALESCE(kode_paket,'') = '') AS um_rup,
        count(*) FILTER (WHERE status_matching = 'UNMATCHED' AND COALESCE(kode_paket,'') <> '') AS um_real
        FROM matching_results WHERE periode = ${periode} AND kode_satker = ANY(${satkers})`)[0];
    } else {
      match = (await this.sql`SELECT
        count(*) FILTER (WHERE status_matching = 'MATCHED') AS matched,
        COALESCE(sum(nilai_kontrak) FILTER (WHERE status_matching = 'MATCHED'), 0) AS kontrak,
        count(*) FILTER (WHERE status_matching = 'UNMATCHED' AND COALESCE(kode_rup,'') <> '' AND COALESCE(kode_paket,'') = '') AS um_rup,
        count(*) FILTER (WHERE status_matching = 'UNMATCHED' AND COALESCE(kode_paket,'') <> '') AS um_real
        FROM matching_results WHERE periode = ${periode}`)[0];
    }

    let sel;
    if (satkerFilter) {
      sel = (await this.sql`SELECT COALESCE(sum(m.pagu_rup),0) AS pagu, COALESCE(sum(m.nilai_kontrak),0) AS kontrak
        FROM matching_results m
        WHERE m.periode = ${periode} AND m.status_matching = 'MATCHED' AND COALESCE(m.kode_paket,'') <> ''
        AND m.kode_satker = ANY(${satkers})
        AND EXISTS (SELECT 1 FROM realisasi_records r WHERE r.periode = m.periode AND r.kode_paket = m.kode_paket AND r.status_paket = 'Selesai')`)[0];
    } else {
      sel = (await this.sql`SELECT COALESCE(sum(m.pagu_rup),0) AS pagu, COALESCE(sum(m.nilai_kontrak),0) AS kontrak
        FROM matching_results m
        WHERE m.periode = ${periode} AND m.status_matching = 'MATCHED' AND COALESCE(m.kode_paket,'') <> ''
        AND EXISTS (SELECT 1 FROM realisasi_records r WHERE r.periode = m.periode AND r.kode_paket = m.kode_paket AND r.status_paket = 'Selesai')`)[0];
    }

    const tPagu = Number(rup.pagu), tKontrak = Number(match.kontrak), tPdn = Number(real.pdn);
    const tPaguSel = Number(sel.pagu), tKontrakSel = Number(sel.kontrak);

    return {
      total_pagu: tPagu, total_kontrak: tKontrak,
      total_efisiensi: tPagu - tKontrak,
      persen_efisiensi: tPagu > 0 ? Math.round((tPagu - tKontrak) / tPagu * 10000) / 100 : 0,
      jumlah_paket_rup: Number(rup.n), jumlah_paket_realisasi: Number(real.n),
      jumlah_matched: Number(match.matched), jumlah_unmatched_rup: Number(match.um_rup),
      jumlah_unmatched_realisasi: Number(match.um_real),
      jumlah_selesai: Number(real.selesai), jumlah_sedang_berjalan: Number(real.berjalan),
      jumlah_belum_berproses: Number(real.belum),
      total_nilai_pdn: tPdn, persen_pdn: tKontrak > 0 ? Math.round(tPdn / tKontrak * 10000) / 100 : 0,
      total_pagu_selesai: tPaguSel, total_kontrak_selesai: tKontrakSel,
      total_efisiensi_selesai: tPaguSel - tKontrakSel,
      persen_efisiensi_selesai: tPaguSel > 0 ? Math.round((tPaguSel - tKontrakSel) / tPaguSel * 10000) / 100 : 0,
    };
  }

  // Call PostgreSQL function - runs entirely on DB server, no JS memory needed
  async run(periode: string): Promise<{ matched: number; unmatched: number; orphan: number }> {
    console.log(`[matching] Calling run_matching('${periode}') on PostgreSQL...`);
    const result = await this.sql`SELECT * FROM run_matching(${periode})`;
    const r = result[0] ?? { matched: 0, unmatched: 0, orphan: 0 };
    console.log(`[matching] Done: matched=${r.matched} unmatched=${r.unmatched} orphan=${r.orphan}`);
    return { matched: Number(r.matched), unmatched: Number(r.unmatched), orphan: Number(r.orphan) };
  }
}
