import mongoose from "mongoose";
import { getPrintJobModel } from "@/models/printer/PrintJob";
import { getPrinterSessionModel } from "@/models/printer/PrinterSession";
import { getSkuSequenceModel } from "@/models/printer/SkuSequence";

const PRINTER_MONGODB_URI = process.env.PRINTER_MONGODB_URI;

if (!PRINTER_MONGODB_URI) {
  throw new Error("[printer-db] PRINTER_MONGODB_URI is not defined in .env.local");
}

interface ConnectionCache {
  conn: mongoose.Connection | null;
  promise: Promise<mongoose.Connection> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __printerConnectionCache: ConnectionCache | undefined;
}

const cache: ConnectionCache = global.__printerConnectionCache ?? {
  conn: null,
  promise: null,
};

global.__printerConnectionCache = cache;

const OPTS: mongoose.ConnectOptions = {
  bufferCommands: false,
  maxPoolSize: 5,
  serverSelectionTimeoutMS: 15_000,
  socketTimeoutMS: 45_000,
};

export async function connectToPrinterDb(): Promise<{ connection: mongoose.Connection }> {
  if (cache.conn && cache.conn.readyState === 1) {
    return { connection: cache.conn };
  }

  if (!cache.promise) {
    cache.promise = mongoose
      .createConnection(PRINTER_MONGODB_URI as string, OPTS)
      .asPromise()
      .then((conn) => {
        console.log("[printer-db] Connected to BJ-Printer MongoDB.");
        cache.conn = conn;
        return conn;
      })
      .catch((err) => {
        console.error("[printer-db] Connection error:", err);
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

export async function getPrinterModels() {
  const { connection } = await connectToPrinterDb();
  return {
    PrintJob: getPrintJobModel(connection),
    PrinterSession: getPrinterSessionModel(connection),
    SkuSequence: getSkuSequenceModel(connection),
  };
}
