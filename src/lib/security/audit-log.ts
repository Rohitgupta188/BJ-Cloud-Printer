export type AuditEventName =
  | "AUTH_LOGIN_SUCCESS"
  | "AUTH_LOGIN_FAILURE"
  | "AUTH_LOGOUT"
  | "AUTH_TOKEN_ROTATED"
  | "AUTH_REFRESH_REUSE_DETECTED"
  | "RATE_LIMIT_EXCEEDED"
  | "CSRF_VALIDATION_FAILED"
  | "IP_RESOLUTION_FAILED";

type LogLevel = "info" | "warn" | "error";

const EVENT_LEVEL: Record<AuditEventName, LogLevel> = {
  AUTH_LOGIN_SUCCESS:           "info",
  AUTH_LOGOUT:                  "info",
  AUTH_TOKEN_ROTATED:           "info",
  AUTH_LOGIN_FAILURE:           "warn",
  RATE_LIMIT_EXCEEDED:          "warn",
  CSRF_VALIDATION_FAILED:       "warn",
  IP_RESOLUTION_FAILED:         "warn",
  AUTH_REFRESH_REUSE_DETECTED:  "error",
};

export interface AuditEventPayload {
  ip: string | null;
  userId?: string;
  sid?: string;
  traceId?: string;
  context?: Record<string, string | number | boolean | null>;
}

export interface AuditRequest {
  url: string;
  method: string;
  headers: { get(name: string): string | null };
}

function sanitizeUserAgent(ua: string | null): string | null {
  if (!ua) return null;
  return ua.replace(/[\r\n\t]/g, " ").slice(0, 200);
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.slice(0, 200);
  }
}

export const auditLog = {
  emit(
    event: AuditEventName,
    request: AuditRequest,
    payload: AuditEventPayload
  ): void {
    const level = EVENT_LEVEL[event];

    const entry = {
      level,
      service: "security",
      event,
      ip: payload.ip,
      ...(payload.userId !== undefined && { userId: payload.userId }),
      ...(payload.sid     !== undefined && { sid: payload.sid }),
      url:       safePathname(request.url),
      method:    request.method,
      userAgent: sanitizeUserAgent(request.headers.get("user-agent")),
      traceId:   payload.traceId ?? crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...(payload.context !== undefined && { context: payload.context }),
    };

    const line = JSON.stringify(entry);

    switch (level) {
      case "info":  console.info(line);  break;
      case "warn":  console.warn(line);  break;
      case "error": console.error(line); break;
    }
  },
};
