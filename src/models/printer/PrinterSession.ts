import { Schema, model, models, Model, InferSchemaType } from "mongoose";

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

    userAgent: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

PrinterSessionSchema.index({ userId: 1, sessionId: 1 });

export type IPrinterSession = InferSchemaType<typeof PrinterSessionSchema>;

export const PrinterSession =
  (models.PrinterSession as Model<IPrinterSession>) ||
  model<IPrinterSession>("PrinterSession", PrinterSessionSchema);
