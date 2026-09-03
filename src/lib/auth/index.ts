/**
 * index.ts — barrel export for the auth library.
 *
 * Import auth utilities from "@/lib/auth" rather than individual files
 * to avoid deep import paths in route handlers.
 */

export {
  signTokenPair,
  hashToken,
  verifyToken,
  type JwtPayload,
  type VerifyResult,
} from "./jwt";

export {
  setAuthCookies,
  getAccessToken,
  getRefreshToken,
  clearAuthCookies,
  ACCESS_COOKIE,
  REFRESH_COOKIE,
} from "./cookies";

export { hashPassword, verifyPassword } from "./password";

export {
  withAuth,
  getCurrentUser,
  type AuthenticatedRequest,
  type AuthOptions,
} from "./with-auth";

export {
  loginUser,
  logoutUser,
  sanitizeUser,
  rotateRefreshToken,
} from "./auth.service";
