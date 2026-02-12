import mediasoup from "mediasoup";
import { config } from "./config.js";

export const workers = [];

export async function createWorkers() {
  if (workers.length > 0) return;
  const count = config.mediasoup.numWorkers;
  console.log(`Creating ${count} workers...`);

  for (let i = 0; i < count; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: config.mediasoup.worker.logLevel,
      logTags: config.mediasoup.worker.logTags,
      rtcMinPort: config.mediasoup.worker.rtcMinPort,
      rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
    });

    worker.on("died", () => {
      console.error(`Worker ${i} died!`);
      process.exit(1);
    });

    workers.push(worker);
    console.log(`  Worker ${i} pid=${worker.pid}`);
  }
}