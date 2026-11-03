import mongoose, { Connection, Model } from "mongoose";

export interface IImageIndex {
  _id: mongoose.Types.ObjectId;
  fileId: string;
  imageName: string;
  mimeType: string;
  parentFolderId: string;
  backblazePath: string | null;
  imageUrl: string | null;
  imageMd5: string | null;
  uploadStatus: "PENDING" | "UPLOADING" | "UPLOADED" | "FAILED";
  createdAt: Date;
  updatedAt: Date;
}

const ImageIndexSchema = new mongoose.Schema<IImageIndex>(
  {},
  {
    collection: "image_index",
    strict: false,
  }
);

export function getImageIndexModel(conn: Connection): Model<IImageIndex> {
  return (
    (conn.models.ImageIndex as Model<IImageIndex>) ??
    conn.model<IImageIndex>("ImageIndex", ImageIndexSchema)
  );
}

