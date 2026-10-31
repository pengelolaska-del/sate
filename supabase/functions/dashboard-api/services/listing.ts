// ─── ListingService ───────────────────────────────────────────
import { Api } from "../lib/api.ts";
import * as N from "../lib/normalizer.ts";
import { castRow, castAll } from "../lib/rows.ts";
import { PeriodeService } from "./periode.ts";

const SUMBER_TRANSAKSI_GABUNGAN: Record<string, string[]> = { Tender: ["Tender", "Seleksi"] };

export class ListingService {
  constructor(private sql: any, private periodes: PeriodeService) {}

  async listRup(p: Record<string, any>) {
    const periodes = await this.resolvePeriodes(p);
    const page = Math.max(1, Number(p.page ?? 1));
    const perPage = Math.max(1, Math.min(500, Number(p.per_page ?? 50)));

    let all: any[] = [];
    const seen: Record<string, boolean> = {};
    for (const pr of periodes) {
      const rows = await this.sql`SELECT * FROM rup_records WHERE periode = ${pr} ORDER BY id`;
      for (const r of rows) {
        if (periodes.length > 1) {
          if (seen[r.kode_rup]) continue;
          seen[r.kode_rup] = true;
        }
        all.push(castRow({ ...r }));
      }
    }

    const [realByRup, realByNama, groupByRup] = await this.indexRealisasi(periodes);
    all = all.map(r => this.enrich(r, realByRup, realByNama, groupByRup));
    const base = [...all];

    const satkers = N.satkerList(p.kode_satker ?? null);
    all = all.filter(r => {
      if (satkers.length > 0 && !satkers.includes(String(r.kode_satker))) return false;
      if (this.active(p, "cara_pengadaan") && N.cara(r.cara_pengadaan) !== N.cara(p.cara_pengadaan)) return false;
      for (const f of ["metode_pengadaan", "jenis_pengadaan", "sumber_dana"]) {
        if (this.active(p, f) && r[f] !== p[f]) return false;
      }
      if (p.kode_rup && !String(r.kode_rup).includes(String(p.kode_rup))) return false;
      if (p.nama_paket && !this.containsAny(N.keywords(p.nama_paket), r.nama_paket)) return false;
      if (this.active(p, "status_realisasi") && r.status_realisasi !== p.status_realisasi) return false;
      return true;
    });

    const jenis: Record<string, any> = {};
    const cara: Record<string, any> = {};
    const g = { selesai: 0, sedang_berjalan: 0, belum_berproses: 0, dibatalkan: 0, total_pagu: 0, total_kontrak: 0 };

    for (const r of all) {
      const pagu = Number(r.pagu);
      const kontrak = r.ada_realisasi ? Number(r.nilai_kontrak) : 0;
      const st = r.status_realisasi;

      const jk = r.jenis_pengadaan || "Tidak Terklasifikasi";
      jenis[jk] ??= { jenis: jk, total: 0, selesai: 0, sedang_berjalan: 0, belum_berproses: 0, dibatalkan: 0, total_pagu: 0, total_kontrak: 0 };
      jenis[jk].total++; jenis[jk].total_pagu += pagu; jenis[jk].total_kontrak += kontrak;

      const ck = N.cara(r.cara_pengadaan);
      cara[ck] ??= { cara_pengadaan: ck, total: 0, total_pagu: 0 };
      cara[ck].total++; cara[ck].total_pagu += pagu;

      const bucket = st === "Selesai" ? "selesai" : (st === "Sedang Berjalan" || st === "Campuran") ? "sedang_berjalan" : st === "Dibatalkan" ? "dibatalkan" : "belum_berproses";
      jenis[jk][bucket]++;
      (g as any)[bucket]++;
      g.total_pagu += pagu;
      g.total_kontrak += kontrak;
    }

    const ord: Record<string, number> = { "Belum Berproses": 0, "Sedang Berjalan": 1, Campuran: 1, Selesai: 2, Dibatalkan: 3 };
    all.sort((a, b) => {
      const c = (ord[a.status_realisasi] ?? 0) - (ord[b.status_realisasi] ?? 0);
      if (c !== 0) return c;
      return String(a.nama_satker ?? "").toLowerCase().localeCompare(String(b.nama_satker ?? "").toLowerCase());
    });

    const total = all.length;
    const sortDesc = (arr: any[]) => arr.sort((a, b) => b.total - a.total);

    return Api.ok({
      total, total_pagu: g.total_pagu, page, per_page: perPage,
      total_pages: Math.max(1, Math.ceil(total / perPage)),
      summary: g,
      cara_summary: sortDesc(Object.values(cara)),
      jenis_summary: sortDesc(Object.values(jenis)),
      items: all.slice((page - 1) * perPage, page * perPage),
      enums: {
        metode: this.distinct(base, "metode_pengadaan"),
        jenis: this.distinct(base, "jenis_pengadaan"),
        sumber: this.distinct(base, "sumber_dana"),
        satker: this.satkerEnum(base),
      },
    });
  }

