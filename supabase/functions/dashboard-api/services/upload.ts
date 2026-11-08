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

  // ─── Import Pagu dari CSV LPSE (Tender/Non-Tender) ─────────
  async importPaguLpse(p: Record<string, any>) {
    const data = p.data;
    if (!Array.isArray(data) || data.length === 0) {
      throw new ApiException("Data wajib ada.");
    }
    const overwrite = !!p.overwrite;
    const allPeriode = !!p.all_periode;
    const periode = p.periode ?? null;
    const chunk = Number(p.chunk_index ?? 0);
    const total = Number(p.total_chunks ?? 1);
    const isLast = chunk === total - 1;

    // Determine CSV type (tender or non-tender)
    const rows = data.map((r: any) => N.normalizeHeaders(r));
    const isTender = "kd_tender" in (rows[0] ?? {});
    const isNonTender = "kd_nontender" in (rows[0] ?? {});
    const kodeField = isTender ? "kd_tender" : isNonTender ? "kd_nontender" : null;
    if (!kodeField) throw new ApiException("Kolom kd_tender atau kd_nontender wajib ada.");

    // Build CSV lookup: kode_paket -> pagu
    const csvPagu: Record<string, number> = {};
    const csvKodeRup: Record<string, string> = {};
    for (const row of rows) {
      const kode = String(row[kodeField] ?? "").trim();
      if (!kode) continue;
      csvPagu[kode] = Number(row.pagu ?? row.hps ?? 0);
      const kru = String(row.kd_rup ?? "").trim();
      if (kru) csvKodeRup[kode] = kru;
    }

    // Get periodes to process
    let periodes: string[];
    if (allPeriode) {
      const pRows = await this.sql`SELECT DISTINCT periode FROM realisasi_records ORDER BY periode`;
      periodes = pRows.map((r: any) => r.periode);
    } else if (periode) {
      periodes = [periode];
    } else {
      throw new ApiException("Periode wajib jika all_periode=false.");
    }

    let totalFilled = 0, totalSkippedExists = 0, totalSkippedNoMatch = 0, totalUnmatched = 0;
    let totalKodeRupFilled = 0;
    const perPeriode: { periode: string; filled: number }[] = [];

    for (const pr of periodes) {
      // Find UNMATCHED realisasi for this periode
      const unmatchedRows = await this.sql`
        SELECT r.kode_paket, r.kode_rup
        FROM realisasi_records r
        LEFT JOIN matching_results m ON m.periode = r.periode AND m.kode_paket = r.kode_paket AND m.status_matching = 'MATCHED'
        WHERE r.periode = ${pr} AND m.matching_id IS NULL
          AND COALESCE(TRIM(r.kode_paket), '') <> ''`;

      let filled = 0, skippedExists = 0, skippedNoMatch = 0;

      for (const um of unmatchedRows) {
        const kp = String(um.kode_paket).trim();
        if (!(kp in csvPagu)) {
          skippedNoMatch++;
          continue;
        }

        // Check if manual_pagu already exists
        const existing = await this.sql`SELECT 1 FROM manual_pagu WHERE kode_paket = ${kp}`;
        if (existing.length > 0) {
          if (overwrite) {
            await this.sql`UPDATE manual_pagu SET pagu = ${csvPagu[kp]} WHERE kode_paket = ${kp}`;
            filled++;
          } else {
            skippedExists++;
          }
        } else {
          await this.sql.unsafe(
            `INSERT INTO manual_pagu ("kode_paket", "pagu") VALUES ($1, $2)`,
            [kp, csvPagu[kp]]
          );
          filled++;
        }

        // Fill kode_rup if available and empty
        if (csvKodeRup[kp]) {
          const kruCurrent = String(um.kode_rup ?? "").trim();
          if (!kruCurrent) {
            await this.sql`UPDATE realisasi_records SET kode_rup = ${csvKodeRup[kp]} WHERE periode = ${pr} AND kode_paket = ${kp} AND (kode_rup IS NULL OR TRIM(kode_rup) = '')`;
            totalKodeRupFilled++;
          }
        }
      }

      totalFilled += filled;
      totalSkippedExists += skippedExists;
      totalSkippedNoMatch += skippedNoMatch;
      totalUnmatched += unmatchedRows.length;
      perPeriode.push({ periode: pr, filled });
    }

    // If kode_rup was filled and this is the last chunk, re-run matching
    if (isLast && totalKodeRupFilled > 0) {
      try {
        for (const pr of periodes) {
          await this.sql`SELECT * FROM run_matching(${pr})`;
        }
      } catch (e) {
        console.error("Re-matching after pagu import failed:", e);
      }
    }

    return Api.ok({
      filled: totalFilled,
      skipped_exists: totalSkippedExists,
      skipped_no_match: totalSkippedNoMatch,
      total_unmatched: totalUnmatched,
      kode_rup_filled: totalKodeRupFilled > 0 ? totalKodeRupFilled : undefined,
      per_periode: perPeriode.length > 1 ? perPeriode : undefined,
    }, `Pagu LPSE terisi: ${totalFilled} paket.`);
  }
}
