// mediasoup/worker.js
import mediasoup from "mediasoup";
import { config } from "./config.js";
import { setWorkers } from "./getworker.js";

export async function createWorkers() {
    const numWorkers = config.mediasoup.numworker || 1;
    console.log(`[WORKER] Creating ${numWorkers} workers...`);

    const workers = [];

    for (let i = 0; i < numWorkers; i++) {
        const worker = await mediasoup.createWorker({
            rtcMinPort: config.mediasoup.worker.rtcMinPort,
            rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
            logLevel: config.mediasoup.worker.logLevel,
            logTags: config.mediasoup.worker.logTags,
        });

        worker.on("died", () => {
            console.error(`[WORKER] Worker ${worker.pid} DIED! Restarting...`);
            process.exit(1);
        });

        workers.push(worker);
        console.log(`[WORKER] #${i} created (pid: ${worker.pid})`);
    }

    // register with getworker module
    setWorkers(workers);

    return workers;
}