import { NextRequest, NextResponse } from "next/server";
import { withAuth, sanitizeUser } from "@/lib/auth";
import { connectToCatalogDb } from "@/lib/db/catalog";
import { getUserModel } from "@/models/catalog/User";

export const GET = withAuth(async (_req: NextRequest, ctx) => {
  try {
    const conn = await connectToCatalogDb();
    const User = getUserModel(conn.connection);

    const user = await User.findById(ctx.user.sub).select("-sessions -password");

    if (!user) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { success: true, data: { user: sanitizeUser(user) } },
      { status: 200 }
    );
  } catch (err) {
    console.error("[/api/auth/me] Error:", err);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
});
