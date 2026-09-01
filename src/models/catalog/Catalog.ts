import mongoose from "mongoose";

export interface ICatalog {
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

export const Catalog =
  ( mongoose.models.Catalog as mongoose.Model<ICatalog> ) ||
  mongoose.model<ICatalog>("Catalog", CatalogSchema);