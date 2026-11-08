// ─── SandinganService ─────────────────────────────────────────
import { Api } from "../lib/api.ts";
import * as N from "../lib/normalizer.ts";
import { castRow } from "../lib/rows.ts";
import { sumberTransaksiMatch, sumberTransaksiRowMatches, sumberTransaksiGroupLabel } from "../lib/sumber_transaksi.ts";
import { PeriodeService } from "./periode.ts";
import { EfisiensiRowsService } from "./efisiensi_rows.ts";

const STATUS_ORDER: Record<string, number> = { Selesai: 0, "Sedang Berjalan": 1, Dibatalkan: 3 };

export class SandinganService {
  private efisiensi: EfisiensiRowsService;
  constructor(private sql: any, private periodes: PeriodeService) {
    this.efisiensi = new EfisiensiRowsService(sql, periodes);
  }

  async list(p: Record<string, any>) {
    const periode = p.periode ?? null;
    const tahun = p.tahun ?? null;
    const page = Math.max(1, Number(p.page ?? 1));
    const perPage = Math.max(1, Math.min(500, Number(p.per_page ?? 50)));

    const base = await this.buildRows(periode, tahun);
    let rows = base.rows;

    const satkers = N.satkerList(p.kode_satker ?? null);
    if (satkers.length > 0) rows = rows.filter((r: any) => satkers.includes(String(r.kode_satker)));
    for (const [param, field] of [["metode_pengadaan", "metode_pengadaan_rup"], ["jenis_pengadaan", "jenis_pengadaan_rup"], ["sumber_dana", "sumber_dana"]] as const) {
      if (p[param]) rows = rows.filter((r: any) => r[field] === p[param]);
    }
    if (p.sumber_transaksi) rows = rows.filter((r: any) => sumberTransaksiRowMatches(r, p.sumber_transaksi));

    // Notif before status/search filter
    const notif = await this.efisiensi.notifStatusSelesai(periode, rows, {
      kode_satker: p.kode_satker ?? null, sumber_transaksi: p.sumber_transaksi ?? null,
    });

    if (p.status_paket) {
      rows = rows.filter((r: any) => p.status_paket === "Belum Berproses" ? !r.ada_realisasi : r.status_realisasi === p.status_paket);
    }
    if (p.search) {
      const terms = N.keywords(p.search);
      rows = rows.filter((r: any) => N.containsAny(terms, r.nama_paket_rup, r.kode_rup, r.nama_satker, r.nama_penyedia, r.nama_paket_realisasi));
    }

    const totalGabungan = rows.filter((r: any) => r.is_realisasi_gabungan).length;
    if ([true, "true", "1", 1].includes(p.hanya_gabungan ?? false)) {
      rows = rows.filter((r: any) => r.is_realisasi_gabungan);
    }

    this.sortRows(rows, p.sort_by ?? null, (p.sort_dir ?? "desc") === "asc" ? 1 : -1);
    const summary = this.summarize(rows, totalGabungan);
    rows = this.collapseGroups(rows);

    const total = rows.length;
    return Api.ok({
      total, page, per_page: perPage, total_pages: Math.max(1, Math.ceil(total / perPage)),
      summary, notif_status: notif,
      items: rows.slice((page - 1) * perPage, page * perPage),
      enums: { sumber: base.enumSumber, satker: base.enumSatker, sumber_transaksi: base.enumSumberTransaksi },
    });
  }

