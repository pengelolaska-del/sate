// ─── DashboardQueryService ────────────────────────────────────
import { Api, ApiException } from "../lib/api.ts";
import * as N from "../lib/normalizer.ts";
import { castRow, castAll } from "../lib/rows.ts";
import { PeriodeService } from "./periode.ts";
import { MatchingService } from "./matching.ts";

export class DashboardQueryService {
  private matching: MatchingService;
  constructor(private sql: any, private periodes: PeriodeService) {
    this.matching = new MatchingService(sql);
  }

  private async periode(p: Record<string, any>): Promise<string> {
    if (p.periode) return p.periode;
    const r = await this.sql`SELECT MAX(periode) AS p FROM rup_records`;
    return String(r[0].p ?? "");
  }

  async kpi(p: Record<string, any>) {
    const periode = await this.periode(p);
    const satkers = N.satkerList(p.kode_satker ?? null);

    if (satkers.length === 0) {
      const row = await this.sql`SELECT * FROM dashboard_aggregates WHERE periode = ${periode}`;
      if (row.length === 0) throw new ApiException("Data tidak ditemukan.", 404);
      return Api.ok(castRow({ ...row[0] }));
    }
    const agg = await this.matching.computeAggregate(periode, satkers);
    return Api.ok({ periode, kode_satker: p.kode_satker, ...agg });
  }

  async opd(p: Record<string, any>) {
    const periode = await this.periode(p);
    const matchRows = await this.sql`
      SELECT kode_satker,
        count(*) FILTER (WHERE COALESCE(kode_paket,'') <> '') AS jumlah_real,
        count(*) FILTER (WHERE status_matching = 'MATCHED') AS jumlah_matched,
        COALESCE(sum(nilai_kontrak) FILTER (WHERE status_matching = 'MATCHED'), 0) AS total_kontrak
      FROM matching_results WHERE periode = ${periode}
      GROUP BY kode_satker`;
    const matchMap: Record<string, any> = {};
    for (const r of matchRows) matchMap[r.kode_satker] = r;

    const rupRows = await this.sql`
      SELECT kode_satker, MIN(nama_satker) AS nama_satker, COALESCE(sum(pagu),0) AS total_pagu, count(*) AS jumlah_rup
      FROM rup_records WHERE periode = ${periode}
      GROUP BY kode_satker`;

    const rows = rupRows.map((r: any) => {
      const m = matchMap[r.kode_satker];
      const pagu = Number(r.total_pagu), kontrak = Number(m?.total_kontrak ?? 0);
      return {
        kode_satker: r.kode_satker, nama_satker: r.nama_satker,
        total_pagu: pagu, total_kontrak: kontrak,
        jumlah_rup: Number(r.jumlah_rup), jumlah_real: Number(m?.jumlah_real ?? 0),
        jumlah_matched: Number(m?.jumlah_matched ?? 0),
        efisiensi: pagu - kontrak,
        persen_efisiensi: pagu > 0 ? Math.round((pagu - kontrak) / pagu * 10000) / 100 : 0,
      };
    }).sort((a: any, b: any) => b.total_pagu - a.total_pagu);

    return Api.ok(rows);
  }

  async metode(p: Record<string, any>) {
    const periode = await this.periode(p);
    const s = N.satkerList(p.kode_satker ?? null);
    return Api.ok({
      metode_rup: await this.group("rup_records", "metode_pengadaan", "pagu", periode, s),
      jenis_rup: await this.group("rup_records", "jenis_pengadaan", "pagu", periode, s),
      metode_real: await this.group("realisasi_records", "metode_pengadaan", "nilai_kontrak", periode, s),
      jenis_real: await this.group("realisasi_records", "jenis_pengadaan", "nilai_kontrak", periode, s),
    });
  }

  async status(p: Record<string, any>) {
    const periode = await this.periode(p);
    const s = N.satkerList(p.kode_satker ?? null);
    const dist = await this.group("realisasi_records", "status_paket", null, periode, s);
    const count = (label: string) => dist.find((d: any) => d.label === label)?.value ?? 0;
    return Api.ok({
      distribusi: dist.map((d: any) => ({ label: d.label, value: d.value })),
      total: dist.reduce((s: number, d: any) => s + d.value, 0),
      selesai: count("Selesai"), sedang_berjalan: count("Sedang Berjalan"), belum_berproses: count("Belum Berproses"),
    });
  }

  async sumber(p: Record<string, any>) {
    const periode = await this.periode(p);
    const s = N.satkerList(p.kode_satker ?? null);
    const strip = (g: any[]) => g.map(d => ({ label: d.label, value: d.value }));
    return Api.ok({
      sumber_dana: strip(await this.group("realisasi_records", "sumber_dana", null, periode, s)),
      sumber_transaksi: strip(await this.group("realisasi_records", "sumber_transaksi", null, periode, s)),
    });
  }

