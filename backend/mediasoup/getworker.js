// mediasoup/getworker.js
import { config } from "./config.js";

let workers = [];
let nextWorkerIndex = 0;

export function setWorkers(w) {
    workers = w;
    console.log(`[WORKER] ${workers.length} workers registered`);
}

export async function createRouterOnWorker() {
    if (workers.length === 0) {
        throw new Error("No workers available — createWorkers() not called yet");
    }

    // Round-robin: pick next worker
    const worker = workers[nextWorkerIndex];
    console.log(`[ROUTER] Using worker ${nextWorkerIndex} (pid: ${worker.pid})`);
    nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;

    const router = await worker.createRouter({
        mediaCodecs: config.mediasoup.router.mediaCodecs,
    });

    console.log(`[ROUTER] Created (id: ${router.id.slice(0, 8)})`);
    return router;
}