  async buildRows(periode?: string | null, tahun?: string | null): Promise<any> {
    const efi = await this.efisiensi.build(periode, tahun);

    let periodes: string[];
    if (periode) { periodes = [periode]; }
    else if (tahun) { periodes = await this.efisiensi.resolvePeriodes(null, String(tahun)); }
    else { periodes = (await this.periodes.availablePeriodes()).slice(0, 1); }
    periodes.sort();

    const rup: Record<string, any> = {};
    for (const pr of periodes) {
      const rows = await this.sql`SELECT id, kode_rup, kode_satker, nama_satker, nama_paket,
        metode_pengadaan, jenis_pengadaan, cara_pengadaan, sumber_dana, pagu
        FROM rup_records WHERE periode = ${pr} ORDER BY id`;
      for (const o of rows) {
        const r = castRow({ ...o });
        const kr = String(r.kode_rup ?? "").trim();
        if (kr !== "") rup[kr] = { ...r, _periode: pr };
      }
    }

    const manualPaguRows = await this.sql`SELECT kode_paket FROM manual_pagu`;
    const manualPaguSet = new Set(manualPaguRows.map((r: any) => String(r.kode_paket).trim()));
    const overrideRows = await this.sql`SELECT kode_rup, override_type, keterangan, kode_paket_manual, nama_paket_manual, nama_penyedia_manual, nilai_kontrak_manual, status_manual FROM status_overrides`;
    const overrides: Record<string, any> = {};
    for (const o of overrideRows) overrides[o.kode_rup] = { ...o };
    const splitRows = await this.sql`SELECT kode_paket, pagu, sumber_pagu FROM kontrak_splits`;
    const splits: Record<string, any> = {};
    for (const o of splitRows) splits[o.kode_paket] = { ...o };

    return this.compose(efi.rows, rup, efi.enums.sumber_transaksi, manualPaguSet, overrides, splits);
  }

  compose(efiRows: any[], rup: Record<string, any>, enumSumberTransaksi: string[], manualPaguSet: Set<string>, overrides: Record<string, any>, splits: Record<string, any>): any {
    const claimsByRup: Record<string, any[]> = {};
    for (const r of efiRows) {
      const parts = N.splitKodeRup(r.kode_rup ?? null);
      for (let idx = 0; idx < parts.length; idx++) {
        (claimsByRup[parts[idx]] ??= []).push({ ...r, _isPrimaryRup: idx === 0, _rupGroupSize: parts.length });
      }
    }

    const enumSumber = [...new Set(Object.values(rup).map((r: any) => r.sumber_dana).filter(Boolean))].sort();
    const satkerMap: Record<string, any> = {};
    for (const r of Object.values(rup)) satkerMap[r.kode_satker + "|" + r.nama_satker] = { k: r.kode_satker, n: r.nama_satker };
    const enumSatker = Object.values(satkerMap).sort((a: any, b: any) => cmp(a.n, b.n));

    const rows: any[] = [];
    for (const [kr, rp] of Object.entries(rup)) {
      let match = this.mergeClaims(claimsByRup[kr] ?? [], rp);
      let extra: any[] = [];
      if (match && match.realisasi_list?.length > 0) {
        [match, extra] = this.applySplits(match, rp, kr, splits);
      }
      const ov = !match ? (overrides[kr] ?? null) : null;
      let row = this.makeRow(kr, rp, match, manualPaguSet);
      if (ov) row = this.applyOverride(row, ov);
      rows.push(row);
      rows.push(...extra);
    }

    // Orphan
    for (const r of efiRows) {
      if (!r.is_unmatched) continue;
      rows.push({
        kode_rup: "UNMATCHED-" + r.kode_paket, kode_satker: r.kode_satker, nama_satker: r.nama_satker,
        nama_paket_rup: null, metode_pengadaan_rup: null,
        jenis_pengadaan_rup: N.jenis(N.str(r.jenis_pengadaan ?? "")),
        cara_pengadaan: null, sumber_dana: null, pagu: Number(r.pagu),
        ada_realisasi: true, kode_paket: r.kode_paket, nama_paket_realisasi: r.nama_paket_realisasi,
        metode_pengadaan: r.metode_pengadaan, jenis_pengadaan: r.jenis_pengadaan,
        nama_penyedia: r.nama_penyedia, sumber_transaksi: r.sumber_transaksi,
        nilai_kontrak: Number(r.nilai_kontrak), status_realisasi: (r.status_realisasi ?? "") || "Sedang Berjalan",
        status_dipertahankan: r.status_dipertahankan ?? null,
        is_gabungan_kode_rup: false, is_realisasi_gabungan: false, is_manual_rup: false,
        is_manual_pagu: !!r.is_manual_pagu, is_manual_status: false,
        override_type: null, keterangan_override: null, is_unmatched: true,
        excluded_dari_efisiensi: !!r.excluded_dari_efisiensi,
        realisasi_list: null, jumlah_transaksi: 1,
      });
    }

    return { rows, enumSumber, enumSatker, enumSumberTransaksi };
  }

