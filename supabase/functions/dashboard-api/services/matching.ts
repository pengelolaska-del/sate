// ─── MatchingService ──────────────────────────────────────────
// Rewritten: process per-satker to avoid Edge Function memory/timeout crash
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
    const existing = await this.sql`SELECT 1 FROM dashboard_aggregates WHERE periode = ${periode}`;
    if (existing.length > 0) {
      const updateData = { ...agg, bulan, tahun, created_at: new Date().toISOString() };
      const setClauses = Object.keys(updateData).map((k, i) => `"${k}" = $${i + 1}`).join(", ");
      const vals = Object.values(updateData);
      await this.sql.unsafe(
        `UPDATE dashboard_aggregates SET ${setClauses} WHERE periode = $${vals.length + 1}`,
        [...vals, periode]
      );
    } else {
      const insertData: Record<string, any> = { aggregate_id: crypto.randomUUID(), periode, ...agg, bulan, tahun, created_at: new Date().toISOString() };
      const cols = Object.keys(insertData);
      const vals = Object.values(insertData);
      await this.sql.unsafe(
        `INSERT INTO dashboard_aggregates (${cols.map(c => `"${c}"`).join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
        vals
      );
    }
  }

  async computeAggregate(periode: string, satkers?: string[]) {
    const satkerFilter = satkers && satkers.length > 0;

    let rup;
    if (satkerFilter) {
      rup = (await this.sql`SELECT count(*) AS n, COALESCE(sum(pagu),0) AS pagu FROM rup_records WHERE periode = ${periode} AND kode_satker = ANY(${satkers})`)[0];
    } else {
      rup = (await this.sql`SELECT count(*) AS n, COALESCE(sum(pagu),0) AS pagu FROM rup_records WHERE periode = ${periode}`)[0];
    }

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

  // ─── NEW: Per-satker matching to avoid memory/timeout crash ───
  async run(periode: string): Promise<{ matched: number; unmatched: number; orphan: number }> {
    console.log(`[matching] Starting for periode ${periode}`);

    // Step 1: Build lightweight global kode_rup index (only kode+satker+pagu+nama)
    const rupKodeRows = await this.sql`
      SELECT kode_rup, kode_satker, nama_satker, nama_paket, metode_pengadaan, pagu
      FROM rup_records WHERE periode = ${periode}`;
    console.log(`[matching] Loaded ${rupKodeRows.length} RUP records for index`);

    if (rupKodeRows.length === 0) {
      return { matched: 0, unmatched: 0, orphan: 0 };
    }

    // Check realisasi count
    const realCount = (await this.sql`SELECT count(*) AS n FROM realisasi_records WHERE periode = ${periode}`)[0];
    if (Number(realCount.n) === 0) {
      return { matched: 0, unmatched: 0, orphan: 0 };
    }

    // Load aliases (small table)
    const aliasRows = await this.sql`SELECT kode_rup_lama, kode_rup_baru FROM kode_rup_aliases`;
    const aliasMap: Record<string, string> = {};
    for (const r of aliasRows) aliasMap[r.kode_rup_lama] = r.kode_rup_baru;

    // Build global kode_rup -> RUP record index
    const rupByKode: Record<string, any> = {};
    for (const r of rupKodeRows) {
      for (const k of N.splitKodeRup(r.kode_rup)) {
        rupByKode[k] = r;
      }
    }
    for (const lama of Object.keys(aliasMap)) {
      const baru = this.resolveChain(lama, aliasMap);
      if (rupByKode[baru] && !rupByKode[lama]) {
        rupByKode[lama] = rupByKode[baru];
      }
    }

    // Step 2: Get all distinct satkers
    const satkerRows = await this.sql`
      SELECT DISTINCT kode_satker FROM (
        SELECT kode_satker FROM rup_records WHERE periode = ${periode}
        UNION
        SELECT kode_satker FROM realisasi_records WHERE periode = ${periode}
      ) sub ORDER BY kode_satker`;
    console.log(`[matching] Processing ${satkerRows.length} satkers`);

    // Step 3: Delete old matching results
    await this.sql`DELETE FROM matching_results WHERE periode = ${periode}`;

    // Step 4: Process each satker independently
    const now = new Date().toISOString();
    const globalUsed: Record<string, boolean> = {};
    let totalMatched = 0, totalUnmatched = 0, totalOrphan = 0;

    for (const { kode_satker } of satkerRows) {
      // Load realisasi for this satker only
      const realAll = await this.sql`
        SELECT kode_paket, kode_rup, kode_satker, nama_satker, nama_paket, metode_pengadaan, nilai_kontrak
        FROM realisasi_records WHERE periode = ${periode} AND kode_satker = ${kode_satker}`;

      // Load RUP for this satker only (for heuristic matching)
      const rupSatker = await this.sql`
        SELECT kode_rup, kode_satker, nama_satker, nama_paket, metode_pengadaan, pagu
        FROM rup_records WHERE periode = ${periode} AND kode_satker = ${kode_satker}`;

      // Prepare heuristic index for this satker
      const rupSatkerIdx: any[] = [];
      for (const r of rupSatker) {
        rupSatkerIdx.push({ ...r, _nl: String(r.nama_paket ?? "").toLowerCase() });
      }

      const rows: Record<string, any>[] = [];
      const localUsed: Record<string, boolean> = {};
      let matched = 0, unmatched = 0, orphan = 0;
      const deferred: { real: any; idx: number }[] = [];

      // Process each realisasi record
      for (const real of realAll) {
        const kruRaw = blank(real.kode_rup) ? null : String(real.kode_rup).trim();
        const parts = N.splitKodeRup(kruRaw);
        let statusM = "UNMATCHED";
        let metode = "UNMATCHED";
        const refs: any[] = [];
        let sim: number | null = null;

        if (parts.length > 0) {
          // Exact kode_rup matching (global index)
          for (const k of parts) {
            if (rupByKode[k]) {
              refs.push(rupByKode[k]);
              globalUsed[k] = true;
              localUsed[k] = true;
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
          // Heuristic matching (per-satker, Jaro-Winkler)
          const nama = blank(real.nama_paket) ? null : String(real.nama_paket).trim();
          if (nama && rupSatkerIdx.length > 0) {
            const nl = nama.toLowerCase();
            let best = 0, bestObj: any = null;
            for (const cand of rupSatkerIdx) {
              const kodes = N.splitKodeRup(cand.kode_rup);
              if (kodes.some((k: string) => globalUsed[k] || localUsed[k]) || blank(cand.nama_paket)) continue;
              const sc = jaroWinklerSimilarity(nl, cand._nl);
              if (sc > best && sc >= SIMILARITY_THRESHOLD) { best = sc; bestObj = cand; }
            }
            if (bestObj) {
              refs.push(bestObj);
              statusM = "MATCHED"; metode = "HEURISTIC";
              sim = Math.round(best * 1000) / 1000;
              for (const k of N.splitKodeRup(bestObj.kode_rup)) {
                globalUsed[k] = true;
                localUsed[k] = true;
              }
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

      // Fallback: HEURISTIC_NAMA_KODE_BEDA (per-satker)
      const normNama = (t: any) => String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const normMetode = (t: any) => String(t ?? "").toLowerCase().replace(/[^a-z]+/g, "");
      const claimed: Record<string, boolean> = {};

      for (const { real, idx } of deferred) {
        const nama = normNama(real.nama_paket);
        if (nama === "") continue;
        const mReal = normMetode(real.metode_pengadaan);
        const cands: any[] = [];
        for (const cand of rupSatkerIdx) {
          const ids = N.splitKodeRup(cand.kode_rup);
          const anyUsed = ids.some((k: string) => globalUsed[k] || localUsed[k]);
          const anyClaimed = ids.some((k: string) => claimed[k]);
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
        for (const k of N.splitKodeRup(rup.kode_rup)) {
          globalUsed[k] = true;
          localUsed[k] = true;
          claimed[k] = true;
        }
        unmatched--; matched++;
      }

      // Orphan RUP for this satker
      for (const r of rupSatker) {
        if (N.splitKodeRup(r.kode_rup).some((k: string) => globalUsed[k])) continue;
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

      // Insert results for this satker immediately (small batch)
      if (rows.length > 0) {
        await this.insertBatch(rows);
      }

      totalMatched += matched;
      totalUnmatched += unmatched;
      totalOrphan += orphan;
    }

    console.log(`[matching] Done: matched=${totalMatched} unmatched=${totalUnmatched} orphan=${totalOrphan}`);
    return { matched: totalMatched, unmatched: totalUnmatched, orphan: totalOrphan };
  }

  // Insert matching results in small chunks (no big transaction)
  private async insertBatch(rows: Record<string, any>[]): Promise<void> {
    if (rows.length === 0) return;
    const columns = Object.keys(rows[0]);
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50);
      const placeholders = chunk.map((row, ri) =>
        `(${columns.map((_, ci) => `$${ri * columns.length + ci + 1}`).join(",")})`
      ).join(",");
      const values = chunk.flatMap(row => columns.map(c => (row as any)[c] ?? null));
      await this.sql.unsafe(
        `INSERT INTO matching_results (${columns.map(c => `"${c}"`).join(",")}) VALUES ${placeholders}`,
        values
      );
    }
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
