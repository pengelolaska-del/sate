// ─── MatchingService ──────────────────────────────────────────
import { Api, ApiException } from "../lib/api.ts";
import { jaroWinklerSimilarity } from "../lib/jaro_winkler.ts";
import * as N from "../lib/normalizer.ts";

const SIMILARITY_THRESHOLD = Number(Deno.env.get("DASHBOARD_SIMILARITY_THRESHOLD") ?? "0.75");

export class MatchingService {
  constructor(private sql: any) {}

  async handleRun(p: Record<string, any>) {
    const periode = p.periode;
    if (typeof periode !== "string" || !/^\d{4}-\d{2}$/.test(periode)) {
      throw new ApiException("Periode wajib.");
    }
    const [tahun, bulan] = periode.split("-").map(Number);
    const res = await this.run(periode);
    await this.buildAggregate(periode, bulan, tahun);
    return Api.ok({ ...res, periode }, "Matching selesai.");
  }

  async buildAggregate(periode: string, bulan: number, tahun: number) {
    const agg = await this.computeAggregate(periode);
    // upsert
    const existing = await this.sql`SELECT 1 FROM dashboard_aggregates WHERE periode = ${periode}`;
    if (existing.length > 0) {
      await this.sql`UPDATE dashboard_aggregates SET ${this.sql({
        ...agg, bulan, tahun, created_at: new Date().toISOString(),
      })} WHERE periode = ${periode}`;
    } else {
      await this.sql`INSERT INTO dashboard_aggregates ${this.sql({
        aggregate_id: crypto.randomUUID(), periode, ...agg,
        bulan, tahun, created_at: new Date().toISOString(),
      })}`;
    }
  }

