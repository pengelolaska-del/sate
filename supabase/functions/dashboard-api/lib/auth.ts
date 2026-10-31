import { Api } from "./api.ts";

const ADMIN_TOKEN = Deno.env.get("DASHBOARD_ADMIN_TOKEN") ?? "";

export class DashboardAuth {
  static check(token: any): boolean {
    const expected = ADMIN_TOKEN;
    if (!expected) return false;
    return expected === String(token ?? "");
  }

  async verify(p: Record<string, any>) {
    return DashboardAuth.check(p.token ?? null)
      ? Api.ok({ valid: true })
      : Api.error("Token tidak valid.", 401, { data: { valid: false } });
  }
}
