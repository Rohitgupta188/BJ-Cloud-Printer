import mongoose, { Connection, Model } from "mongoose";

export interface ISession {
  sessionId: string;
  refreshTokenHash: string;
  lastRefreshTokenHash: string | null;
  refreshTokenRotatedAt: Date | null;
  userAgent?: string;
  createdAt: Date;
}

export interface IUser {
  _id: mongoose.Types.ObjectId;
  username: string;
  email: string;
  password: string;
  role: "admin" | "employee";
  sessions: ISession[];
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new mongoose.Schema<IUser>(
  {},
  {
    collection: "users",
    strict: false,
  }
)

export function getUserModel(conn: Connection): Model<IUser> {
  return (
    (conn.models.User as Model<IUser>) ??
    conn.model<IUser>("User", UserSchema)
  );
}