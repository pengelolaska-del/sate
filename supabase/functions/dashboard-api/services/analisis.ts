// ─── AnalisisService ──────────────────────────────────────────
import { Api, ApiException } from "../lib/api.ts";
import * as N from "../lib/normalizer.ts";
import { castAll } from "../lib/rows.ts";
import { sumberTransaksiMatch } from "../lib/sumber_transaksi.ts";
import { PeriodeService } from "./periode.ts";
import { EfisiensiRowsService } from "./efisiensi_rows.ts";
import { SandinganService } from "./sandingan.ts";

export class AnalisisService {
  private efisiensi: EfisiensiRowsService;
  constructor(private sql: any, private periodes: PeriodeService, private sandingan: SandinganService) {
    this.efisiensi = new EfisiensiRowsService(sql, periodes);
  }

  async listEfisiensi(p: Record<string, any>) {
    const periode = p.periode ?? null;
    const tahun = p.tahun ?? null;
    const built = await this.efisiensi.build(periode, tahun);
    const all = built.rows;
    const rows = this.filterRows(all, p, true);

    const buckets: Record<string, Record<string, Record<string, any>>> = {};
    let paguF = 0, kontrakF = 0;

    const bump = (dim: string, which: string, key: string, r: any, ikut: boolean, belumMatch: boolean) => {
      buckets[dim] ??= {};
      buckets[dim][which] ??= {};
      buckets[dim][which][key] ??= { label: key, total_pagu: 0, total_kontrak: 0, jumlah: 0, jumlah_ikut_efisiensi: 0, jumlah_belum_match_rup: 0 };
      const b = buckets[dim][which][key];
      b.jumlah++;
      if (belumMatch) b.jumlah_belum_match_rup++;
      if (ikut) { b.total_pagu += Number(r.pagu); b.total_kontrak += Number(r.nilai_kontrak); b.jumlah_ikut_efisiensi++; }
    };

    for (const r of rows) {
      const ikut = !r.excluded_dari_efisiensi;
      const belum = !!r.is_unmatched && !r.is_manual_pagu;
      const keys: Record<string, string> = {
        transaksi: (r.sumber_transaksi ?? "") || "(Tidak Diketahui)",
        metode: (r.metode_pengadaan ?? "") || "(Tidak Diketahui)",
        jenis: (r.jenis_pengadaan ?? "") || "(Tidak Diketahui)",
      };
      const which = ["all"];
      if (r.status_realisasi === "Selesai") which.push("selesai");
      else if (r.status_realisasi === "Sedang Berjalan") which.push("berjalan");

      if (ikut) { paguF += Number(r.pagu); kontrakF += Number(r.nilai_kontrak); }
      for (const w of which) {
        for (const [d, k] of Object.entries(keys)) bump(d, w, k, r, ikut, belum);
        const sk = String(r.kode_satker);
        bump("satker", w, sk, r, ikut, belum);
        Object.assign(buckets.satker[w][sk], { kode_satker: r.kode_satker, nama_satker: r.nama_satker });
      }
    }

    const toArr = (map: Record<string, any> | undefined, satker = false) => {
      const out = Object.values(map ?? {}).map(r => {
        const o = { ...r };
        if (satker) delete o.label;
        const efi = o.total_pagu - o.total_kontrak;
        return { ...o, efisiensi: efi, persen_efisiensi: o.total_pagu > 0 ? Math.round(efi / o.total_pagu * 10000) / 100 : 0, ada_data_efisiensi: o.jumlah_ikut_efisiensi > 0 };
      });
      out.sort((a, b) => b.efisiensi - a.efisiensi);
      return out;
    };

    const periodesAgg = await this.efisiensi.resolvePeriodes(periode, tahun);
    const aggregate = castAll(await this.sql`SELECT * FROM dashboard_aggregates WHERE periode = ANY(${periodesAgg}) ORDER BY periode`);

    const selesaiEfi = all.filter((r: any) => r.status_realisasi === "Selesai" && !r.excluded_dari_efisiensi);

    const data: Record<string, any> = {
      aggregate,
      by_opd: toArr(buckets.satker?.all, true),
      by_opd_selesai: toArr(buckets.satker?.selesai, true),
      by_opd_berjalan: toArr(buckets.satker?.berjalan, true),
    };
    for (const [d, name] of [["transaksi", "sumber_transaksi"], ["metode", "metode"], ["jenis", "jenis"]] as const) {
      data[`by_${name}`] = toArr(buckets[d]?.all);
      data[`by_${name}_selesai`] = toArr(buckets[d]?.selesai);
      data[`by_${name}_berjalan`] = toArr(buckets[d]?.berjalan);
    }

    return Api.ok({
      ...data,
      total_pagu_filtered: paguF, total_kontrak_filtered: kontrakF, total_paket_filtered: rows.length,
      total_pagu_selesai_efisiensi: selesaiEfi.reduce((s: number, r: any) => s + Number(r.pagu), 0),
      total_kontrak_selesai_efisiensi: selesaiEfi.reduce((s: number, r: any) => s + Number(r.nilai_kontrak), 0),
      metode_excluded: await this.excludedList(),
      enums: built.enums,
    });
  }

