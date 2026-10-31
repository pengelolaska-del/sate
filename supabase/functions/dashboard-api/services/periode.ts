// ─── PeriodeService ───────────────────────────────────────────
import { Api, ApiException } from "../lib/api.ts";
import { castAll } from "../lib/rows.ts";

export class PeriodeService {
  constructor(private sql: any) {}

  async availablePeriodes(tahun?: string | null): Promise<string[]> {
    if (tahun) {
      const rows = await this.sql`
        SELECT DISTINCT periode FROM rup_records
        WHERE periode LIKE ${tahun + '-%'}
        ORDER BY periode DESC`;
      return rows.map((r: any) => r.periode);
    }
    const rows = await this.sql`
      SELECT DISTINCT periode FROM rup_records ORDER BY periode DESC`;
    return rows.map((r: any) => r.periode);
  }

  async listPeriode(_p: Record<string, any>) {
    const periodes = await this.availablePeriodes();
    const latest = periodes[0] ?? "";

    let satker: any[] = [];
    if (latest !== "") {
      satker = await this.sql`
        SELECT kode_satker, MIN(nama_satker) AS nama_satker
        FROM rup_records WHERE periode = ${latest}
        GROUP BY kode_satker ORDER BY MIN(nama_satker)`;
      satker = satker.map(r => ({ kode_satker: r.kode_satker, nama_satker: r.nama_satker }));
    }

    return Api.ok({ periodes, latest_periode: latest, satker_list: satker });
  }

  async getUploadLog(p: Record<string, any>) {
    let rows;
    if (p.periode) {
      rows = await this.sql`
        SELECT * FROM upload_logs WHERE periode = ${p.periode}
        ORDER BY uploaded_at DESC LIMIT 200`;
    } else {
      rows = await this.sql`
        SELECT * FROM upload_logs ORDER BY uploaded_at DESC LIMIT 200`;
    }
    return Api.ok(castAll(rows));
  }

  async deletePeriode(p: Record<string, any>) {
    const periode = p.periode;
    if (!periode) throw new ApiException("Periode wajib.");

    await this.sql.begin(async (tx: any) => {
      for (const t of ["rup_records", "realisasi_records", "matching_results", "dashboard_aggregates", "upload_logs"]) {
        await tx.unsafe(`DELETE FROM ${t} WHERE periode = $1`, [periode]);
      }
    });

    return Api.ok(null, `Periode ${periode} berhasil dihapus.`);
  }

  async deleteByLog(p: Record<string, any>) {
    const items = p.items;
    if (!Array.isArray(items) || items.length === 0) {
      throw new ApiException("Tidak ada item dipilih.");
    }

    await this.sql.begin(async (tx: any) => {
      for (const item of items) {
        const periode = item.periode;
        const jenis = item.jenis_data;
        if (!periode || !["RUP", "REALISASI"].includes(jenis)) continue;
        const table = jenis === "RUP" ? "rup_records" : "realisasi_records";
        await tx.unsafe(`DELETE FROM ${table} WHERE periode = $1`, [periode]);
        await tx`DELETE FROM matching_results WHERE periode = ${periode}`;
        await tx`DELETE FROM dashboard_aggregates WHERE periode = ${periode}`;
        await tx`DELETE FROM upload_logs WHERE periode = ${periode} AND jenis_data = ${jenis}`;
      }
    });

    return Api.ok(null, `${items.length} item berhasil dihapus.`);
  }
}
