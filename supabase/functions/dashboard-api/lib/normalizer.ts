// ─── Normalizer: CSV header aliases, status mapping, etc. ─────

const HEADER_ALIAS: Record<string, string> = {
  nama_instansi: "Nama Instansi",
  nama_satuan_kerja: "Nama Satuan Kerja",
  tahun_anggaran: "Tahun Anggaran",
  cara_pengadaan: "Cara Pengadaan",
  metode_pengadaan: "Metode Pengadaan",
  jenis_pengadaan: "Jenis Pengadaan",
  nama_paket: "Nama Paket",
  kode_rup: "Kode RUP",
  sumber_dana: "Sumber Dana",
  produk_dalam_negeri: "Produk Dalam Negeri",
  total_nilai: "Total Nilai (Rp)",
  nilai_pagu: "Total Nilai (Rp)",
  pagu: "Total Nilai (Rp)",
  kode_paket: "Kode Paket",
  sumber_transaksi: "Sumber Transaksi",
  nama_penyedia: "Nama Penyedia",
  status_paket: "Status Paket",
  nilai_pdn: "Nilai PDN (Rp)",
  nilai_umk: "Nilai UMK (Rp)",
  nilai_kontrak: "Total Nilai (Rp)",
};

function canonKey(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]/g, "");
}

let _aliasIndex: Record<string, string> | null = null;
function aliasIndex(): Record<string, string> {
  if (!_aliasIndex) {
    const idx: Record<string, string> = {};
    for (const [alias, target] of Object.entries(HEADER_ALIAS)) {
      idx[canonKey(alias)] = target;
      idx[canonKey(target)] = target;
    }
    _aliasIndex = idx;
  }
  return _aliasIndex;
}

export function normalizeHeaders(row: Record<string, any>): Record<string, any> {
  const idx = aliasIndex();
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    out[idx[canonKey(String(k))] ?? String(k).trim()] = v;
  }
  return out;
}

export function str(v: any): string {
  return v == null || v === false ? "" : String(v);
}

export function number(v: any): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

export function cara(v: any): string {
  const s = str(v).trim();
  if (/swakelola/i.test(s)) return "Swakelola";
  if (/penyedia/i.test(s)) return "Penyedia";
  return s !== "" ? s : "Tidak Diketahui";
}

export function sumberDana(raw: string): string {
  if (raw === "" || raw === "null") return "Tidak Diketahui";
  const v = raw.trim();
  const map: Record<string, string> = {
    "APBD;APBDP": "APBD+APBDP", "APBD,APBDP": "APBD+APBDP", "APBDP;APBD": "APBD+APBDP",
    "APBD;BLUD": "APBD+BLUD", "BLUD;APBD": "APBD+BLUD",
  };
  return map[v] ?? (v !== "" ? v : "Tidak Diketahui");
}

export function jenis(raw: string): string {
  const v = raw.trim();
  if (v === "") return "Tidak Terklasifikasi";
  if (v === "Barang" || v === "Pengadaan Barang") return "Barang";
  if (v.startsWith("Jasa Konsultansi")) return "Jasa Konsultansi";
  if (["Jasa Lainnya", "Pekerjaan Konstruksi", "Terintegrasi"].includes(v)) return v;
  return "Tidak Terklasifikasi";
}

export function status(raw: string | null | undefined): string {
  if (!raw || raw === "") return "Belum Berproses";
  const v = raw.trim().toUpperCase();
  const map: Record<string, string> = {
    COMPLETED: "Selesai", SELESAI: "Selesai", "PAKET SELESAI": "Selesai",
    "KONTRAK SELESAI": "Selesai", "PAYMENT OUTSIDE SYSTEM": "Selesai",
    "PAKET SEDANG BERJALAN": "Sedang Berjalan", "KONTRAK SEDANG BERJALAN": "Sedang Berjalan",
    "ON PROCESS": "Sedang Berjalan", BERLANGSUNG: "Sedang Berjalan", "ON ADDENDUM": "Sedang Berjalan",
  };
  if (map[v]) return map[v];
  if (v.includes("BELUM")) return "Belum Berproses";
  if (v.includes("SELESAI") || v.includes("COMPLETE")) return "Selesai";
  for (const needle of ["BERJALAN", "PROCESS", "BERLANGSUNG", "ADDENDUM"]) {
    if (v.includes(needle)) return "Sedang Berjalan";
  }
  return "Belum Berproses";
}

export function parseSatker(raw: string): [string, string] {
  const s = raw.trim();
  const i = s.lastIndexOf(" - ");
  return i === -1 ? [s, ""] : [s.substring(0, i).trim(), s.substring(i + 3).trim()];
}

export function splitKodeRup(raw: string | null | undefined): string[] {
  if (!raw || raw === "") return [];
  return raw.split(";").map(s => s.trim()).filter(s => s !== "");
}

export function satkerList(raw: any): string[] {
  if (raw == null || raw === "" || (Array.isArray(raw) && raw.length === 0)) return [];
  const s = Array.isArray(raw) ? raw.join(",") : String(raw);
  return s.split(",").map(x => x.trim()).filter(x => x !== "");
}

export function keywords(text: any): string[] {
  const parts = str(text).toLowerCase().split(/[,;|\n]+/);
  return parts.map(s => s.trim()).filter(s => s !== "");
}

export function jenisRupLabel(raw: any): string {
  const v = str(raw).trim();
  return v === "" || v === "-" ? "Tidak Terklasifikasi" : v;
}

export function containsAny(terms: string[], ...fields: any[]): boolean {
  if (terms.length === 0) return true;
  for (const f of fields) {
    const hay = str(f).toLowerCase();
    for (const t of terms) {
      if (hay.includes(t)) return true;
    }
  }
  return false;
}
