import { Schema, model, models, Model, InferSchemaType, Connection } from "mongoose";

export type PrintJobStatus =
  | "PENDING"
  | "MQTT_PUBLISHED"
  | "AGENT_RECEIVED"
  | "COMPLETED"
  | "FAILED"
  | "UNKNOWN";

export type PayloadType = "TSPL" | "ZPL";


const PrintJobSchema = new Schema(
  {
    jobId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    sku: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    printerId: {
      type: String,
      required: true,
      trim: true,
    },
    payloadType: {
      type: String,
      enum: ["TSPL", "ZPL"] satisfies PayloadType[],
      required: true,
    },
    payload: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: [
        "PENDING",
        "MQTT_PUBLISHED",
        "AGENT_RECEIVED",
        "COMPLETED",
        "FAILED",
        "UNKNOWN",
      ] satisfies PrintJobStatus[],
      default: "PENDING",
      required: true,
    },
    mqttPublishedAt: {
      type: Date
    },
    retryCount: {
      type: Number,
      default: 0,
      min: 0
    },
    lastError: {
      type: String,
      trim: true
    },
    createdBy: {
      type: String,
      trim: true,
      required: true
    },
  },
  {
    timestamps: true,
  }
);

PrintJobSchema.index({ createdAt: -1 });
PrintJobSchema.index({ status: 1, createdAt: -1 });

export type IPrintJob = InferSchemaType<typeof PrintJobSchema>;

export function getPrintJobModel(conn: Connection): Model<IPrintJob> {
  return (
    (conn.models.PrintJob as Model<IPrintJob>) ||
    conn.model<IPrintJob>("PrintJob", PrintJobSchema)
  );
}
