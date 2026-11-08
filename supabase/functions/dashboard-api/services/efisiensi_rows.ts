// ─── EfisiensiRowsService ─────────────────────────────────────
import * as N from "../lib/normalizer.ts";
import { prevPeriode } from "../lib/periode_helper.ts";
import { PeriodeService } from "./periode.ts";

export class EfisiensiRowsService {
  constructor(private sql: any, private periodes: PeriodeService) {}

  normalizeStatus(raw: any): string {
    const s = N.str(raw).trim();
    return s === "Belum Berproses" ? "Sedang Berjalan" : s;
  }

  async selesaiSebelumnya(periode: string | null): Promise<Record<string, any>> {
    if (!periode) return {};
    const tahun = periode.split("-")[0];
    const rows = await this.sql`
      SELECT periode, kode_paket, nama_paket, nama_satker, kode_satker, nilai_kontrak, sumber_transaksi, status_paket_asli
      FROM realisasi_records
      WHERE periode LIKE ${tahun + '-%'} AND periode < ${periode}
        AND status_paket = 'Selesai'
        AND COALESCE(TRIM(kode_paket), '') <> ''
      ORDER BY periode, id`;
    const map: Record<string, any> = {};
    for (const r of rows) {
      map[String(r.kode_paket).trim()] = {
        periode: r.periode, nama_paket: r.nama_paket ?? "", nama_satker: r.nama_satker ?? "",
        kode_satker: r.kode_satker, nilai_kontrak: Number(r.nilai_kontrak),
        sumber_transaksi: r.sumber_transaksi ?? "", status_asli: r.status_paket_asli ?? "",
      };
    }
    return map;
  }

  async resolvePeriodes(periode?: string | null, tahun?: string | null): Promise<string[]> {
    let list: string[];
    if (periode) {
      list = [periode];
    } else if (tahun) {
      list = await this.periodes.availablePeriodes(tahun);
    } else {
      list = await this.periodes.availablePeriodes();
    }
    list.sort();
    return list;
  }

