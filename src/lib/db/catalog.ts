import mongoose from "mongoose";
import { getUserModel } from "@/models/catalog/User";
import { getCatalogModel } from "@/models/catalog/Catalog";

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  throw new Error("[catalog-db] MONGODB_URI is not defined in .env.local");
}

interface ConnectionCache {
  conn: mongoose.Connection | null;
  promise: Promise<mongoose.Connection> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __catalogConnectionCache: ConnectionCache | undefined;
}

const cache: ConnectionCache = global.__catalogConnectionCache ?? {
  conn: null,
  promise: null,
};

global.__catalogConnectionCache = cache;

const OPTS: mongoose.ConnectOptions = {
  bufferCommands: false,
  maxPoolSize: 5,
  serverSelectionTimeoutMS: 15_000,
  socketTimeoutMS: 45_000,
};

export async function connectToCatalogDb(): Promise<{ connection: mongoose.Connection }> {
  if (cache.conn && cache.conn.readyState === 1) {
    return { connection: cache.conn };
  }

  if (!cache.promise) {
    cache.promise = mongoose
      .createConnection(MONGODB_URI as string, OPTS)
      .asPromise()
      .then((conn) => {
        console.log("[catalog-db] Connected to BJ-Dashboard MongoDB.");
        cache.conn = conn;
        return conn;
      })
      .catch((err) => {
        console.error("[catalog-db] Connection error:", err);
        cache.promise = null;
        throw err;
      });
  }

  try {
    const conn = await cache.promise;
    cache.conn = conn;
    return { connection: conn };
  } catch (err) {
    cache.promise = null;
    throw err;
  }
}

export async function getCatalogModels() {
  const { connection } = await connectToCatalogDb();
  return {
    User: getUserModel(connection),
    Catalog: getCatalogModel(connection),
  };
}