  private async indexRealisasi(periodes: string[]): Promise<[Record<string, any>, Record<string, any>, Record<string, any[]>]> {
    const order: Record<string, number> = { Selesai: 0, "Sedang Berjalan": 1, Dibatalkan: 3 };
    const better = (old: any, cur: any) => old == null || (order[cur.status_paket] ?? 2) < (order[old.status_paket] ?? 2);

    const byRup: Record<string, any> = {};
    const byNama: Record<string, any> = {};
    const group: Record<string, any[]> = {};

    for (const pr of periodes) {
      const rows = await this.sql`
        SELECT kode_rup, kode_satker, nama_paket, status_paket, nama_penyedia, nilai_kontrak, kode_paket
        FROM realisasi_records WHERE periode = ${pr} ORDER BY id`;
      for (const obj of rows) {
        const r = { ...obj };
        const kr = String(r.kode_rup ?? "").trim();
        const nk = r.kode_satker + "|" + String(r.nama_paket ?? "").toLowerCase().trim();
        if (kr !== "" && better(byRup[kr], r)) byRup[kr] = r;
        if (better(byNama[nk], r)) byNama[nk] = r;
        if (kr !== "") (group[kr] ??= []).push(r);
      }
    }
    return [byRup, byNama, group];
  }

  private enrich(r: any, byRup: any, byNama: any, group: any): any {
    const kr = String(r.kode_rup ?? "").trim();
    const nk = r.kode_satker + "|" + String(r.nama_paket ?? "").toLowerCase().trim();
    const grp = kr !== "" ? group[kr] ?? null : null;

    if (grp && grp.length > 1) {
      const statuses = grp.map((x: any) => x.status_paket);
      const allSelesai = statuses.every((s: string) => s === "Selesai");
      const allBerjalan = statuses.every((s: string) => s === "Sedang Berjalan");
      return {
        ...r,
        ada_realisasi: true,
        status_realisasi: allSelesai ? "Selesai" : allBerjalan ? "Sedang Berjalan" : "Campuran",
        nama_penyedia: [...new Set(grp.map((x: any) => x.nama_penyedia).filter(Boolean))].join(", "),
        nilai_kontrak: grp.reduce((s: number, x: any) => s + Number(x.nilai_kontrak), 0),
        kode_paket: grp.map((x: any) => x.kode_paket).filter(Boolean).join(";"),
        is_realisasi_gabungan: true,
        jumlah_realisasi: grp.length,
        realisasi_list: grp.map((x: any) => ({
          kode_paket: x.kode_paket, nama_penyedia: x.nama_penyedia,
          nilai_kontrak: Number(x.nilai_kontrak), status_realisasi: x.status_paket,
        })),
      };
    }

    const real = byRup[kr] ?? byNama[nk] ?? null;
    return {
      ...r,
      ada_realisasi: real != null,
      status_realisasi: real ? (real.status_paket || "Sedang Berjalan") : "Belum Berproses",
      nama_penyedia: real ? (real.nama_penyedia || "") : null,
      nilai_kontrak: real ? Number(real.nilai_kontrak) : null,
      kode_paket: real ? (real.kode_paket || "") : null,
      is_realisasi_gabungan: false,
      jumlah_realisasi: real ? 1 : 0,
      realisasi_list: null,
    };
  }

