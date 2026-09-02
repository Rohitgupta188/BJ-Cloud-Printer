
import { Schema, Model, Connection, InferSchemaType } from "mongoose";

const SkuSequenceSchema = new Schema(
  {
    prefix: { type: String, required: true, unique: true, uppercase: true, trim: true },
    seq: { type: Number, required: true, default: 0, min: 0 },
  },
  {
    timestamps: { createdAt: false, updatedAt: true },
  }
);

export type ISkuSequence = InferSchemaType<typeof SkuSequenceSchema>;

export function getSkuSequenceModel(conn: Connection): Model<ISkuSequence> {
  return (
    (conn.models.SkuSequence as Model<ISkuSequence>) ??
    conn.model<ISkuSequence>("SkuSequence", SkuSequenceSchema)
  );
}
