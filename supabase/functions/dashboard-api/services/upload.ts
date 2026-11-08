// ─── UploadService ────────────────────────────────────────────
import { Api, ApiException } from "../lib/api.ts";
import * as N from "../lib/normalizer.ts";
import { MatchingService } from "./matching.ts";

export class UploadService {
  constructor(private sql: any, private matching: MatchingService) {}

  async uploadRup(p: Record<string, any>) {
    const [periode, bulan, tahun, uploadId, isFirst, isLast, rows] = this.prepare(p);

    if (isFirst) {
      this.assertColumns(rows, ["Nama Satuan Kerja", "Cara Pengadaan", "Nama Paket", "Kode RUP", "Total Nilai (Rp)"]);
    }

    const records = rows.map((row: Record<string, any>) => {
      const [namaSatker, kodeSatker] = N.parseSatker(N.str(row["Nama Satuan Kerja"] ?? ""));
      let c = N.cara(row["Cara Pengadaan"] ?? "");
      let metode = N.str(row["Metode Pengadaan"] ?? "");
      let jen = N.str(row["Jenis Pengadaan"] ?? "");
      metode = metode === "" ? "-" : metode.trim();
      jen = jen === "" ? "-" : jen.trim();
      if (c === "Swakelola") { metode = "Swakelola"; jen = "Swakelola"; }

      return {
        upload_id: uploadId, periode, bulan, tahun,
        kode_satker: kodeSatker, nama_satker: namaSatker,
        cara_pengadaan: c, metode_pengadaan: metode, jenis_pengadaan: jen,
        nama_paket: N.str(row["Nama Paket"] ?? ""),
        kode_rup: N.str(row["Kode RUP"] ?? ""),
        sumber_dana: N.sumberDana(N.str(row["Sumber Dana"] ?? "")),
        produk_dalam_negeri: N.str(row["Produk Dalam Negeri"] ?? ""),
        pagu: N.number(row["Total Nilai (Rp)"] ?? 0),
      };
    });

    if (isFirst) {
      await this.sql`DELETE FROM rup_records WHERE periode = ${periode}`;
      await this.sql`DELETE FROM upload_logs WHERE periode = ${periode} AND jenis_data = 'RUP'`;
    }
    await this.insertChunks("rup_records", records);
    if (isLast) {
      await this.writeLog(uploadId, periode, bulan, tahun, "RUP", p, records.length);
    }

    return Api.ok({ jumlah_record: records.length, is_last: isLast }, "Chunk RUP OK.");
  }

  async uploadRealisasi(p: Record<string, any>) {
    const [periode, bulan, tahun, uploadId, isFirst, isLast, rows] = this.prepare(p);

    if (isFirst) {
      this.assertColumns(rows, ["Nama Satuan Kerja", "Kode Paket", "Sumber Transaksi", "Total Nilai (Rp)"]);
    }

    const records = rows.map((row: Record<string, any>) => {
      const [namaSatker, kodeSatker] = N.parseSatker(N.str(row["Nama Satuan Kerja"] ?? ""));
      const statusAsli = N.str(row["Status Paket"] ?? "").trim();
      let kodeRup = N.str(row["Kode RUP"] ?? "");
      const namaPenyedia = N.str(row["Nama Penyedia"] ?? "");
      const metode = N.str(row["Metode Pengadaan"] ?? "");
      const namaPaket = N.str(row["Nama Paket"] ?? "");

      return {
        upload_id: uploadId, periode, bulan, tahun,
        kode_satker: kodeSatker, nama_satker: namaSatker,
        kode_paket: N.str(row["Kode Paket"] ?? ""),
        kode_rup: kodeRup !== "" ? kodeRup.replace(/\.0/, "").trim() : null,
        sumber_transaksi: N.str(row["Sumber Transaksi"] ?? ""),
        sumber_dana: N.sumberDana(N.str(row["Sumber Dana"] ?? "")),
        nama_penyedia: namaPenyedia !== "" ? namaPenyedia : null,
        metode_pengadaan: metode !== "" ? metode : null,
        jenis_pengadaan: N.jenis(N.str(row["Jenis Pengadaan"] ?? "")),
        nama_paket: namaPaket !== "" ? namaPaket : null,
        status_paket_asli: statusAsli !== "" ? statusAsli : null,
        status_paket: N.status(statusAsli !== "" ? statusAsli : null),
        nilai_kontrak: N.number(row["Total Nilai (Rp)"] ?? 0),
        nilai_pdn: N.number(row["Nilai PDN (Rp)"] ?? 0),
      };
    });

    if (isFirst) {
      await this.sql`DELETE FROM realisasi_records WHERE periode = ${periode}`;
      await this.sql`DELETE FROM upload_logs WHERE periode = ${periode} AND jenis_data = 'REALISASI'`;
      await this.sql`DELETE FROM matching_results WHERE periode = ${periode}`;
    }
    await this.insertChunks("realisasi_records", records);
    if (isLast) {
      await this.writeLog(uploadId, periode, bulan, tahun, "REALISASI", p, records.length);
    }

    // Matching is now triggered separately via "runMatching" action
    // to avoid Edge Function timeout on large datasets
    return Api.ok({
      jumlah_record: records.length,
      is_last: isLast,
      need_matching: isLast,
    }, isLast ? "Upload Realisasi selesai. Silakan jalankan Matching." : "Chunk OK.");
  }

