import { config } from "./config.js";
import { workers } from "./worker.js";

export async function createRouterOnWorker(workerIndex) {
  const worker = workers[workerIndex];
  if (!worker) throw new Error(`No worker at index ${workerIndex}`);

  const router = await worker.createRouter({
    mediaCodecs: config.mediasoup.router.mediaCodecs,
  });
  return router;
}