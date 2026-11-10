import { Api } from "../lib/api.ts";

// deno-lint-ignore no-explicit-any
type Sql = any;
type Payload = Record<string, unknown>;

// Sesuaikan jika nama tabel RUP resmi Anda berbeda
const RUP_TABLE = "rup";

const ok = (message: string, data?: unknown) => ({ status: "success", code: 200, message, data });
const str = (v: unknown) => String(v ?? "").trim();

function normSD(raw: unknown): string {
  const v = str(raw);
  if (!v || v === "null") return "Tidak Diketahui";
  if (["APBD;APBDP", "APBD,APBDP", "APBDP;APBD"].includes(v)) return "APBD+APBDP";
  if (["APBD;BLUD", "BLUD;APBD"].includes(v)) return "APBD+BLUD";
  return v;
}

const splitKodeRup = (raw: unknown): string[] =>
  str(raw).split(";").map((s) => s.trim()).filter(Boolean);

export class ManualDataService {
  constructor(
    private sql: Sql,
    // deno-lint-ignore no-explicit-any
    private matching: { handleRun: (p: any) => Promise<any> },
  ) {}

  // ── Manual Pagu ─────────────────────────────────────────────
  async saveManualPagu(p: Payload) {
    const kode = str(p.kode_paket);
    if (!kode || p.pagu_manual === undefined || p.pagu_manual === null)
      return Api.error("kode_paket dan pagu_manual wajib.", 400);

    const pagu = Number(p.pagu_manual);
    if (!Number.isFinite(pagu)) return Api.error("pagu_manual harus angka.", 400);

    const [row] = await this.sql`
      insert into manual_pagu (kode_paket, nama_paket, nama_satker, pagu_manual)
      values (${kode}, ${str(p.nama_paket)}, ${str(p.nama_satker)}, ${pagu})
      on conflict (kode_paket) do update set
        nama_paket  = coalesce(nullif(excluded.nama_paket, ''),  manual_pagu.nama_paket),
        nama_satker = coalesce(nullif(excluded.nama_satker, ''), manual_pagu.nama_satker),
        pagu_manual = excluded.pagu_manual,
        updated_at  = now()
      returning (xmax = 0) as inserted`;
    return ok(row.inserted ? "Pagu manual disimpan." : "Pagu manual diperbarui.");
  }

  async deleteManualPagu(p: Payload) {
    const kode = str(p.kode_paket);
    if (!kode) return Api.error("kode_paket wajib.", 400);
    const res = await this.sql`delete from manual_pagu where kode_paket = ${kode}`;
    return res.count
      ? ok("Pagu manual dihapus.")
      : Api.error("Kode paket tidak ditemukan.", 404);
  }

  // ── Status Override ─────────────────────────────────────────
  async saveStatusOverride(p: Payload) {
    const kodeRup = str(p.kode_rup);
    const type = str(p.override_type);
    if (!kodeRup) return Api.error("kode_rup wajib.", 400);
    if (!["Dibatalkan", "Manual"].includes(type))
      return Api.error("override_type harus 'Dibatalkan' atau 'Manual'.", 400);

    const isManual = type === "Manual";
    const nilai = Number(p.nilai_kontrak_manual);
    if (isManual && (p.nilai_kontrak_manual === undefined || !(nilai >= 0)))
      return Api.error("nilai_kontrak_manual wajib diisi untuk override Manual.", 400);

    const [row] = await this.sql`
      insert into status_override
        (kode_rup, override_type, kode_paket_manual, nama_paket_manual,
         nama_penyedia_manual, nilai_kontrak_manual, status_manual, keterangan)
      values (
        ${kodeRup}, ${type},
        ${isManual ? str(p.kode_paket_manual) : ""},
        ${isManual ? str(p.nama_paket_manual) : ""},
        ${isManual ? str(p.nama_penyedia_manual) : ""},
        ${isManual ? nilai : 0},
        ${isManual ? str(p.status_manual) || "Selesai" : ""},
        ${str(p.keterangan)}
      )
      on conflict (kode_rup) do update set
        override_type = excluded.override_type,
        kode_paket_manual = excluded.kode_paket_manual,
        nama_paket_manual = excluded.nama_paket_manual,
        nama_penyedia_manual = excluded.nama_penyedia_manual,
        nilai_kontrak_manual = excluded.nilai_kontrak_manual,
        status_manual = excluded.status_manual,
        keterangan = excluded.keterangan,
        updated_at = now()
      returning (xmax = 0) as inserted`;
    return ok(row.inserted ? "Status override disimpan." : "Status override diperbarui.");
  }

