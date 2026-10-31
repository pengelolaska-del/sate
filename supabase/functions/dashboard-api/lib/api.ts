// ─── Api response envelope & exception ────────────────────────

export class ApiException extends Error {
  constructor(message: string, public apiCode: number = 400) {
    super(message);
  }
}

export const Api = {
  ok(data?: any, message?: string): Record<string, any> {
    const out: Record<string, any> = { status: "success", code: 200 };
    if (message != null) out.message = message;
    if (data != null) out.data = data;
    return out;
  },
  error(message: string, code = 400, extra?: Record<string, any>): Record<string, any> {
    return { status: "error", code, message, ...extra };
  },
};
