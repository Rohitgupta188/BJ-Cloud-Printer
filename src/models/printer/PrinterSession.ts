import { Schema, model, models, Model, InferSchemaType, Connection } from "mongoose";

const PrinterSessionSchema = new Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },

    sessionId: {
      type: String,
      required: true,
      unique: true,
    },

    refreshTokenHash: {
      type: String,
      required: true,
    },

    lastRefreshTokenHash: {
      type: String,
      default: null,
    },

    refreshTokenRotatedAt: {
      type: Date,
      default: null,
    },

    lastRefreshAt: {
      type: Date,
      default: () => new Date(),
    },

    userAgent: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

PrinterSessionSchema.index({ userId: 1, sessionId: 1 });

PrinterSessionSchema.index(
  { lastRefreshAt: 1 },
  { expireAfterSeconds: 7 * 24 * 60 * 60 } // 7 days
);


export type IPrinterSession = InferSchemaType<typeof PrinterSessionSchema>;

export function getPrinterSessionModel(conn: Connection): Model<IPrinterSession> {
  return (
    (conn.models.PrinterSession as Model<IPrinterSession>) ??
    conn.model<IPrinterSession>("PrinterSession", PrinterSessionSchema)
  );
}