  async listEfisiensiDetail(p: Record<string, any>) {
    const page = Math.max(1, Number(p.page ?? 1));
    const perPage = Math.max(1, Math.min(500, Number(p.per_page ?? 50)));
    const manualRows = await this.sql`SELECT kode_paket FROM manual_pagu`;
    const manual = new Set(manualRows.map((r: any) => String(r.kode_paket).trim()));
    const exclude = new Set(await this.excludedList());
    const satkers = N.satkerList(p.kode_satker ?? null);

    const dedup: Record<string, any> = {};
    for (const pr of await this.efisiensi.resolvePeriodes(p.periode ?? null, p.tahun ?? null)) {
      const realRows = await this.sql`SELECT * FROM realisasi_records WHERE periode = ${pr}`;
      const real: Record<string, any> = {};
      for (const o of realRows) if (o.kode_paket) real[String(o.kode_paket).trim()] = { ...o };
      const seen: Record<string, boolean> = {};
      const matchRows = await this.sql`SELECT * FROM matching_results WHERE periode = ${pr} AND status_matching = 'MATCHED' AND kode_paket IS NOT NULL ORDER BY id`;
      for (const o of matchRows) {
        const r = { ...o };
        const kp = String(r.kode_paket).trim();
        if (kp === "" || seen[kp]) continue;
        seen[kp] = true;
        const re = real[kp] ?? {};
        if (satkers.length > 0 && !satkers.includes(String(r.kode_satker))) continue;
        if (p.sumber_transaksi && !sumberTransaksiMatch(re.sumber_transaksi ?? null, p.sumber_transaksi)) continue;
        if (p.metode_pengadaan && (re.metode_pengadaan ?? "") !== p.metode_pengadaan) continue;
        if (p.jenis_pengadaan && ((re.jenis_pengadaan ?? "") || "") !== p.jenis_pengadaan) continue;
        if (p.status_paket && (re.status_paket ?? "") !== p.status_paket) continue;

        const pagu = Number(r.pagu_rup), kontrak = Number(r.nilai_kontrak);
        dedup[kp] = {
          periode: pr, nama_satker: r.nama_satker, kode_satker: r.kode_satker,
          nama_penyedia: re.nama_penyedia ?? "", jenis_pengadaan: (re.jenis_pengadaan ?? "") || "",
          metode_pengadaan: re.metode_pengadaan ?? "", sumber_transaksi: re.sumber_transaksi ?? "",
          status_paket: re.status_paket ?? "",
          nama_paket: (r.nama_paket_realisasi || (re.nama_paket ?? "")) || (r.nama_paket_rup ?? ""),
          kode_paket: kp, kode_rup: r.kode_rup,
          pagu_rup: pagu, nilai_kontrak: kontrak,
          efisiensi: pagu > 0 ? pagu - kontrak : null, pagu_diketahui: pagu > 0,
          is_manual_pagu: manual.has(kp),
          excluded_dari_efisiensi: exclude.has(re.metode_pengadaan ?? ""),
        };
      }
    }

    const items = Object.values(dedup);
    items.sort((a, b) => (b.efisiensi ?? -Infinity) - (a.efisiensi ?? -Infinity));
    const hitung = items.filter(r => !r.excluded_dari_efisiensi && r.pagu_diketahui);
    const pagu = hitung.reduce((s, r) => s + r.pagu_rup, 0);
    const kontrak = hitung.reduce((s, r) => s + r.nilai_kontrak, 0);
    const total = items.length;

    return Api.ok({
      total, total_pagu: pagu, total_kontrak: kontrak, total_efisiensi: pagu - kontrak,
      persen_efisiensi: pagu > 0 ? Math.round((pagu - kontrak) / pagu * 10000) / 100 : 0,
      page, per_page: perPage, total_pages: Math.max(1, Math.ceil(total / perPage)),
      items: items.slice((page - 1) * perPage, page * perPage),
    });
  }