  async deleteStatusOverride(p: Payload) {
    const kodeRup = str(p.kode_rup);
    if (!kodeRup) return Api.error("kode_rup wajib.", 400);
    const res = await this.sql`delete from status_override where kode_rup = ${kodeRup}`;
    return res.count
      ? ok("Override dihapus, status kembali otomatis.")
      : Api.error("kode_rup tidak ditemukan di status_override.", 404);
  }

  // ── RUP Manual ──────────────────────────────────────────────
  async listManualRUP(p: Payload) {
    const periode = str(p.periode);
    const rows = periode
      ? await this.sql`select * from rup_manual where periode = ${periode} order by periode desc, kode_rup`
      : await this.sql`select * from rup_manual order by periode desc, kode_rup`;
    return ok("OK", rows);
  }

  async addManualRUP(p: Payload) {
    const periode = str(p.periode);
    const kodeRup = str(p.kode_rup);
    const namaSatker = str(p.nama_satker);
    const namaPaket = str(p.nama_paket);
    if (!periode || !kodeRup || !namaSatker || !namaPaket || p.pagu === undefined)
      return Api.error("periode, kode_rup, nama_satker, nama_paket, dan pagu wajib diisi.", 400);
    if (!/^\d{4}-\d{2}$/.test(periode))
      return Api.error("Format periode harus YYYY-MM.", 400);

    const [tahun, bulan] = periode.split("-").map(Number);
    const codes = splitKodeRup(kodeRup);

    const [dup] = await this.sql`
      select 1 from (
        select kode_rup from ${this.sql(RUP_TABLE)} where periode = ${periode}
        union all
        select kode_rup from rup_manual where periode = ${periode}
      ) t
      where string_to_array(t.kode_rup, ';') && ${codes}::text[]
      limit 1`;
    if (dup) return Api.error(`Kode RUP ${kodeRup} sudah ada di data RUP periode ini.`, 400);

    await this.sql`
      insert into rup_manual (periode, bulan, tahun, nama_satker, kode_satker, cara_pengadaan,
        metode_pengadaan, jenis_pengadaan, nama_paket, kode_rup, sumber_dana,
        produk_dalam_negeri, pagu)
      values (${periode}, ${bulan}, ${tahun}, ${namaSatker}, ${str(p.kode_satker)},
        ${str(p.cara_pengadaan) || "Penyedia"}, ${str(p.metode_pengadaan) || "-"},
        ${str(p.jenis_pengadaan) || "-"}, ${namaPaket}, ${kodeRup},
        ${normSD(p.sumber_dana)}, ${str(p.produk_dalam_negeri)}, ${Number(p.pagu) || 0})`;

    const matchResult = await this.matching.handleRun({ periode });
    return ok("Paket RUP manual ditambahkan & matching dijalankan ulang.", {
      kode_rup: kodeRup,
      matching: matchResult,
    });
  }

  async deleteManualRUP(p: Payload) {
    const periode = str(p.periode);
    const kodeRup = str(p.kode_rup);
    if (!periode || !kodeRup) return Api.error("periode dan kode_rup wajib.", 400);

    const res = await this.sql`
      delete from rup_manual where periode = ${periode} and kode_rup = ${kodeRup}`;
    if (!res.count) return Api.error("Baris RUP manual tidak ditemukan.", 404);

    const matchResult = await this.matching.handleRun({ periode });
    return ok("Baris RUP manual dihapus & matching dijalankan ulang.", matchResult);
  }
}