  private mergeClaims(claims: any[], rup: any): any {
    if (claims.length <= 1) return claims[0] ?? null;
    const st = claims.map(c => c.status_realisasi);
    const list: any[] = [];
    for (const c of claims) {
      if (c.realisasi_list?.length > 0) list.push(...c.realisasi_list);
      else list.push({ kode_paket: c.kode_paket, nama_penyedia: c.nama_penyedia, nilai_kontrak: c.nilai_kontrak, status_realisasi: c.status_realisasi, periode: c.periode ?? null, kode_satker: c.kode_satker, nama_satker: c.nama_satker });
    }
    const c0 = claims[0];
    return {
      kode_paket: claims.map(c => c.kode_paket).join(";"),
      nama_paket_realisasi: c0.nama_paket_realisasi, metode_pengadaan: c0.metode_pengadaan,
      jenis_pengadaan: c0.jenis_pengadaan, sumber_transaksi: c0.sumber_transaksi,
      nama_penyedia: [...new Set(claims.map(c => c.nama_penyedia).filter(Boolean))].join(", "),
      pagu: Number(rup.pagu),
      nilai_kontrak: claims.reduce((s, c) => s + (c._isPrimaryRup ? Number(c.nilai_kontrak) : 0), 0),
      status_realisasi: st.every(s => s === "Selesai") ? "Selesai" : st.every(s => s === "Sedang Berjalan") ? "Sedang Berjalan" : "Campuran",
      excluded_dari_efisiensi: claims.every(c => c.excluded_dari_efisiensi),
      is_manual_pagu: claims.some(c => c.is_manual_pagu),
      realisasi_list: list, periode: c0.periode ?? null,
      status_dipertahankan: claims.map(c => c.status_dipertahankan).filter(Boolean)[0] ?? null,
      _isPrimaryRup: true, _rupGroupSize: Math.max(...claims.map(c => c._rupGroupSize)),
    };
  }

