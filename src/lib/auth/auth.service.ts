import { getCatalogModels } from "@/lib/db/catalog";
import { getPrinterModels } from "@/lib/db/printer";
import { type IUser } from "@/models/catalog/User";
import { verifyPassword } from "./password";
import { signTokenPair, hashToken, verifyToken, type JwtPayload } from "./jwt";
import { clearAuthCookies } from "./cookies";

type AuthResult =
  | { 
      ok: true;
      user: IUser;
      accessToken: string;
      refreshToken: string;
      sid: string;
    }
  | {
      ok: false;
      error: string;
      status: number;
      code?: string;
    };

const MAX_SESSIONS = 5;
const CONCURRENT_REFRESH_GRACE_MS = 60_000;

async function pruneOldSessions(userId: string): Promise<void> {
  const { PrinterSession } = await getPrinterModels();

  const sessions = await PrinterSession.find({ userId })
    .sort({ createdAt: -1 })
    .select("_id")
    .lean();

  if (sessions.length > MAX_SESSIONS) {
    const idsToDelete = sessions.slice(MAX_SESSIONS).map((s) => s._id);
    await PrinterSession.deleteMany({ _id: { $in: idsToDelete } });
  }
}

export async function loginUser(data: {
  email: string;
  password: string;
}): Promise<AuthResult> {
  const { User } = await getCatalogModels();

  const user = await User.findOne({ email: data.email.toLowerCase() }).select(
    "+password"
  );

  if (!user) {
    return { ok: false, error: "INVALID_CREDENTIALS", status: 401 };
  }

  const isValid = await verifyPassword(data.password, user.password);
  if (!isValid) {
    return { ok: false, error: "INVALID_CREDENTIALS", status: 401 };
  }

  const tokenBase: Omit<JwtPayload, "type" | "sid"> = {
    sub: user._id.toString(),
    email: user.email,
    username: user.username,
    role: user.role,
  };

  const { accessToken, refreshToken, sid } = await signTokenPair(tokenBase);
  const refreshTokenHash = await hashToken(refreshToken);

  const { PrinterSession } = await getPrinterModels();

  await PrinterSession.create({
    userId: user._id.toString(),
    sessionId: sid,
    refreshTokenHash,
  });

  await pruneOldSessions(user._id.toString());

  return { ok: true, user, accessToken, refreshToken, sid };
}

export async function logoutUser(userId: string, sid?: string): Promise<void> {
  const { PrinterSession } = await getPrinterModels();

  if (sid) {
    await PrinterSession.deleteOne({ userId, sessionId: sid });
  } else {
    await PrinterSession.deleteMany({ userId });
  }
}

export function sanitizeUser(user: IUser) {
  return {
    id: user._id.toString(),
    username: user.username,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export async function rotateRefreshToken(
  incomingRefreshToken: string
): Promise<AuthResult> {
  const verifyResult = await verifyToken(incomingRefreshToken, "refresh");
  if (!verifyResult.ok) {
    await clearAuthCookies();
    return { ok: false, error: "Invalid refresh token", status: 401 };
  }

  const { sub, email, username, sid, role } = verifyResult.payload;

  if (!sid || !sub) {
    await clearAuthCookies();
    return { ok: false, error: "Token payload invalid", status: 401 };
  }

  const { User } = await getCatalogModels();
  const user = await User.findById(sub);

  if (!user) {
    return {
      ok: false,
      error: "Invalid user",
      status: 401,
    };
  }

  const { PrinterSession } = await getPrinterModels();
  const session = await PrinterSession.findOne({ userId: sub, sessionId: sid });

  if (!user || !session) {
    await clearAuthCookies();
    return {
      ok: false,
      error: "Session expired. Please log in again.",
      status: 401,
    };
  }

  const incomingHash = await hashToken(incomingRefreshToken);

  if (incomingHash !== session.refreshTokenHash) {
    const isWithinGrace =
      session.lastRefreshTokenHash &&
      incomingHash === session.lastRefreshTokenHash &&
      session.refreshTokenRotatedAt &&
      Date.now() - new Date(session.refreshTokenRotatedAt).getTime() <
        CONCURRENT_REFRESH_GRACE_MS;

    if (isWithinGrace) {
      console.warn(
        `[auth] Concurrent refresh within grace window: user sid`
      );
      return {
        ok: false,
        error: "Concurrent refresh in progress",
        status: 409,
        code: "CONCURRENT_REFRESH",
      };
    }

    console.error(
      `[auth] Refresh token reuse detected — revoking session: user sid`
    );
    await PrinterSession.deleteOne({ userId: sub, sessionId: sid });
    await clearAuthCookies();
    return {
      ok: false,
      error: "Session invalid. Please log in again.",
      status: 401,
    };
  }

  const { accessToken, refreshToken, sid: newSid } = await signTokenPair({
    sub,
    email: user.email,
    username: user.username,
    role: user.role,
    sid,
  });

  const newRefreshTokenHash = await hashToken(refreshToken);
  const updatedSession = await PrinterSession.findOneAndUpdate(
    {
      userId: sub,
      sessionId: sid,
      refreshTokenHash: incomingHash,
    },
    {
      $set: {
        refreshTokenHash: newRefreshTokenHash,
        lastRefreshTokenHash: incomingHash,
        refreshTokenRotatedAt: new Date(),
      },
    },
    { new: true }
  );

  if (!updatedSession) {
    console.warn(
      `[auth] Atomic rotation lost race: user sid`
    );
    return {
      ok: false,
      error: "Concurrent refresh in progress",
      status: 409,
      code: "CONCURRENT_REFRESH",
    };
  }

  return {
    ok: true,
    user,
    accessToken,
    refreshToken,
    sid: newSid,
  };
}