  async computeAggregate(periode: string, satkers?: string[]) {
    const satkerFilter = satkers && satkers.length > 0;

    // RUP count & pagu
    let rup;
    if (satkerFilter) {
      rup = (await this.sql`SELECT count(*) AS n, COALESCE(sum(pagu),0) AS pagu FROM rup_records WHERE periode = ${periode} AND kode_satker = ANY(${satkers})`)[0];
    } else {
      rup = (await this.sql`SELECT count(*) AS n, COALESCE(sum(pagu),0) AS pagu FROM rup_records WHERE periode = ${periode}`)[0];
    }

    // Realisasi
    let real;
    if (satkerFilter) {
      real = (await this.sql`SELECT count(*) AS n, COALESCE(sum(nilai_pdn),0) AS pdn,
        count(*) FILTER (WHERE status_paket = 'Selesai') AS selesai,
        count(*) FILTER (WHERE status_paket = 'Sedang Berjalan') AS berjalan,
        count(*) FILTER (WHERE status_paket = 'Belum Berproses') AS belum
        FROM realisasi_records WHERE periode = ${periode} AND kode_satker = ANY(${satkers})`)[0];
    } else {
      real = (await this.sql`SELECT count(*) AS n, COALESCE(sum(nilai_pdn),0) AS pdn,
        count(*) FILTER (WHERE status_paket = 'Selesai') AS selesai,
        count(*) FILTER (WHERE status_paket = 'Sedang Berjalan') AS berjalan,
        count(*) FILTER (WHERE status_paket = 'Belum Berproses') AS belum
        FROM realisasi_records WHERE periode = ${periode}`)[0];
    }

    // Matching
    let match;
    if (satkerFilter) {
      match = (await this.sql`SELECT
        count(*) FILTER (WHERE status_matching = 'MATCHED') AS matched,
        COALESCE(sum(nilai_kontrak) FILTER (WHERE status_matching = 'MATCHED'), 0) AS kontrak,
        count(*) FILTER (WHERE status_matching = 'UNMATCHED' AND COALESCE(kode_rup,'') <> '' AND COALESCE(kode_paket,'') = '') AS um_rup,
        count(*) FILTER (WHERE status_matching = 'UNMATCHED' AND COALESCE(kode_paket,'') <> '') AS um_real
        FROM matching_results WHERE periode = ${periode} AND kode_satker = ANY(${satkers})`)[0];
    } else {
      match = (await this.sql`SELECT
        count(*) FILTER (WHERE status_matching = 'MATCHED') AS matched,
        COALESCE(sum(nilai_kontrak) FILTER (WHERE status_matching = 'MATCHED'), 0) AS kontrak,
        count(*) FILTER (WHERE status_matching = 'UNMATCHED' AND COALESCE(kode_rup,'') <> '' AND COALESCE(kode_paket,'') = '') AS um_rup,
        count(*) FILTER (WHERE status_matching = 'UNMATCHED' AND COALESCE(kode_paket,'') <> '') AS um_real
        FROM matching_results WHERE periode = ${periode}`)[0];
    }

    // Efisiensi Selesai
    let sel;
    if (satkerFilter) {
      sel = (await this.sql`SELECT COALESCE(sum(m.pagu_rup),0) AS pagu, COALESCE(sum(m.nilai_kontrak),0) AS kontrak
        FROM matching_results m
        WHERE m.periode = ${periode} AND m.status_matching = 'MATCHED' AND COALESCE(m.kode_paket,'') <> ''
        AND m.kode_satker = ANY(${satkers})
        AND EXISTS (SELECT 1 FROM realisasi_records r WHERE r.periode = m.periode AND r.kode_paket = m.kode_paket AND r.status_paket = 'Selesai')`)[0];
    } else {
      sel = (await this.sql`SELECT COALESCE(sum(m.pagu_rup),0) AS pagu, COALESCE(sum(m.nilai_kontrak),0) AS kontrak
        FROM matching_results m
        WHERE m.periode = ${periode} AND m.status_matching = 'MATCHED' AND COALESCE(m.kode_paket,'') <> ''
        AND EXISTS (SELECT 1 FROM realisasi_records r WHERE r.periode = m.periode AND r.kode_paket = m.kode_paket AND r.status_paket = 'Selesai')`)[0];
    }

    const tPagu = Number(rup.pagu), tKontrak = Number(match.kontrak), tPdn = Number(real.pdn);
    const tPaguSel = Number(sel.pagu), tKontrakSel = Number(sel.kontrak);

    return {
      total_pagu: tPagu, total_kontrak: tKontrak,
      total_efisiensi: tPagu - tKontrak,
      persen_efisiensi: tPagu > 0 ? Math.round((tPagu - tKontrak) / tPagu * 10000) / 100 : 0,
      jumlah_paket_rup: Number(rup.n), jumlah_paket_realisasi: Number(real.n),
      jumlah_matched: Number(match.matched), jumlah_unmatched_rup: Number(match.um_rup),
      jumlah_unmatched_realisasi: Number(match.um_real),
      jumlah_selesai: Number(real.selesai), jumlah_sedang_berjalan: Number(real.berjalan),
      jumlah_belum_berproses: Number(real.belum),
      total_nilai_pdn: tPdn, persen_pdn: tKontrak > 0 ? Math.round(tPdn / tKontrak * 10000) / 100 : 0,
      total_pagu_selesai: tPaguSel, total_kontrak_selesai: tKontrakSel,
      total_efisiensi_selesai: tPaguSel - tKontrakSel,
      persen_efisiensi_selesai: tPaguSel > 0 ? Math.round((tPaguSel - tKontrakSel) / tPaguSel * 10000) / 100 : 0,
    };
  }