  async build(periode?: string | null, tahun?: string | null): Promise<{ rows: any[]; enums: any }> {
    const periodes = await this.resolvePeriodes(periode, tahun);
    const excludeRows = await this.sql`SELECT metode FROM efisiensi_exclude_metode`;
    const excludeSet = new Set(excludeRows.map((r: any) => r.metode));
    const prev = periode ? await this.selesaiSebelumnya(periode) : {};
    const manualPaguRows = await this.sql`SELECT kode_paket, pagu FROM manual_pagu`;
    const manualPagu: Record<string, number> = {};
    for (const r of manualPaguRows) manualPagu[r.kode_paket] = Number(r.pagu);

    const statusFinal = (kp: string, raw: any): string => {
      const st = this.normalizeStatus(raw);
      return (st !== "Selesai" && st !== "Dibatalkan" && prev[kp]) ? "Selesai" : st;
    };
    const flagDipertahankan = (kp: string, real: any): any => {
      const st = this.normalizeStatus(real.status_paket ?? "");
      if (!prev[kp] || st === "Selesai" || st === "Dibatalkan") return null;
      return { dari_periode: prev[kp].periode, status_sekarang: (real.status_paket_asli ?? "") || (real.status_paket ?? "") };
    };

    const enumSumberTr: Record<string, boolean> = {};
    const enumMetode: Record<string, boolean> = {};
    const enumStatus: Record<string, boolean> = {};
    const enumSatker: Record<string, { k: string; n: string }> = {};
    const seenGlobal: Record<string, boolean> = {};
    const rows: any[] = [];
    const matchedRaw: any[] = [];

    for (const pr of periodes) {
      const matching = await this.sql`SELECT id, kode_rup, kode_paket, kode_satker, nama_satker,
        nama_paket_rup, nama_paket_realisasi, pagu_rup, nilai_kontrak, status_matching
        FROM matching_results WHERE periode = ${pr} ORDER BY id`;
      if (matching.length === 0) continue;

      const realRows = await this.sql`SELECT id, kode_paket, kode_satker, nama_satker, nama_paket,
        nama_penyedia, metode_pengadaan, jenis_pengadaan, sumber_transaksi, status_paket, status_paket_asli, nilai_kontrak
        FROM realisasi_records WHERE periode = ${pr} ORDER BY id`;
      const realMap: Record<string, any> = {};
      for (const o of realRows) {
        const r = { ...o };
        if (r.kode_paket) realMap[String(r.kode_paket).trim()] = r;
        if (r.sumber_transaksi) enumSumberTr[r.sumber_transaksi] = true;
        if (r.metode_pengadaan) enumMetode[r.metode_pengadaan] = true;
        if (r.status_paket) enumStatus[r.status_paket] = true;
      }

      for (const o of matching) {
        const r = { ...o };
        if (!r.kode_paket || !["MATCHED", "UNMATCHED"].includes(r.status_matching)) continue;
        const kp = String(r.kode_paket).trim();
        enumSatker[r.kode_satker] ??= { k: r.kode_satker, n: r.nama_satker };

        if (seenGlobal[kp]) continue;
        seenGlobal[kp] = true;
        const real = realMap[kp] ?? {};
        const metode = String(real.metode_pengadaan ?? "");

        if (r.status_matching === "MATCHED") {
          matchedRaw.push({
            periode: pr, kode_rup: r.kode_rup, kode_paket: kp,
            kode_satker: r.kode_satker, nama_satker: r.nama_satker,
            nama_paket_rup: r.nama_paket_rup, nama_paket_realisasi: r.nama_paket_realisasi,
            nama_penyedia: real.nama_penyedia ?? "", metode_pengadaan: metode,
            jenis_pengadaan: (real.jenis_pengadaan ?? "") || "",
            sumber_transaksi: real.sumber_transaksi ?? "",
            pagu_rup: Number(r.pagu_rup), nilai_kontrak: Number(r.nilai_kontrak),
            status_realisasi: statusFinal(kp, real.status_paket ?? null),
            status_dipertahankan: flagDipertahankan(kp, real),
            excluded_dari_efisiensi: excludeSet.has(metode),
            is_manual_pagu: false,
          });
          continue;
        }

        // UNMATCHED
        const hasManual = kp in manualPagu;
        rows.push({
          kode_rup: r.kode_rup || null, kode_paket: kp, periode: pr,
          kode_satker: r.kode_satker, nama_satker: r.nama_satker,
          nama_paket_rup: null,
          nama_paket_realisasi: (r.nama_paket_realisasi || (real.nama_paket ?? "")) || "",
          nama_penyedia: real.nama_penyedia ?? "", metode_pengadaan: metode,
          jenis_pengadaan: real.jenis_pengadaan ?? "", sumber_transaksi: real.sumber_transaksi ?? "",
          pagu: hasManual ? manualPagu[kp] : 0,
          nilai_kontrak: Number(r.nilai_kontrak),
          status_realisasi: statusFinal(kp, real.status_paket ?? null),
          status_dipertahankan: flagDipertahankan(kp, real),
          excluded_dari_efisiensi: hasManual ? excludeSet.has(metode) : true,
          is_unmatched: true, is_manual_pagu: hasManual,
          realisasi_list: null,
        });
      }
    }

    // Group MATCHED by kode_rup
    const groups: Record<string, any[]> = {};
    for (const r of matchedRaw) {
      const key = r.kode_rup || `__NOKEY__${r.kode_paket}`;
      (groups[key] ??= []).push(r);
    }
    for (const group of Object.values(groups)) {
      const g0 = group[0];
      if (group.length === 1) {
        rows.push({
          kode_rup: g0.kode_rup, kode_paket: g0.kode_paket, kode_satker: g0.kode_satker,
          nama_satker: g0.nama_satker, nama_paket_rup: g0.nama_paket_rup,
          nama_paket_realisasi: g0.nama_paket_realisasi, nama_penyedia: g0.nama_penyedia,
          metode_pengadaan: g0.metode_pengadaan, jenis_pengadaan: g0.jenis_pengadaan,
          sumber_transaksi: g0.sumber_transaksi, pagu: g0.pagu_rup, nilai_kontrak: g0.nilai_kontrak,
          status_realisasi: g0.status_realisasi, excluded_dari_efisiensi: g0.excluded_dari_efisiensi,
          is_unmatched: false, realisasi_list: null, is_manual_pagu: g0.is_manual_pagu,
          periode: g0.periode, status_dipertahankan: g0.status_dipertahankan,
        });
        continue;
      }

      const statuses = group.map(g => g.status_realisasi);
      const allSelesai = statuses.every(s => s === "Selesai");
      const allBerjalan = statuses.every(s => s === "Sedang Berjalan");

      rows.push({
        kode_rup: g0.kode_rup,
        kode_paket: group.map(g => g.kode_paket).join(";"),
        kode_satker: g0.kode_satker, nama_satker: g0.nama_satker,
        nama_paket_rup: g0.nama_paket_rup,
        nama_paket_realisasi: [...new Set(group.map(g => g.nama_paket_realisasi).filter(Boolean))].join(" | "),
        nama_penyedia: [...new Set(group.map(g => g.nama_penyedia).filter(Boolean))].join(", "),
        metode_pengadaan: g0.metode_pengadaan, jenis_pengadaan: g0.jenis_pengadaan,
        sumber_transaksi: g0.sumber_transaksi,
        pagu: g0.pagu_rup,
        nilai_kontrak: group.reduce((s, g) => s + g.nilai_kontrak, 0),
        status_realisasi: allSelesai ? "Selesai" : (allBerjalan ? "Sedang Berjalan" : "Campuran"),
        excluded_dari_efisiensi: group.some(g => g.excluded_dari_efisiensi),
        is_unmatched: false,
        is_manual_pagu: group.some(g => g.is_manual_pagu),
        periode: g0.periode,
        status_dipertahankan: group.map(g => g.status_dipertahankan).filter(Boolean)[0] ?? null,
        realisasi_list: group.map(r => ({
          kode_paket: r.kode_paket, nama_penyedia: r.nama_penyedia,
          nilai_kontrak: r.nilai_kontrak, status_realisasi: r.status_realisasi,
          nama_paket_realisasi: r.nama_paket_realisasi, periode: r.periode,
          kode_satker: r.kode_satker, nama_satker: r.nama_satker,
        })),
      });
    }

    const sortedSumberTr = Object.keys(enumSumberTr).sort();
    const sortedMetode = Object.keys(enumMetode).sort();
    const sortedStatus = Object.keys(enumStatus).sort();
    const satkerArr = Object.values(enumSatker).sort((a, b) => a.n.toLowerCase().localeCompare(b.n.toLowerCase()));

    return {
      rows,
      enums: {
        sumber_transaksi: sortedSumberTr, metode_pengadaan: sortedMetode,
        status_paket: sortedStatus, satker: satkerArr,
      },
    };
  }