  async charts(p: Record<string, any>) {
    const efiRows = this.filterRows((await this.efisiensi.build(p.periode ?? null, p.tahun ?? null)).rows, p, false);
    const selesai = efiRows.filter((r: any) => r.status_realisasi === "Selesai");

    // Top OPD efisiensi
    const efi: Record<string, any> = {};
    for (const r of selesai.filter((r: any) => !r.excluded_dari_efisiensi)) {
      const k = r.kode_satker || r.nama_satker;
      efi[k] ??= { kode_satker: r.kode_satker, nama_satker: r.nama_satker, total_pagu: 0, total_kontrak: 0 };
      efi[k].total_pagu += Number(r.pagu); efi[k].total_kontrak += Number(r.nilai_kontrak);
    }
    const topEfi = Object.values(efi).map(r => ({ ...r, efisiensi: r.total_pagu - r.total_kontrak, persen_efisiensi: r.total_pagu > 0 ? Math.round((r.total_pagu - r.total_kontrak) / r.total_pagu * 10000) / 100 : 0 }));
    topEfi.sort((a, b) => b.efisiensi - a.efisiensi);

    // Top OPD paket
    const cnt: Record<string, any> = {};
    for (const r of selesai) {
      const k = r.kode_satker || r.nama_satker;
      cnt[k] ??= { kode_satker: r.kode_satker, nama_satker: r.nama_satker, jumlah: 0 };
      cnt[k].jumlah++;
    }
    const topPaket = Object.values(cnt).sort((a, b) => b.jumlah - a.jumlah);

    // Top penyedia
    const sand = this.filterRows((await this.sandingan.buildRows(p.periode ?? null, p.tahun ?? null)).rows, p, false);
    const pen: Record<string, any> = {};
    for (const r of sand) {
      const k = String(r.nama_penyedia ?? "").trim();
      if (!r.ada_realisasi || k === "") continue;
      pen[k] ??= { nama_penyedia: k, jumlah: 0, total_kontrak: 0 };
      pen[k].jumlah++; pen[k].total_kontrak += Number(r.nilai_kontrak);
    }
    const topPen = Object.values(pen).sort((a, b) => b.jumlah - a.jumlah);

    return Api.ok({
      top_opd_efisiensi: topEfi.slice(0, 10),
      top_opd_paket: topPaket.slice(0, 10),
      top_penyedia_paket: topPen.slice(0, 10),
    });
  }