  async run(periode: string): Promise<{ matched: number; unmatched: number; orphan: number }> {
    const rupAll = await this.sql`
      SELECT kode_rup, kode_satker, nama_satker, nama_paket, metode_pengadaan, pagu
      FROM rup_records WHERE periode = ${periode}`;
    const realAll = await this.sql`
      SELECT kode_paket, kode_rup, kode_satker, nama_satker, nama_paket, metode_pengadaan, nilai_kontrak
      FROM realisasi_records WHERE periode = ${periode}`;

    if (rupAll.length === 0 || realAll.length === 0) {
      return { matched: 0, unmatched: 0, orphan: 0 };
    }

    const aliasRows = await this.sql`SELECT kode_rup_lama, kode_rup_baru FROM kode_rup_aliases`;
    const aliasMap: Record<string, string> = {};
    for (const r of aliasRows) aliasMap[r.kode_rup_lama] = r.kode_rup_baru;

    // Index RUP
    const rupByKode: Record<string, number> = {};
    const rupBySatker: Record<string, number[]> = {};
    for (let i = 0; i < rupAll.length; i++) {
      const r = rupAll[i];
      (r as any)._nl = String(r.nama_paket ?? "").toLowerCase();
      for (const k of N.splitKodeRup(r.kode_rup)) {
        rupByKode[k] = i;
      }
      (rupBySatker[r.kode_satker] ??= []).push(i);
    }
    for (const lama of Object.keys(aliasMap)) {
      const baru = this.resolveChain(lama, aliasMap);
      if (rupByKode[baru] != null && rupByKode[lama] == null) {
        rupByKode[lama] = rupByKode[baru];
      }
    }

    const now = new Date().toISOString();
    const rows: Record<string, any>[] = [];
    const used: Record<string, boolean> = {};
    const deferred: { real: any; idx: number }[] = [];
    let matched = 0, unmatched = 0, orphan = 0;

    for (const real of realAll) {
      const kruRaw = blank(real.kode_rup) ? null : String(real.kode_rup).trim();
      const parts = N.splitKodeRup(kruRaw);
      let statusM = "UNMATCHED";
      let metode = "UNMATCHED";
      const refs: any[] = [];
      let sim: number | null = null;

      if (parts.length > 0) {
        for (const k of parts) {
          if (rupByKode[k] != null) {
            refs.push(rupAll[rupByKode[k]]);
            used[k] = true;
          }
        }
        if (refs.length > 0) {
          statusM = "MATCHED";
          metode = refs.length > 1 ? "EXACT_ID_MULTI" : "EXACT_ID";
          matched++;
        } else {
          unmatched++;
        }
      } else {
        const nama = blank(real.nama_paket) ? null : String(real.nama_paket).trim();
        const pool = rupBySatker[real.kode_satker];
        if (nama && pool) {
          const nl = nama.toLowerCase();
          let best = 0, bestIdx: number | null = null;
          for (const idx of pool) {
            const cand = rupAll[idx];
            if (used[cand.kode_rup] || blank(cand.nama_paket)) continue;
            const sc = jaroWinklerSimilarity(nl, (cand as any)._nl);
            if (sc > best && sc >= SIMILARITY_THRESHOLD) { best = sc; bestIdx = idx; }
          }
          if (bestIdx != null) {
            refs.push(rupAll[bestIdx]);
            statusM = "MATCHED"; metode = "HEURISTIC";
            sim = Math.round(best * 1000) / 1000;
            used[rupAll[bestIdx].kode_rup] = true;
            matched++;
          } else { metode = "ORPHAN"; orphan++; }
        } else { metode = "ORPHAN"; orphan++; }
      }

      const pagu = refs.reduce((s, r) => s + Number(r.pagu), 0);
      const namaRup = refs.map((r: any) => r.nama_paket).filter((v: any) => v).join(", ");
      const kodeRup = refs.map((r: any) => r.kode_rup).join(";");
      const nilai = Number(real.nilai_kontrak);
      const efi = statusM === "MATCHED" ? pagu - nilai : null;

      rows.push({
        matching_id: crypto.randomUUID(), periode,
        kode_satker: real.kode_satker, nama_satker: real.nama_satker,
        kode_rup: statusM === "MATCHED" ? (kodeRup || null) : kruRaw,
        kode_paket: real.kode_paket,
        nama_paket_rup: namaRup || null, nama_paket_realisasi: real.nama_paket,
        metode_matching: metode, similarity_score: sim,
        pagu_rup: statusM === "MATCHED" ? pagu : null,
        nilai_kontrak: nilai, efisiensi: efi,
        persen_efisiensi: efi != null && pagu > 0 ? Math.round(efi / pagu * 10000) / 100 : null,
        status_matching: statusM, created_at: now,
      });
      if (statusM === "UNMATCHED" && parts.length > 0) {
        deferred.push({ real, idx: rows.length - 1 });
      }
    }

    // Fallback: HEURISTIC_NAMA_KODE_BEDA
    const normNama = (t: any) => String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const normMetode = (t: any) => String(t ?? "").toLowerCase().replace(/[^a-z]+/g, "");
    const claimed: Record<string, boolean> = {};

    for (const { real, idx } of deferred) {
      const nama = normNama(real.nama_paket);
      const pool = rupBySatker[real.kode_satker];
      if (nama === "" || !pool) continue;
      const mReal = normMetode(real.metode_pengadaan);
      const cands: any[] = [];
      for (const pi of pool) {
        const cand = rupAll[pi];
        const ids = N.splitKodeRup(cand.kode_rup);
        const anyUsed = ids.some(k => used[k]);
        const anyClaimed = ids.some(k => claimed[k]);
        if ((!anyUsed || anyClaimed) === false || normNama(cand.nama_paket) !== nama) continue;
        const mRup = normMetode(cand.metode_pengadaan);
        if (mReal === "" || mRup === "" || mReal === mRup) cands.push(cand);
      }
      if (cands.length !== 1) continue;

      const rup = cands[0];
      const paguR = Number(rup.pagu);
      const efiR = paguR - Number(real.nilai_kontrak);
      Object.assign(rows[idx], {
        kode_rup: rup.kode_rup, nama_paket_rup: rup.nama_paket,
        metode_matching: "HEURISTIC_NAMA_KODE_BEDA", similarity_score: 1,
        pagu_rup: paguR, efisiensi: efiR,
        persen_efisiensi: paguR > 0 ? Math.round(efiR / paguR * 10000) / 100 : null,
        status_matching: "MATCHED",
      });
      for (const k of N.splitKodeRup(rup.kode_rup)) { used[k] = claimed[k] = true; }
      unmatched--; matched++;
    }

    // Orphan RUP
    for (const r of rupAll) {
      if (N.splitKodeRup(r.kode_rup).some(k => used[k])) continue;
      rows.push({
        matching_id: crypto.randomUUID(), periode,
        kode_satker: r.kode_satker, nama_satker: r.nama_satker,
        kode_rup: r.kode_rup, kode_paket: null,
        nama_paket_rup: r.nama_paket, nama_paket_realisasi: null,
        metode_matching: "UNMATCHED", similarity_score: null,
        pagu_rup: Number(r.pagu), nilai_kontrak: null,
        efisiensi: null, persen_efisiensi: null,
        status_matching: "UNMATCHED", created_at: now,
      });
    }

    // Save
    await this.sql.begin(async (tx: any) => {
      await tx`DELETE FROM matching_results WHERE periode = ${periode}`;
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        await tx`INSERT INTO matching_results ${tx(chunk)}`;
      }
    });

    return { matched, unmatched, orphan };
  }

  private resolveChain(kode: string, aliasMap: Record<string, string>): string {
    let cur = kode;
    const seen = new Set<string>();
    for (let hop = 0; aliasMap[cur] && !seen.has(cur) && hop < 20; hop++) {
      seen.add(cur);
      cur = aliasMap[cur];
    }
    return cur;
  }
}

function blank(v: any): boolean {
  return v == null || String(v).trim() === "";
}
