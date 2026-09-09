import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { applySecurityHeaders } from "@/lib/security";

type ApiResponseOptions = {
  status?: number;
  headers?: Record<string, string>;
};

export function success<T>(data: T, opts?: ApiResponseOptions) {
  return applySecurityHeaders(
    NextResponse.json(
      { success: true, data },
      { status: opts?.status ?? 200, headers: opts?.headers }
    )
  );
}

export function created<T>(data: T, opts?: ApiResponseOptions) {
  return success(data, { ...opts, status: 201 });
}

export function error(
  message: string,
  status = 400,
  details?: unknown,
  httpHeaders?: Record<string, string>
) {
  return applySecurityHeaders(
    NextResponse.json(
      { success: false, error: message, ...(details ? { details } : {}) },
      { status, headers: httpHeaders }
    )
  );
}

export function unauthorized(message = "Authentication required") {
  return error(message, 401);
}

export function forbidden(message = "CSRF validation failed") {
  return error(message, 403);
}

export function notFound(message = "Resource not found") {
  return error(message, 404);
}

export function conflict(message: string) {
  return error(message, 409);
}

export function tooManyRequests(message: string, httpHeaders?: Record<string, string>) {
  return error(message, 429, undefined, httpHeaders);
}

export function validationError(err: ZodError) {
  const formatted = err.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }));
  return error("Validation failed", 422, formatted);
}

export function validationFailed(
  issues: { field: string; message: string }[]
) {
  return error("Validation failed", 422, issues);
}

export function serverError(message = "Internal server error") {
  return error(message, 500);
}

export type ApiHandler = () => Promise<NextResponse>;

export async function handleRoute(handler: ApiHandler): Promise<NextResponse> {
  try {
    return await handler();
  } catch (err) {
    if (err instanceof ZodError) {
      return validationError(err);
    }
    console.error("[API Error]", err);
    return serverError();
  }
}