  async penyedia(p: Record<string, any>) {
    const periode = await this.periode(p);
    const satkers = N.satkerList(p.kode_satker ?? null);
    let rows;
    if (satkers.length > 0) {
      rows = await this.sql`
        SELECT TRIM(nama_penyedia) AS nama_penyedia, count(*) AS jumlah, COALESCE(sum(nilai_kontrak),0) AS total_nilai
        FROM realisasi_records WHERE periode = ${periode} AND COALESCE(TRIM(nama_penyedia),'') <> '' AND kode_satker = ANY(${satkers})
        GROUP BY TRIM(nama_penyedia) ORDER BY COALESCE(sum(nilai_kontrak),0) DESC LIMIT 10`;
    } else {
      rows = await this.sql`
        SELECT TRIM(nama_penyedia) AS nama_penyedia, count(*) AS jumlah, COALESCE(sum(nilai_kontrak),0) AS total_nilai
        FROM realisasi_records WHERE periode = ${periode} AND COALESCE(TRIM(nama_penyedia),'') <> ''
        GROUP BY TRIM(nama_penyedia) ORDER BY COALESCE(sum(nilai_kontrak),0) DESC LIMIT 10`;
    }
    return Api.ok(castAll(rows));
  }

  async efisiensi(p: Record<string, any>) {
    const periode = await this.periode(p);
    const satkers = N.satkerList(p.kode_satker ?? null);
    let rows;
    if (satkers.length > 0) {
      rows = await this.sql`
        SELECT kode_satker, MIN(nama_satker) AS nama_satker, COALESCE(sum(pagu_rup),0) AS total_pagu, COALESCE(sum(nilai_kontrak),0) AS total_kontrak
        FROM matching_results WHERE periode = ${periode} AND status_matching = 'MATCHED' AND kode_satker = ANY(${satkers})
        GROUP BY kode_satker`;
    } else {
      rows = await this.sql`
        SELECT kode_satker, MIN(nama_satker) AS nama_satker, COALESCE(sum(pagu_rup),0) AS total_pagu, COALESCE(sum(nilai_kontrak),0) AS total_kontrak
        FROM matching_results WHERE periode = ${periode} AND status_matching = 'MATCHED'
        GROUP BY kode_satker`;
    }
    const result = rows.map((r: any) => {
      const pagu = Number(r.total_pagu), kontrak = Number(r.total_kontrak);
      return { kode_satker: r.kode_satker, nama_satker: r.nama_satker, total_pagu: pagu, total_kontrak: kontrak,
        efisiensi: pagu - kontrak, persen_efisiensi: pagu > 0 ? Math.round((pagu - kontrak) / pagu * 10000) / 100 : 0 };
    }).sort((a: any, b: any) => b.efisiensi - a.efisiensi);
    return Api.ok(result);
  }

  async tren(_p: Record<string, any>) {
    const rows = await this.sql`SELECT * FROM dashboard_aggregates ORDER BY periode`;
    return Api.ok(castAll(rows));
  }

  async detailPaket(p: Record<string, any>) {
    const periode = await this.periode(p);
    const page = Math.max(1, Number(p.page ?? 1));
    const perPage = Math.max(1, Math.min(500, Number(p.per_page ?? 50)));
    const satkers = N.satkerList(p.kode_satker ?? null);

    const conditions: string[] = [`periode = $1`];
    const params: any[] = [periode];
    let idx = 2;
    if (satkers.length > 0) { conditions.push(`kode_satker = ANY($${idx})`); params.push(satkers); idx++; }
    if (p.search) {
      const like = `%${p.search}%`;
      conditions.push(`(nama_paket_rup ILIKE $${idx} OR nama_satker ILIKE $${idx} OR kode_rup LIKE $${idx})`);
      params.push(like); idx++;
    }
    const where = conditions.join(" AND ");
    const totalRow = await this.sql.unsafe(`SELECT count(*) AS n FROM matching_results WHERE ${where}`, params);
    const total = Number(totalRow[0].n);
    const items = await this.sql.unsafe(
      `SELECT id, kode_rup, kode_paket, kode_satker, nama_satker,
        nama_paket_rup, nama_paket_realisasi, pagu_rup, nilai_kontrak, status_matching
        FROM matching_results WHERE ${where} ORDER BY id OFFSET $${idx} LIMIT $${idx + 1}`,
      [...params, (page - 1) * perPage, perPage]);

    return Api.ok({
      total, page, per_page: perPage, total_pages: Math.ceil(total / perPage),
      items: castAll(items),
    });
  }

  private async group(table: string, col: string, sumCol: string | null, periode: string, satkers: string[]): Promise<any[]> {
    const sum = sumCol ? `COALESCE(sum(${sumCol}), 0)` : "0";
    let rows;
    if (satkers.length > 0) {
      rows = await this.sql.unsafe(
        `SELECT COALESCE(NULLIF(${col},''), 'Tidak Diketahui') AS label, count(*) AS value, ${sum} AS total_nilai
         FROM ${table} WHERE periode = $1 AND kode_satker = ANY($2)
         GROUP BY COALESCE(NULLIF(${col},''), 'Tidak Diketahui') ORDER BY count(*) DESC`,
        [periode, satkers]);
    } else {
      rows = await this.sql.unsafe(
        `SELECT COALESCE(NULLIF(${col},''), 'Tidak Diketahui') AS label, count(*) AS value, ${sum} AS total_nilai
         FROM ${table} WHERE periode = $1
         GROUP BY COALESCE(NULLIF(${col},''), 'Tidak Diketahui') ORDER BY count(*) DESC`,
        [periode]);
    }
    return rows.map((r: any) => ({ label: r.label, value: Number(r.value), total_nilai: Number(r.total_nilai) }));
  }
}
