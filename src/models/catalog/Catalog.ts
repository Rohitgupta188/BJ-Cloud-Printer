import mongoose, { Connection, Model } from "mongoose";

export interface ICatalog {
  _id: mongoose.Types.ObjectId;
  sku: string;
  designNumber: string;
  rfid: string;

  driveFileId?: string;

  imageName: string;
  storageProvider: "backblaze";
  storagePath: string;
  imageUrl?: string;
  imageMd5?: string;

  itemStatus: "CATALOGUE" | "INSTOCK";
  itemType?: string;

  isCatalog: boolean;
  isInstock: boolean;

  grossWeight: number;
  netWeight: number;
  stoneWeight: number;

  collectionLine: string;
  metalType: string;
  metalPurity: string;

  createdAt: Date;
  updatedAt: Date;
}

const CatalogSchema = new mongoose.Schema<ICatalog>(
  {},
  {
    collection: "catalogs",
    strict: false,
  }
)

export function getCatalogModel(conn: Connection): Model<ICatalog> {
  return (
    (conn.models.Catalog as Model<ICatalog>) ??
    conn.model<ICatalog>("Catalog", CatalogSchema)
  );
}