  private prepare(p: Record<string, any>): [string, number, number, string, boolean, boolean, Record<string, any>[]] {
    const periode = p.periode;
    const data = p.data;
    if (typeof periode !== "string" || !/^\d{4}-\d{2}$/.test(periode) || !Array.isArray(data)) {
      throw new ApiException("Periode (YYYY-MM) dan data wajib ada.");
    }
    const [tahun, bulan] = periode.split("-").map(Number);
    const chunk = Number(p.chunk_index ?? 0);
    const total = Number(p.total_chunks ?? 1);

    return [
      periode, bulan, tahun,
      String(p.session_id ?? crypto.randomUUID()),
      chunk === 0,
      chunk === total - 1,
      data.map((r: any) => N.normalizeHeaders(r)),
    ];
  }

  private assertColumns(rows: Record<string, any>[], required: string[]): void {
    if (rows.length === 0) return;
    const keys = Object.keys(rows[0]);
    const missing = required.filter(r => !keys.includes(r));
    if (missing.length > 0) {
      throw new ApiException("Kolom tidak lengkap: " + missing.join(", "));
    }
  }

  private async insertChunks(table: string, records: Record<string, any>[]): Promise<void> {
    if (records.length === 0) return;
    const columns = Object.keys(records[0]);
    for (let i = 0; i < records.length; i += 50) {
      const chunk = records.slice(i, i + 50);
      const placeholders = chunk.map((row, ri) =>
        `(${columns.map((_, ci) => `$${ri * columns.length + ci + 1}`).join(",")})`
      ).join(",");
      const values = chunk.flatMap(row => columns.map(c => row[c] ?? null));
      await this.sql.unsafe(
        `INSERT INTO ${table} (${columns.map(c => `"${c}"`).join(",")}) VALUES ${placeholders}`,
        values
      );
    }
  }

  private async writeLog(uploadId: string, periode: string, bulan: number, tahun: number, jenis: string, p: Record<string, any>, fallbackCount: number): Promise<void> {
    const chunks = Number(p.total_chunks ?? 1);
    const row = {
      upload_id: uploadId, periode, bulan, tahun,
      jenis_data: jenis,
      nama_file: p.nama_file ?? (jenis === "RUP" ? "data_rup.csv" : "data_realisasi.csv"),
      jumlah_record: Number(p.total_records ?? fallbackCount),
      uploaded_by: "Admin", uploaded_at: new Date().toISOString(), status: "SUCCESS",
      catatan: "Upload selesai" + (chunks > 1 ? ` (${chunks} chunk)` : ""),
    };
    const cols = Object.keys(row);
    const vals = Object.values(row);
    await this.sql.unsafe(
      `INSERT INTO upload_logs (${cols.map(c => `"${c}"`).join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
      vals
    );
  }
}