  async notifStatusSelesai(periode: string | null, rows: any[], f: any): Promise<any> {
    const out: any = { periode_lalu: null, dipertahankan: [], hilang: [] };
    if (!periode) return out;

    const seen: Record<string, boolean> = {};
    for (const r of rows) {
      if (!r.status_dipertahankan) continue;
      const key = r.kode_paket ?? r.kode_rup ?? "";
      if (seen[key]) continue;
      seen[key] = true;
      out.dipertahankan.push({
        kode_rup: r.kode_rup, kode_paket: r.kode_paket, nama_satker: r.nama_satker,
        nama_paket: r.nama_paket_rup ?? r.nama_paket_realisasi ?? "",
        nilai_kontrak: r.nilai_kontrak, dari_periode: r.status_dipertahankan.dari_periode,
        status_sekarang: r.status_dipertahankan.status_sekarang,
      });
    }

    const kpNowRows = await this.sql`SELECT kode_paket FROM realisasi_records WHERE periode = ${periode}`;
    const kpNow = new Set(kpNowRows.map((r: any) => String(r.kode_paket).trim()));
    const satkers = N.satkerList(f.kode_satker ?? null);
    const prev = await this.selesaiSebelumnya(periode);
    const { sumberTransaksiMatch } = await import("../lib/sumber_transaksi.ts");
    for (const [kp, info] of Object.entries(prev) as [string, any][]) {
      if (kpNow.has(kp)) continue;
      if (satkers.length > 0 && !satkers.includes(String(info.kode_satker))) continue;
      if (f.sumber_transaksi && !sumberTransaksiMatch(info.sumber_transaksi, f.sumber_transaksi)) continue;
      out.hilang.push({
        kode_paket: kp, nama_satker: info.nama_satker, nama_paket: info.nama_paket,
        nilai_kontrak: info.nilai_kontrak, dari_periode: info.periode,
      });
    }
    out.periode_lalu = out.dipertahankan[0]?.dari_periode ?? out.hilang[0]?.dari_periode ?? prevPeriode(periode);

    return out;
  }
}
