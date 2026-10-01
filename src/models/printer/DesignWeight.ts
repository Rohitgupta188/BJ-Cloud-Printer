import { Schema, Model, Connection, InferSchemaType } from "mongoose";

const DesignWeightSchema = new Schema(
  {
    designNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    reserved1: {
      type: String,
      trim: true,
    },
    reserved3: {
      type: String,
      trim: true,
    },
    grossWeight: {
      type: Number,
    },
    netWeight: {
      type: Number,
    },
    stoneWeight: {
      type: Number,
    },
    metalType: {
      type: String,
      trim: true,
    },
    metalPurity: {
      type: String,
      trim: true,
    },
    imageName: {
      type: String,
      trim: true,
    },
    imageUrl: {
      type: String,
      trim: true,
    },
  },
  {
    collection: "design_weights",
    timestamps: true,
  }
);

export type IDesignWeight = InferSchemaType<typeof DesignWeightSchema>;

export function getDesignWeightModel(conn: Connection): Model<IDesignWeight> {
  return (
    (conn.models.DesignWeight as Model<IDesignWeight>) ??
    conn.model<IDesignWeight>("DesignWeight", DesignWeightSchema)
  );
}
