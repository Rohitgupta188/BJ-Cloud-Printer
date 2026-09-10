import mqtt, { MqttClient } from "mqtt";

export interface MqttPrintJobPayload {
  job_id: string;
  sku: string;
  printer_id: string;
  payload_type: "TSPL" | "ZPL";
  payload: string;
}

interface ClientCache {
  client: MqttClient | null;
  connectPromise: Promise<MqttClient> | null;
}

declare global {
  var __mqttPublisherCache: ClientCache | undefined;
}

const cache: ClientCache = global.__mqttPublisherCache ?? {
  client: null,
  connectPromise: null,
};

global.__mqttPublisherCache = cache;

const INSTANCE_SUFFIX = crypto.randomUUID().replace(/-/g, "").slice(0, 8);

async function getClient(): Promise<MqttClient> {
  const host = process.env.MQTT_HOST;
  const port = process.env.MQTT_PORT ?? "8883";
  const username = process.env.MQTT_USERNAME;
  const password = process.env.MQTT_PASSWORD;
  const baseId = process.env.MQTT_CLIENT_ID ?? "bj-printer-cloud";

  if (!host || !username || !password) {
    throw new Error(
      "[mqtt/publisher] Missing required env vars: MQTT_HOST, MQTT_USERNAME, MQTT_PASSWORD"
    );
  }

  const clientId = `${baseId}-${INSTANCE_SUFFIX}`;

  if (cache.client && cache.client.connected) {
    return cache.client;
  }

  if (cache.connectPromise) {
    return cache.connectPromise;
  }

  const brokerUrl = `mqtts://${host}:${port}`;

  console.log(
    `[mqtt/publisher] Connecting to ${brokerUrl} as client="${clientId}"`
  );

  cache.connectPromise = mqtt.connectAsync({
    protocol: "mqtts",
    host,
    port: Number(port),
    username,
    password,
    clientId,
    clean: true,
    reconnectPeriod: 5_000,
    connectTimeout: 15_000,
  })

    .then((client) => {
      cache.client = client;
      cache.connectPromise = null;

      console.log(`[mqtt/publisher] Connected to HiveMQ (clientId="${clientId}").`);

      client.on("connect", () => {
        console.log(`[mqtt/publisher] (Re)connected to HiveMQ (clientId="${clientId}").`);
      });

      client.on("error", (err) => {
        console.error("[mqtt/publisher] Client error:", err);
      });

      client.on("reconnect", () => {
        console.log("[mqtt/publisher] Attempting reconnect to HiveMQ…");
      });

      client.on("offline", () => {
        console.warn("[mqtt/publisher] Client offline — will retry automatically.");
      });

      client.on("close", () => {
        console.warn("[mqtt/publisher] Connection closed — auto-reconnect pending.");
      });

      return client;
    })
    .catch((err) => {
      cache.connectPromise = null;
      cache.client = null;
      console.error("[mqtt/publisher] Failed to connect to HiveMQ:", err);
      throw err;
    });

  return cache.connectPromise;
}

export async function publishPrintJob(job: MqttPrintJobPayload): Promise<void> {
  const topic = `printers/${job.printer_id}/jobs`;
  const message = JSON.stringify(job);

  console.log(
    `[mqtt/publisher] Publishing job_id="${job.job_id}" sku="${job.sku}" ` +
    `to topic="${topic}" qos=1`
  );

  const client = await getClient();

  await client.publishAsync(topic, message, { qos: 1 });

  console.log(
    `[mqtt/publisher] PUBACK received for job_id="${job.job_id}" — broker acknowledged.`
  );
}

