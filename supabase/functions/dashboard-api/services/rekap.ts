// ─── RekapService ─────────────────────────────────────────────
import { Api } from "../lib/api.ts";
import * as N from "../lib/normalizer.ts";
import { sumberTransaksiMatch, sumberTransaksiGroupLabel } from "../lib/sumber_transaksi.ts";
import { PeriodeService } from "./periode.ts";
import { EfisiensiRowsService } from "./efisiensi_rows.ts";
import { SandinganService } from "./sandingan.ts";

const METODE_NON_TENDER = ["Pengadaan Langsung", "Penunjukan Langsung", "Seleksi", "Dikecualikan"];

export class RekapService {
  private efisiensi: EfisiensiRowsService;
  constructor(private sql: any, private periodes: PeriodeService, private sandingan: SandinganService) {
    this.efisiensi = new EfisiensiRowsService(sql, periodes);
  }

  async laporanRekap(p: Record<string, any>) {
    const periode = p.periode ?? null;
    const tahun = p.tahun ?? null;
    const rows = (await this.sandingan.buildRows(periode, tahun)).rows;
    const sum = (set: any[], f: string) => set.reduce((s: number, r: any) => s + Number(r[f]), 0);
    const desc = (key: string) => (a: any, b: any) => b[key] - a[key];

    // Tahap mentah
    const tahap: Record<string, string> = {};
    for (const pr of await this.efisiensi.resolvePeriodes(periode, tahun)) {
      const rr = await this.sql`SELECT kode_paket, status_paket_asli FROM realisasi_records WHERE periode = ${pr} ORDER BY id`;
      for (const r of rr) { if (String(r.kode_paket ?? "").trim() !== "") tahap[String(r.kode_paket).trim()] = r.status_paket_asli ?? ""; }
    }

    // a) Cara Pengadaan
    const cara: Record<string, any> = {};
    for (const r of rows) {
      const k = N.cara(r.cara_pengadaan) || "Tidak Diketahui";
      cara[k] ??= { cara_pengadaan: k, jumlah_paket: 0, nilai: 0 };
      cara[k].jumlah_paket++; cara[k].nilai += Number(r.pagu);
    }
    const rekapCara = Object.values(cara).sort(desc("nilai"));

    // b) Jenis Pengadaan
    const jen: Record<string, any> = {};
    for (const r of rows) {
      const k = (r.jenis_pengadaan_rup ?? null) || "Tidak Terklasifikasi";
      jen[k] ??= { jenis_pengadaan: k, jumlah_paket: 0, nilai: 0, sudah_berproses: 0, belum_berproses: 0, jumlah_manual: 0, nilai_manual: 0 };
      jen[k].jumlah_paket++; jen[k].nilai += Number(r.pagu);
      r.ada_realisasi ? jen[k].sudah_berproses++ : jen[k].belum_berproses++;
      if (r.is_manual_rup) { jen[k].jumlah_manual++; jen[k].nilai_manual += Number(r.pagu); }
    }
    const rekapJenis = Object.values(jen).map(r => ({
      ...r, progress: r.jumlah_paket > 0 ? Math.round(r.sudah_berproses / r.jumlah_paket * 10000) / 100 : 0,
    })).sort(desc("jumlah_paket"));
    const manual = rows.filter((r: any) => r.is_manual_rup);

    // c) Metode Pemilihan (hanya Penyedia)
    const met: Record<string, any> = {};
    for (const r of rows) {
      if (N.cara(r.cara_pengadaan) !== "Penyedia") continue;
      const k = (r.metode_pengadaan_rup ?? null) || "Tidak Diketahui";
      met[k] ??= { metode_pengadaan: k, total: 0, belum: 0, on_process: 0, selesai: 0 };
      met[k].total++;
      if (!r.ada_realisasi) met[k].belum++;
      else if (r.status_realisasi === "Selesai") met[k].selesai++;
      else if (r.status_realisasi === "Sedang Berjalan") met[k].on_process++;
    }
    const rekapMetode = Object.values(met).sort(desc("total"));

    // c.1) Sumber Transaksi
    const tr: Record<string, any> = {};
    for (const r of rows) {
      const k = r.ada_realisasi
        ? ((r.sumber_transaksi ?? "") || "Tidak Diketahui")
        : (sumberTransaksiGroupLabel(r.metode_pengadaan_rup ?? null) || "Belum Ada Transaksi");
      tr[k] ??= { sumber_transaksi: k, total: 0, belum: 0, on_process: 0, selesai: 0, nilai_pagu: 0, nilai_kontrak: 0, tidak_match: 0 };
      tr[k].total++; tr[k].nilai_pagu += Number(r.pagu);
      if (r.is_unmatched) tr[k].tidak_match++;
      if (!r.ada_realisasi) tr[k].belum++;
      else {
        tr[k].nilai_kontrak += Number(r.nilai_kontrak);
        if (r.status_realisasi === "Selesai") tr[k].selesai++;
        else if (r.status_realisasi === "Sedang Berjalan") tr[k].on_process++;
      }
    }
    const rekapTransaksi = Object.values(tr).sort(desc("total"));

    // d) Paket berjalan non-tender
    const berjalan = rows
      .filter((r: any) => r.status_realisasi === "Sedang Berjalan" && METODE_NON_TENDER.includes(r.metode_pengadaan_rup))
      .map((r: any) => ({
        opd: r.nama_satker, nama_paket: r.nama_paket_rup, metode_pengadaan: r.metode_pengadaan_rup,
        proses_tahap: (tahap[String(r.kode_paket ?? "").trim()] ?? "") || "—",
      })).sort((a: any, b: any) => String(a.opd ?? "").toLowerCase().localeCompare(String(b.opd ?? "").toLowerCase()));

    // e) Tender selesai
    const tender = rows
      .filter((r: any) => sumberTransaksiMatch(r.sumber_transaksi ?? null, "Tender") && r.status_realisasi === "Selesai")
      .map((r: any) => ({
        opd: r.nama_satker, nama_paket: r.nama_paket_rup, pagu_rup: Number(r.pagu),
        realisasi: Number(r.nilai_kontrak), efisiensi: Number(r.pagu) - Number(r.nilai_kontrak),
        pemenang: (r.nama_penyedia ?? "") || "—",
      })).sort(desc("efisiensi"));

    return Api.ok({
      total_paket: rows.length, total_nilai: sum(rows, "pagu"),
      total_manual: manual.length, total_nilai_manual: sum(manual, "pagu"),
      rekap_cara: rekapCara, rekap_jenis: rekapJenis, rekap_metode: rekapMetode,
      rekap_transaksi: rekapTransaksi, paket_berjalan: berjalan, tender_selesai: tender,
    });
  }