  private applySplits(match: any, rup: any, kr: string, splits: Record<string, any>): [any, any[]] {
    const split: any[] = [], normal: any[] = [];
    for (const x of match.realisasi_list) {
      splits[String(x.kode_paket ?? "").trim()] ? split.push(x) : normal.push(x);
    }
    if (split.length === 0) return [match, []];

    const extra = split.map(x => {
      const sp = splits[String(x.kode_paket).trim()];
      const pagu = Number(sp.pagu);
      return {
        kode_rup: kr, periode: (x.periode ?? null) || (match.periode ?? null),
        kode_satker: (x.kode_satker ?? null) || rup.kode_satker, nama_satker: (x.nama_satker ?? null) || rup.nama_satker,
        nama_paket_rup: rup.nama_paket, metode_pengadaan_rup: rup.metode_pengadaan,
        jenis_pengadaan_rup: N.jenisRupLabel(rup.jenis_pengadaan), cara_pengadaan: rup.cara_pengadaan,
        sumber_dana: rup.sumber_dana, pagu, pagu_efisiensi: pagu,
        ada_realisasi: true, kode_paket: x.kode_paket,
        nama_paket_realisasi: (x.nama_paket_realisasi ?? null) || (match.nama_paket_realisasi ?? ""),
        metode_pengadaan: match.metode_pengadaan, jenis_pengadaan: match.jenis_pengadaan,
        nama_penyedia: x.nama_penyedia ?? "", sumber_transaksi: match.sumber_transaksi,
        nilai_kontrak: Number(x.nilai_kontrak), status_realisasi: (x.status_realisasi ?? "") || "Sedang Berjalan",
        is_primary_gabungan: false, is_gabungan_kode_rup: false, is_realisasi_gabungan: false,
        is_manual_rup: false, is_manual_pagu: false, is_split_kontrak: true,
        pagu_split_sumber: (sp.sumber_pagu ?? null) || (pagu > 0 ? "LPSE" : "Kosong"),
        is_manual_status: false, override_type: null, keterangan_override: null, is_unmatched: false,
        realisasi_list: null, excluded_dari_efisiensi: false, jumlah_transaksi: 1,
      };
    });

    if (normal.length === 0) return [null, extra];

    const keep = ["metode_pengadaan", "jenis_pengadaan", "sumber_transaksi", "excluded_dari_efisiensi", "is_manual_pagu"];
    const nw: any = {};
    for (const k of keep) nw[k] = match[k];
    nw.pagu = Number(rup.pagu); nw._isPrimaryRup = true; nw._rupGroupSize = 1;

    if (normal.length === 1) {
      const o = normal[0];
      Object.assign(nw, {
        kode_paket: o.kode_paket, nama_paket_realisasi: (o.nama_paket_realisasi ?? null) || match.nama_paket_realisasi,
        nama_penyedia: o.nama_penyedia, nilai_kontrak: Number(o.nilai_kontrak),
        status_realisasi: o.status_realisasi, realisasi_list: null,
        periode: (o.periode ?? null) || (match.periode ?? null),
      });
    } else {
      const st = normal.map(x => x.status_realisasi);
      Object.assign(nw, {
        kode_paket: normal.map(x => x.kode_paket).join(";"),
        nama_paket_realisasi: match.nama_paket_realisasi,
        nama_penyedia: [...new Set(normal.map(x => x.nama_penyedia).filter(Boolean))].join(", "),
        nilai_kontrak: normal.reduce((s, x) => s + Number(x.nilai_kontrak), 0),
        status_realisasi: st.every(s => s === "Selesai") ? "Selesai" : st.every(s => s === "Sedang Berjalan") ? "Sedang Berjalan" : "Campuran",
        realisasi_list: normal, periode: match.periode ?? null,
      });
    }
    return [nw, extra];
  }

  private makeRow(kr: string, rup: any, m: any, manualPaguSet: Set<string>): any {
    const primary = m && !!m._isPrimaryRup;
    const size = m?._rupGroupSize ?? 1;
    return {
      kode_rup: kr, periode: m?.periode ?? null,
      kode_satker: rup.kode_satker, nama_satker: rup.nama_satker,
      nama_paket_rup: rup.nama_paket, metode_pengadaan_rup: rup.metode_pengadaan,
      jenis_pengadaan_rup: N.jenisRupLabel(rup.jenis_pengadaan),
      cara_pengadaan: rup.cara_pengadaan, sumber_dana: rup.sumber_dana,
      pagu: Number(rup.pagu), ada_realisasi: m != null,
      kode_paket: m ? (m.kode_paket || "") : null,
      nama_paket_realisasi: m ? ((m.nama_paket_realisasi ?? "") || "") : null,
      metode_pengadaan: m ? ((m.metode_pengadaan ?? "") || "") : null,
      jenis_pengadaan: m ? ((m.jenis_pengadaan ?? "") || "") : null,
      nama_penyedia: m ? ((m.nama_penyedia ?? "") || "") : null,
      sumber_transaksi: m ? ((m.sumber_transaksi ?? "") || "") : null,
      nilai_kontrak: m ? (primary ? Number(m.nilai_kontrak) : 0) : 0,
      pagu_efisiensi: m ? Number(m.pagu ?? 0) : Number(rup.pagu),
      is_primary_gabungan: primary && size > 1,
      status_realisasi: m ? ((m.status_realisasi ?? "") || "Sedang Berjalan") : null,
      status_dipertahankan: m?.status_dipertahankan ?? null,
      is_gabungan_kode_rup: m != null && size > 1,
      is_realisasi_gabungan: m != null && (m.realisasi_list?.length ?? 0) > 1,
      is_manual_rup: false,
      is_manual_pagu: m && m.kode_paket ? manualPaguSet.has(String(m.kode_paket).trim()) : false,
      is_manual_status: false, override_type: null, keterangan_override: null, is_unmatched: false,
      realisasi_list: m?.realisasi_list ?? null,
      excluded_dari_efisiensi: m ? !!m.excluded_dari_efisiensi : false,
      jumlah_transaksi: !m ? 0 : (!primary ? 0 : (m.realisasi_list ? m.realisasi_list.length : 1)),
    };
  }

