// monitor.js — paste this at the bottom of socket.js or import it

import { workers } from "./mediasoup/worker.js";

setInterval(async () => {
  console.log("\n═══════ WORKER MONITOR ═══════");

  for (let i = 0; i < workers.length; i++) {
    const worker = workers[i];
    try {
      const usage = await worker.getResourceUsage();
      console.log(
        `Worker ${i} (pid:${worker.pid}): ` +
        `CPU user=${Math.round(usage.ru_utime / 1000)}ms ` +
        `sys=${Math.round(usage.ru_stime / 1000)}ms`
      );
    } catch (e) {
      console.log(`Worker ${i}: error getting stats`);
    }
  }

  // count per room
  for (const [roomId, room] of rooms) {
    let totalProducers = 0;
    let totalConsumers = 0;
    let perWorker = new Array(workers.length).fill(0);

    for (const [, student] of room.students) {
      totalProducers += student.producers.length;
      perWorker[student.workerIndex] += student.producers.length;
    }

    // count transports per worker
    let transportPerWorker = new Array(workers.length).fill(0);
    for (const [, entry] of room.transports) {
      transportPerWorker[entry.workerIndex]++;
    }

    console.log(`Room "${roomId}":`);
    console.log(`  Members: ${room.members.size}`);
    console.log(`  Students: ${room.students.size}`);
    console.log(`  Total producers: ${totalProducers}`);
    console.log(`  Producers per worker: [${perWorker.join(", ")}]`);
    console.log(`  Transports per worker: [${transportPerWorker.join(", ")}]`);
  }

  console.log("══════════════════════════════\n");
}, 10000);