// Supabase Edge Function: dashboard-api
// Converted from Laravel PHP backend to Deno/TypeScript
// Single RPC endpoint: POST {action, ...payload}

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";

// ─── Import modules ───────────────────────────────────────────
import { Api, ApiException } from "./lib/api.ts";
import { DashboardAuth } from "./lib/auth.ts";
import { PeriodeService } from "./services/periode.ts";
import { UploadService } from "./services/upload.ts";
import { MatchingService } from "./services/matching.ts";
import { ListingService } from "./services/listing.ts";
import { DashboardQueryService } from "./services/dashboard_query.ts";
import { SandinganService } from "./services/sandingan.ts";
import { AnalisisService } from "./services/analisis.ts";
import { RekapService } from "./services/rekap.ts";
import { MenuNoticeService } from "./services/menu_notice.ts";

// ─── Database connection ──────────────────────────────────────
const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL")
  ?? Deno.env.get("DATABASE_URL")
  ?? "";

const sql = postgres(DATABASE_URL, { max: 5 });

// ─── Action registry ──────────────────────────────────────────
// [handlerFn, requiresAdmin]
type ActionEntry = [(p: Record<string, any>) => Promise<any>, boolean];

function buildActions(sql: any): Record<string, ActionEntry> {
  const auth = new DashboardAuth();
  const periodes = new PeriodeService(sql);
  const matchingSvc = new MatchingService(sql);
  const uploadSvc = new UploadService(sql, matchingSvc);
  const listingSvc = new ListingService(sql, periodes);
  const dashboardQuery = new DashboardQueryService(sql, periodes);
  const sandinganSvc = new SandinganService(sql, periodes);
  const analisisSvc = new AnalisisService(sql, periodes, sandinganSvc);
  const rekapSvc = new RekapService(sql, periodes, sandinganSvc);
  const menuNotice = new MenuNoticeService(sql);

  return {
    verifyToken:        [p => auth.verify(p),                    false],
    listPeriode:        [p => periodes.listPeriode(p),           false],
    getUploadLog:       [p => periodes.getUploadLog(p),          false],
    deletePeriode:      [p => periodes.deletePeriode(p),         true],
    deleteByLog:        [p => periodes.deleteByLog(p),           true],

    uploadRUP:          [p => uploadSvc.uploadRup(p),            true],
    uploadRealisasi:    [p => uploadSvc.uploadRealisasi(p),      true],
    runMatching:        [p => matchingSvc.handleRun(p),          true],

    listRUP:            [p => listingSvc.listRup(p),             false],
    listRealisasi:      [p => listingSvc.listRealisasi(p),       false],

    kpiDashboard:       [p => dashboardQuery.kpi(p),             false],
    dashboardOPD:       [p => dashboardQuery.opd(p),             false],
    dashboardMetode:    [p => dashboardQuery.metode(p),          false],
    dashboardStatus:    [p => dashboardQuery.status(p),          false],
    dashboardSumber:    [p => dashboardQuery.sumber(p),          false],
    dashboardPenyedia:  [p => dashboardQuery.penyedia(p),        false],
    dashboardEfisiensi: [p => dashboardQuery.efisiensi(p),       false],
    dashboardTren:      [p => dashboardQuery.tren(p),            false],
    detailPaket:        [p => dashboardQuery.detailPaket(p),     false],

    listSandingan:      [p => sandinganSvc.list(p),              false],

    listEfisiensi:            [p => analisisSvc.listEfisiensi(p),           false],
    listEfisiensiDetail:      [p => analisisSvc.listEfisiensiDetail(p),     false],
    dashboardAnalisisCharts:  [p => analisisSvc.charts(p),                  false],
    dashboardAnalisisDetail:  [p => analisisSvc.analisisDetail(p),          false],
    listEfisiensiExcludeMetode: [p => analisisSvc.listExcludeMetode(p),     false],
    saveEfisiensiExcludeMetode: [p => analisisSvc.saveExcludeMetode(p),     true],
    listManualPagu:           [p => analisisSvc.listManualPagu(p),          false],

    laporanRekap:             [p => rekapSvc.laporanRekap(p),              false],
    recapJenisPengadaan:      [p => rekapSvc.recapJenisPengadaan(p),       false],

    listMenuNotice:     [p => menuNotice.list(p),                false],
    saveMenuNotice:     [p => menuNotice.save(p),                true],
  };
}

// ─── CORS headers ─────────────────────────────────────────────
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-info, apikey",
  "Content-Type": "application/json",
};

// ─── Main handler ─────────────────────────────────────────────
serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify(Api.error("Method not allowed", 405)), {
      status: 405, headers: CORS_HEADERS,
    });
  }

  try {
    const text = await req.text();
    const payload = JSON.parse(text);
    const action = String(payload.action ?? "");

    const actions = buildActions(sql);
    const entry = actions[action];

    if (!entry) {
      return new Response(
        JSON.stringify(Api.error(`Action belum tersedia: ${action}`, 400)),
        { status: 200, headers: CORS_HEADERS },
      );
    }

    const [handler, adminOnly] = entry;

    if (adminOnly && !DashboardAuth.check(payload.token ?? null)) {
      return new Response(
        JSON.stringify(Api.error("Token tidak valid.", 401)),
        { status: 200, headers: CORS_HEADERS },
      );
    }

    const result = await handler(payload);
    return new Response(JSON.stringify(result), {
      status: 200, headers: CORS_HEADERS,
    });
  } catch (e) {
    if (e instanceof ApiException) {
      return new Response(
        JSON.stringify(Api.error(e.message, e.apiCode)),
        { status: 200, headers: CORS_HEADERS },
      );
    }
    const errMsg = e instanceof Error ? e.message : String(e);
    const errStack = e instanceof Error ? e.stack : "";
    console.error("dashboard-api error:", errMsg, errStack);
    return new Response(
      JSON.stringify(Api.error(errMsg + (errStack ? " | " + errStack.split("\n").slice(0, 3).join(" ") : ""), 500)),
      { status: 200, headers: CORS_HEADERS },
    );
  }
});
