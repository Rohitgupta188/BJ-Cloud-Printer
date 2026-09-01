import mongoose from "mongoose";

export interface ISession {
  sessionId: string;
  refreshTokenHash: string;
  lastRefreshTokenHash: string | null;
  refreshTokenRotatedAt: Date | null;
  userAgent?: string;
  createdAt: Date;
}

export interface IUser {
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

export const User =
  ( mongoose.models.User as mongoose.Model<IUser> ) ||
  mongoose.model<IUser>("User", UserSchema);