  async listRealisasi(p: Record<string, any>) {
    const periodes = await this.resolvePeriodes(p);
    const page = Math.max(1, Number(p.page ?? 1));
    const perPage = Math.max(1, Math.min(500, Number(p.per_page ?? 50)));

    // Shared kode_rup
    const sharedRows = await this.sql`
      SELECT TRIM(kode_rup) AS k, count(*) AS n FROM realisasi_records
      WHERE periode = ANY(${periodes}) AND COALESCE(TRIM(kode_rup),'') <> ''
      GROUP BY TRIM(kode_rup) HAVING count(*) > 1`;
    const shared: Record<string, number> = {};
    for (const r of sharedRows) shared[r.k] = Number(r.n);

    // Build filter conditions
    const conditions: string[] = [`periode = ANY($1)`];
    const params: any[] = [periodes];
    let paramIdx = 2;

    const satkers = N.satkerList(p.kode_satker ?? null);
    if (satkers.length > 0) { conditions.push(`kode_satker = ANY($${paramIdx})`); params.push(satkers); paramIdx++; }
    if (this.active(p, "sumber_transaksi")) {
      const group = SUMBER_TRANSAKSI_GABUNGAN[p.sumber_transaksi];
      if (group) { conditions.push(`sumber_transaksi = ANY($${paramIdx})`); params.push(group); }
      else { conditions.push(`sumber_transaksi = $${paramIdx}`); params.push(p.sumber_transaksi); }
      paramIdx++;
    }
    for (const f of ["sumber_dana", "status_paket", "metode_pengadaan", "jenis_pengadaan"]) {
      if (this.active(p, f)) { conditions.push(`${f} = $${paramIdx}`); params.push(p[f]); paramIdx++; }
    }
    if (p.nama_penyedia) { conditions.push(`nama_penyedia ILIKE $${paramIdx}`); params.push(`%${p.nama_penyedia}%`); paramIdx++; }
    if (p.nama_paket) {
      const terms = N.keywords(p.nama_paket);
      if (terms.length > 0) {
        const orClauses = terms.map(() => { const r = `nama_paket ILIKE $${paramIdx}`; paramIdx++; return r; });
        conditions.push(`(${orClauses.join(" OR ")})`);
        params.push(...terms.map(t => `%${t}%`));
      }
    }
    if (p.kode_paket) { conditions.push(`kode_paket LIKE $${paramIdx}`); params.push(`%${p.kode_paket}%`); paramIdx++; }

    const where = conditions.join(" AND ");
    const totalRow = await this.sql.unsafe(`SELECT count(*) AS n FROM realisasi_records WHERE ${where}`, params);
    const total = Number(totalRow[0].n);
    const totalNilaiRow = await this.sql.unsafe(`SELECT COALESCE(sum(nilai_kontrak),0) AS n FROM realisasi_records WHERE ${where}`, params);
    const totalNilai = Number(totalNilaiRow[0].n);

    const items = await this.sql.unsafe(
      `SELECT * FROM realisasi_records WHERE ${where} ORDER BY id OFFSET $${paramIdx} LIMIT $${paramIdx + 1}`,
      [...params, (page - 1) * perPage, perPage],
    );
    const mappedItems = items.map((r: any) => {
      const row = castRow({ ...r });
      const kr = String(row.kode_rup ?? "").trim();
      row.jumlah_realisasi_kode_rup = kr !== "" ? (shared[kr] ?? 0) : 0;
      return row;
    });

    // Enums from filtered data
    const enumQuery = async (col: string) => {
      const rows = await this.sql.unsafe(
        `SELECT DISTINCT ${col} FROM realisasi_records WHERE ${where} AND ${col} IS NOT NULL AND ${col} <> '' ORDER BY ${col}`, params);
      return rows.map((r: any) => r[col]);
    };
    const satkerEnumRows = await this.sql.unsafe(
      `SELECT kode_satker AS k, MIN(nama_satker) AS n FROM realisasi_records WHERE ${where} GROUP BY kode_satker ORDER BY MIN(nama_satker)`, params);

    return Api.ok({
      total, total_nilai: totalNilai, page, per_page: perPage,
      total_pages: Math.ceil(total / perPage),
      items: mappedItems,
      enums: {
        transaksi: await enumQuery("sumber_transaksi"),
        sumber: await enumQuery("sumber_dana"),
        status: await enumQuery("status_paket"),
        metode: await enumQuery("metode_pengadaan"),
        jenis: await enumQuery("jenis_pengadaan"),
        satker: satkerEnumRows.map((r: any) => ({ k: r.k, n: r.n })),
      },
    });
  }

  private async resolvePeriodes(p: Record<string, any>): Promise<string[]> {
    if (p.periode) return [p.periode];
    if (p.tahun) return this.periodes.availablePeriodes(String(p.tahun));
    return (await this.periodes.availablePeriodes()).slice(0, 1);
  }

  private active(p: Record<string, any>, key: string): boolean {
    return !!p[key] && p[key] !== "Semua";
  }

  private containsAny(terms: string[], field: any): boolean {
    const hay = String(field ?? "").toLowerCase();
    for (const t of terms) if (hay.includes(t)) return true;
    return terms.length === 0;
  }

  private distinct(rows: any[], key: string): string[] {
    const vals = [...new Set(rows.map(r => r[key]).filter(Boolean))].sort();
    return vals;
  }

  private satkerEnum(rows: any[]): any[] {
    const map: Record<string, any> = {};
    for (const r of rows) map[r.kode_satker + "|" + r.nama_satker] = { k: r.kode_satker, n: r.nama_satker };
    return Object.values(map).sort((a, b) => String(a.n).localeCompare(String(b.n)));
  }
}
