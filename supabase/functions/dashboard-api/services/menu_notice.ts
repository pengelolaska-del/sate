// ─── MenuNoticeService ────────────────────────────────────────
import { Api, ApiException } from "../lib/api.ts";

const MENU_LIST = [
  { key: "rup",       label: "Rencana (RUP)" },
  { key: "realisasi", label: "Realisasi" },
  { key: "sandingan", label: "Sandingan RUP" },
  { key: "efisiensi", label: "Analisis" },
  { key: "rekap",     label: "Rekap Laporan" },
  { key: "upload",    label: "Upload Data" },
  { key: "kualitas",  label: "Kualitas Data" },
];

export class MenuNoticeService {
  constructor(private sql: any) {}

  async list(_p: Record<string, any>) {
    const rows = await this.sql`SELECT menu_key FROM menu_notices`;
    const enabled = rows.map((r: any) => r.menu_key);
    const validKeys = MENU_LIST.map(m => m.key);

    return Api.ok({
      menu_options: MENU_LIST,
      enabled: validKeys.filter(k => enabled.includes(k)),
    });
  }

  async save(p: Record<string, any>) {
    const enabled = p.enabled;
    if (!Array.isArray(enabled)) {
      throw new ApiException("Parameter enabled harus berupa array menu_key.");
    }
    const validKeys = MENU_LIST.map(m => m.key);
    const uniq = [...new Set(enabled.map((k: any) => String(k).trim()).filter((k: string) => validKeys.includes(k)))];

    await this.sql.begin(async (tx: any) => {
      await tx`DELETE FROM menu_notices`;
      if (uniq.length > 0) {
        await tx`INSERT INTO menu_notices ${tx(uniq.map(k => ({ menu_key: k })))}`;
      }
    });

    return Api.ok({ enabled: uniq }, "Pengaturan notifikasi menu berhasil disimpan.");
  }
}
