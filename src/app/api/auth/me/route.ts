import { NextRequest } from "next/server";
import { withAuth, sanitizeUser } from "@/lib/auth";
import { connectToCatalogDb } from "@/lib/db/catalog";
import { getUserModel } from "@/models/catalog/User";
import { success, notFound, serverError } from "@/lib/api-handling/api-response";

export const GET = withAuth(async (_req: NextRequest, ctx) => {
  try {
    const conn = await connectToCatalogDb();
    const User = getUserModel(conn.connection);

    const user = await User.findById(ctx.user.sub).select("-sessions -password");

    if (!user) {
      return notFound("User not found");
    }

    return success({ user: sanitizeUser(user) });
  } catch (err) {
    console.error("[/api/auth/me] Error:", err);
    return serverError();
  }
});