  async recapJenisPengadaan(p: Record<string, any>) {
    const maxList = Math.max(1, Number(p.max_list ?? 200));
    const allRows = (await this.sandingan.buildRows(p.periode ?? null, p.tahun ?? null)).rows;

    const satkers = N.satkerList(p.kode_satker ?? null);
    const rows = allRows.filter((r: any) =>
      (satkers.length === 0 || satkers.includes(String(r.kode_satker)))
      && (!p.metode_pengadaan || r.metode_pengadaan_rup === p.metode_pengadaan)
      && (!p.sumber_dana || r.sumber_dana === p.sumber_dana));

    const grup: Record<string, Record<string, any[]>> = {};
    for (const r of rows) {
      const j = (r.jenis_pengadaan_rup ?? null) || "Tidak Terklasifikasi";
      const paket = {
        kode_rup: r.kode_rup, nama_paket: r.nama_paket_rup, nama_satker: r.nama_satker,
        kode_satker: r.kode_satker, metode_pengadaan: r.metode_pengadaan_rup, pagu: Number(r.pagu),
        status_realisasi: r.status_realisasi, nilai_kontrak: Number(r.nilai_kontrak),
      };
      grup[j] ??= {};
      (grup[j][r.ada_realisasi ? "sudah" : "belum"] ??= []).push(paket);
    }

    const jenis = Object.entries(grup).map(([nama, g]) => {
      const sudah = g.sudah ?? [], belum = g.belum ?? [];
      const total = sudah.length + belum.length;
      return {
        jenis_pengadaan: nama, total,
        sudah_berproses: sudah.length, belum_berproses: belum.length,
        persen_progress: total > 0 ? Math.round(sudah.length / total * 10000) / 100 : 0,
        pagu_sudah: sudah.reduce((s: number, r: any) => s + r.pagu, 0),
        pagu_belum: belum.reduce((s: number, r: any) => s + r.pagu, 0),
        paket_sudah: sudah.slice(0, maxList), paket_belum: belum.slice(0, maxList),
      };
    }).sort((a, b) => b.total - a.total);

    const sudahAll = rows.filter((r: any) => r.ada_realisasi).length;
    return Api.ok({
      jenis,
      total_keseluruhan: { total: rows.length, sudah_berproses: sudahAll, belum_berproses: rows.length - sudahAll },
    });
  }
}