  async analisisDetail(p: Record<string, any>) {
    const tipe = p.tipe ?? "";
    const page = Math.max(1, Number(p.page ?? 1));
    const perPage = Math.max(1, Math.min(500, Number(p.per_page ?? 50)));
    const periode = p.periode ?? null;
    const tahun = p.tahun ?? null;
    const satkers = N.satkerList(p.kode_satker ?? null);

    let rows: any[];
    if (tipe === "opd_efisiensi" || tipe === "opd_paket") {
      rows = (await this.efisiensi.build(periode, tahun)).rows.filter((r: any) =>
        this.inSatker(r, satkers) && r.status_realisasi === "Selesai");
    } else if (tipe === "penyedia_paket") {
      const nama = String(p.nama_penyedia ?? "").trim();
      rows = (await this.sandingan.buildRows(periode, tahun)).rows.filter((r: any) =>
        r.ada_realisasi && String(r.nama_penyedia ?? "").trim() === nama);
    } else if (tipe === "dim_unmatched") {
      const fieldMap: Record<string, string> = { satker: "kode_satker", transaksi: "sumber_transaksi", metode: "metode_pengadaan", jenis: "jenis_pengadaan" };
      const field = fieldMap[p.dim ?? ""];
      if (!field) throw new ApiException("Parameter dim tidak dikenali.");
      const statusFilter = (p.status ?? "") === "berjalan" ? "Sedang Berjalan" : "Selesai";
      rows = (await this.efisiensi.build(periode, tahun)).rows.filter((r: any) =>
        r.status_realisasi === statusFilter && r.is_unmatched && !r.is_manual_pagu
        && (String(r[field] ?? "") || "(Tidak Diketahui)") === (p.value ?? null));
    } else {
      throw new ApiException("Parameter tipe tidak dikenali.");
    }

    const total = rows.length;
    const items = rows.slice((page - 1) * perPage, page * perPage).map(r => {
      const known = Number(r.pagu) > 0;
      return {
        kode_rup: r.kode_rup, kode_paket: r.kode_paket, kode_satker: r.kode_satker,
        periode: r.periode ?? null, nama_satker: r.nama_satker,
        nama_paket: (r.nama_paket_realisasi ?? null) || (r.nama_paket_rup ?? null),
        nama_penyedia: r.nama_penyedia, metode_pengadaan: r.metode_pengadaan,
        pagu: Number(r.pagu), nilai_kontrak: Number(r.nilai_kontrak),
        efisiensi: known ? Number(r.pagu) - Number(r.nilai_kontrak) : null, pagu_diketahui: known,
        status_realisasi: r.status_realisasi, excluded_dari_efisiensi: !!r.excluded_dari_efisiensi,
      };
    });

    return Api.ok({ total, page, per_page: perPage, total_pages: Math.max(1, Math.ceil(total / perPage)), items });
  }

  async listExcludeMetode(_p: Record<string, any>) {
    const options = await this.sql`
      SELECT DISTINCT metode_pengadaan FROM realisasi_records
      WHERE metode_pengadaan IS NOT NULL AND metode_pengadaan <> ''
      ORDER BY metode_pengadaan`;
    return Api.ok({ metode_options: options.map((r: any) => r.metode_pengadaan), excluded: await this.excludedList() });
  }

  async saveExcludeMetode(p: Record<string, any>) {
    if (!Array.isArray(p.excluded)) throw new ApiException("Parameter excluded harus berupa array metode_pengadaan.");
    const uniq = [...new Set((p.excluded as any[]).map(m => String(m).trim()).filter(m => m !== ""))];
    await this.sql.begin(async (tx: any) => {
      await tx`DELETE FROM efisiensi_exclude_metode`;
      for (const m of uniq) {
        await tx.unsafe(`INSERT INTO efisiensi_exclude_metode (metode) VALUES ($1)`, [m]);
      }
    });
    return Api.ok({ excluded: uniq }, "Setting metode dikecualikan dari efisiensi berhasil disimpan.");
  }

  async listManualPagu(_p: Record<string, any>) {
    return Api.ok(castAll(await this.sql`SELECT * FROM manual_pagu ORDER BY id`));
  }

  private async excludedList(): Promise<string[]> {
    const rows = await this.sql`SELECT metode FROM efisiensi_exclude_metode`;
    return rows.map((r: any) => String(r.metode).trim()).filter((m: string) => m !== "");
  }

  private inSatker(r: any, satkers: string[]): boolean {
    return satkers.length === 0 || satkers.includes(String(r.kode_satker));
  }

  private filterRows(rows: any[], p: Record<string, any>, withJenis: boolean): any[] {
    const satkers = N.satkerList(p.kode_satker ?? null);
    return rows.filter(r =>
      this.inSatker(r, satkers)
      && sumberTransaksiMatch(r.sumber_transaksi ?? null, p.sumber_transaksi ?? null)
      && (!p.metode_pengadaan || (r.metode_pengadaan ?? null) === p.metode_pengadaan)
      && (!withJenis || !p.jenis_pengadaan || (r.jenis_pengadaan ?? null) === p.jenis_pengadaan)
      && (!p.status_paket || r.status_realisasi === p.status_paket)
    );
  }
}