  private applyOverride(row: any, ov: any): any {
    row.is_manual_status = true;
    row.override_type = String(ov.override_type);
    row.keterangan_override = String(ov.keterangan ?? "");
    if (ov.override_type === "Dibatalkan") {
      row.status_realisasi = "Dibatalkan";
    } else if (ov.override_type === "Manual") {
      const kp = String(ov.kode_paket_manual ?? "");
      row.ada_realisasi = true;
      row.kode_paket = kp !== "" ? kp : row.kode_paket;
      row.nama_paket_realisasi = (ov.nama_paket_manual ?? "") !== "" ? ov.nama_paket_manual : row.nama_paket_realisasi;
      row.nama_penyedia = String(ov.nama_penyedia_manual ?? "");
      row.nilai_kontrak = Number(ov.nilai_kontrak_manual ?? 0);
      row.status_realisasi = (ov.status_manual ?? "") || "Selesai";
      row.sumber_transaksi = kp !== "" ? "Realisasi (Disandingkan Manual)" : "Manual";
      row.jumlah_transaksi = kp !== "" ? 1 : 0;
    }
    return row;
  }

  private sortRows(rows: any[], sortBy: string | null, dir: number): void {
    if (!sortBy) {
      rows.sort((a, b) => (statusRank(a.status_realisasi) - statusRank(b.status_realisasi)) || cmp(a.nama_satker, b.nama_satker));
      return;
    }
    const paguKnown = (r: any) => !r.is_unmatched || Number(r.pagu) > 0;
    const val = (r: any): any => {
      switch (sortBy) {
        case "satker": return String(r.nama_satker ?? "").toLowerCase();
        case "paket": return String((r.nama_paket_rup ?? null) || (r.nama_paket_realisasi ?? "")).toLowerCase();
        case "kode_rup": return String(r.kode_rup ?? "").toLowerCase();
        case "metode": return String((r.metode_pengadaan_rup ?? null) || (r.metode_pengadaan ?? "")).toLowerCase();
        case "jenis": return String((r.jenis_pengadaan_rup ?? null) || (r.jenis_pengadaan ?? "")).toLowerCase();
        case "pagu": return Number(r.pagu);
        case "status": return statusRank(r.status_realisasi);
        case "penyedia": return String(r.nama_penyedia ?? "").toLowerCase();
        case "kontrak": return Number(r.nilai_kontrak);
        case "efisiensi": return (r.ada_realisasi && r.status_realisasi === "Selesai" && paguKnown(r)) ? Number(r.pagu) - Number(r.nilai_kontrak) : null;
        default: return 0;
      }
    };
    rows.sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va === null && vb === null) return cmp(a.nama_satker, b.nama_satker);
      if (va === null) return 1;
      if (vb === null) return -1;
      if (typeof va === "string") return va.localeCompare(vb as string) * dir;
      return ((va as number) - (vb as number)) * dir || cmp(a.nama_satker, b.nama_satker);
    });
  }

  private summarize(rows: any[], totalGabungan: number): any {
    const sum = (set: any[], f: string) => set.reduce((s, r) => s + Number(r[f]), 0);
    const pct = (pagu: number, kontrak: number) => pagu > 0 ? Math.round((pagu - kontrak) / pagu * 10000) / 100 : 0;

    const matched = rows.filter(r => r.ada_realisasi);
    const selesai = rows.filter(r => r.status_realisasi === "Selesai");
    const berjalan = rows.filter(r => ["Sedang Berjalan", "Campuran"].includes(r.status_realisasi));
    const known = (r: any) => !r.is_unmatched || Number(r.pagu) > 0;
    const selesaiEfi = selesai.filter(known), berjalanEfi = berjalan.filter(known);

    const paguSel = sum(selesaiEfi, "pagu"), kontrakSel = sum(selesaiEfi, "nilai_kontrak");
    const paguJln = sum(berjalanEfi, "pagu"), kontrakJln = sum(berjalanEfi, "nilai_kontrak");

    const orphan = rows.filter(r => r.is_unmatched);
    const splitByRup: Record<string, any[]> = {};
    for (const r of rows) if (r.is_split_kontrak) (splitByRup[r.kode_rup] ??= []).push(r);
    const paketRup = rows.filter(r => !r.is_unmatched && !r.is_split_kontrak);

    const cnt: Record<string, number> = { Selesai: 0, "Sedang Berjalan": 0, Dibatalkan: 0, Belum: 0 };
    for (const r of paketRup) {
      let s: string;
      if (r.ada_realisasi) { s = r.status_realisasi === "Campuran" ? "Sedang Berjalan" : r.status_realisasi; }
      else if (splitByRup[r.kode_rup]) {
        const ss = splitByRup[r.kode_rup].map((x: any) => x.status_realisasi);
        s = ss.every((x: string) => x === "Selesai") ? "Selesai" : "Sedang Berjalan";
      } else { s = r.status_realisasi === "Dibatalkan" ? "Dibatalkan" : "Belum"; }
      cnt[s] = (cnt[s] ?? 0) + 1;
    }
    const orphanSelesai = orphan.filter(r => r.status_realisasi === "Selesai").length;
    const orphanJalan = orphan.length - orphanSelesai;

    return {
      total_gabungan: totalGabungan,
      total_paket_rup: paketRup.length, total_paket_semua: paketRup.length + orphan.length,
      selesai: cnt.Selesai + orphanSelesai, sedang_berjalan: cnt["Sedang Berjalan"] + orphanJalan,
      belum_berproses: cnt.Belum, dibatalkan: cnt.Dibatalkan,
      selesai_belum_match: orphanSelesai, berjalan_belum_match: orphanJalan, jumlah_unmatched: orphan.length,
      total_pagu: sum(paketRup, "pagu"),
      total_kontrak: sum(matched.filter(r => !r.is_unmatched), "nilai_kontrak"),
      pagu_selesai: paguSel, kontrak_selesai: kontrakSel,
      total_efisiensi_selesai: paguSel - kontrakSel, persen_efisiensi_selesai: pct(paguSel, kontrakSel),
      pagu_berjalan: paguJln, kontrak_berjalan: kontrakJln,
      total_efisiensi_berjalan: paguJln - kontrakJln, persen_efisiensi_berjalan: pct(paguJln, kontrakJln),
      transaksi_selesai: Math.round(sum(selesai, "jumlah_transaksi")),
      transaksi_berjalan: Math.round(sum(berjalan, "jumlah_transaksi")),
      transaksi_total: Math.round(sum(matched, "jumlah_transaksi")),
    };
  }

  private collapseGroups(rows: any[]): any[] {
    const byPaket: Record<string, number[]> = {};
    rows.forEach((r, i) => { if (r.is_gabungan_kode_rup && r.kode_paket) (byPaket[r.kode_paket] ??= []).push(i); });
    for (const idxs of Object.values(byPaket)) {
      let primary: number | null = null;
      for (const i of idxs) if (rows[i].is_primary_gabungan) { primary = i; break; }
      if (primary === null) continue;
      rows[primary].group_members = idxs.filter(i => i !== primary).map(i => ({
        kode_rup: rows[i].kode_rup, nama_paket_rup: rows[i].nama_paket_rup,
        metode_pengadaan_rup: rows[i].metode_pengadaan_rup, jenis_pengadaan_rup: rows[i].jenis_pengadaan_rup,
        pagu: rows[i].pagu, is_manual_pagu: rows[i].is_manual_pagu,
      }));
    }
    return rows.filter(r => !(r.is_gabungan_kode_rup && !r.is_primary_gabungan));
  }
}

function cmp(a: any, b: any): number {
  return String(a ?? "").toLowerCase().localeCompare(String(b ?? "").toLowerCase());
}
function statusRank(status: any): number {
  return STATUS_ORDER[status] ?? 2;
}
