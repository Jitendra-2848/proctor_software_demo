import { io } from "./main_base/base.js";
import { config } from "./mediasoup/config.js";
import { createRouterOnWorker } from "./mediasoup/getworker.js";
import { createWorkers, workers } from "./mediasoup/worker.js";

const rooms = new Map();
let ready = false;

(async () => {
  await createWorkers();
  ready = true;
  console.log(`✅ ${workers.length} workers ready`);
})();

// ═══════════════════════════════════════════════════════════════
// ROOM STRUCTURE:
//
// room.routers = Map<workerIndex, router>
//   → one router per worker, created on demand
//
// room.students = Map<socketId, {
//   workerIndex,        ← which worker this student is on
//   producers: [{producer, kind, type}]
// }>
//
// room.transports = Map<transportId, {
//   transport,
//   workerIndex,        ← which worker this transport is on
//   ownerSocketId       ← who owns this transport
// }>
//
// room.pipes = Set<string>
//   → tracks which producer-to-router pipes exist
//     format: "producerId->workerIndex"
// ═══════════════════════════════════════════════════════════════

async function getOrCreateRoom(roomId) {
  if (rooms.has(roomId)) return rooms.get(roomId);

  const room = {
    routers: new Map(),
    students: new Map(),
    transports: new Map(),
    members: new Set(),
    pipes: new Set(),
  };

  rooms.set(roomId, room);
  console.log(`Room "${roomId}" created`);
  return room;
}

// get or create router on specific worker for this room
async function getRouterOnWorker(room, workerIndex) {
  if (room.routers.has(workerIndex)) {
    return room.routers.get(workerIndex);
  }

  const router = await createRouterOnWorker(workerIndex);
  room.routers.set(workerIndex, router);
  console.log(`  Router created on worker ${workerIndex}`);
  return router;
}

// pick least loaded worker for a new student
function pickWorkerForStudent(room) {
  const load = new Array(workers.length).fill(0);

  for (const [, student] of room.students) {
    load[student.workerIndex] += student.producers.length + 1;
  }

  // also count transports (consumers)
  for (const [, entry] of room.transports) {
    load[entry.workerIndex] += 1;
  }

  let minLoad = Infinity;
  let bestIdx = 0;
  for (let i = 0; i < load.length; i++) {
    if (load[i] < minLoad) {
      minLoad = load[i];
      bestIdx = i;
    }
  }

  return bestIdx;
}

// PIPE a producer from its worker to another worker's router
// so a proctor on worker B can consume a student on worker A
async function ensurePipe(room, producerId, fromWorkerIndex, toWorkerIndex) {
  if (fromWorkerIndex === toWorkerIndex) return; // same worker, no pipe needed

  const pipeKey = `${producerId}->${toWorkerIndex}`;
  if (room.pipes.has(pipeKey)) return; // already piped

  const fromRouter = room.routers.get(fromWorkerIndex);
  const toRouter = await getRouterOnWorker(room, toWorkerIndex);

  if (!fromRouter || !toRouter) return;

  try {
    await fromRouter.pipeToRouter({
      producerId,
      router: toRouter,
    });
    room.pipes.add(pipeKey);
    console.log(`  Piped producer ${producerId.slice(0, 8)} from worker ${fromWorkerIndex} → ${toWorkerIndex}`);
  } catch (err) {
    // might already be piped
    if (!err.message.includes("already exists")) {
      console.error(`  Pipe error: ${err.message}`);
    }
    room.pipes.add(pipeKey); // mark anyway to avoid retrying
  }
}

// ─── SOCKET HANDLING ─────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.data = {
    roomId: null,
    room: null,
    workerIndex: -1,
    transportIds: [],
    producers: [],
  };

  // ── JOIN ──
  socket.on("join", async (roomId) => {
    if (!ready) return socket.emit("error", "not ready");
    if (!roomId || typeof roomId !== "string") return;

    if (socket.data.roomId) {
      const firstRouter = room.routers.values().next().value;
      if (firstRouter) socket.emit("rtp", firstRouter.rtpCapabilities);
      return;
    }

    const room = await getOrCreateRoom(roomId);
    socket.data.roomId = roomId;
    socket.data.room = room;
    room.members.add(socket.id);
    socket.join(roomId);

    // make sure at least one router exists
    if (room.routers.size === 0) {
      await getRouterOnWorker(room, 0);
    }

    const firstRouter = room.routers.values().next().value;
    socket.emit("rtp", firstRouter.rtpCapabilities);

    console.log(`${socket.id} joined "${roomId}" (${room.members.size} members)`);
  });

  // ── CREATE TRANSPORT ──
  socket.on("createTransport", async (data, cb) => {
    if (typeof cb !== "function") return;
    const room = socket.data.room;
    if (!room) return cb({ error: "join first" });

    try {
      const tc = config.mediasoup.webRtcTransport;
      let workerIndex;

      if (data.type === "send") {
        // STUDENT: pick least loaded worker
        workerIndex = pickWorkerForStudent(room);
        socket.data.workerIndex = workerIndex;

        // register as student
        room.students.set(socket.id, {
          workerIndex,
          producers: [],
        });

        console.log(`${socket.id} assigned to worker ${workerIndex} (send)`);

      } else if (data.type === "recv" && typeof data.workerIndex === "number") {
        // PROCTOR: specific worker requested
        workerIndex = data.workerIndex;

      } else {
        // PROCTOR: first transport, use worker 0
        workerIndex = 0;
      }

      const router = await getRouterOnWorker(room, workerIndex);

      const transport = await router.createWebRtcTransport({
        listenIps: tc.listenIps,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: tc.initialAvailableOutgoingBitrate,
      });

      if (tc.maxIncomingBitrate) {
        try {
          await transport.setMaxIncomingBitrate(tc.maxIncomingBitrate);
        } catch (_) {}
      }

      room.transports.set(transport.id, {
        transport,
        workerIndex,
        ownerSocketId: socket.id,
      });
      socket.data.transportIds.push(transport.id);

      transport.on("routerclose", () => room.transports.delete(transport.id));

      cb({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        workerIndex,
      });

    } catch (err) {
      console.error("createTransport error:", err.message);
      cb({ error: err.message });
    }
  });

  // ── CONNECT TRANSPORT ──
  socket.on("connectTransport", async ({ transportId, dtlsParameters }, cb) => {
    if (typeof cb !== "function") return;
    const room = socket.data.room;
    if (!room) return cb({ error: "no room" });

    const entry = room.transports.get(transportId);
    if (!entry) return cb({ error: "not found" });
    if (entry.transport._connected) return cb({ connected: true });

    try {
      await entry.transport.connect({ dtlsParameters });
      entry.transport._connected = true;
      cb({ connected: true });
    } catch (err) {
      cb({ error: err.message });
    }
  });

  // ── PRODUCE ──
  socket.on("produce", async ({ transportId, kind, rtpParameters, appData }, cb) => {
    if (typeof cb !== "function") return;
    const room = socket.data.room;
    if (!room) return cb({ error: "no room" });

    const entry = room.transports.get(transportId);
    if (!entry) return cb({ error: "transport not found" });

    try {
      const producer = await entry.transport.produce({
        kind,
        rtpParameters,
        appData: appData || {},
      });

      const type = appData?.type || "camera";

      // store in student record
      const student = room.students.get(socket.id);
      if (student) {
        const oldIdx = student.producers.findIndex(
          (p) => p.kind === kind && p.type === type
        );
        if (oldIdx !== -1) {
          student.producers[oldIdx].producer.close();
          student.producers.splice(oldIdx, 1);
        }
        student.producers.push({ producer, kind, type });
      }

      socket.data.producers.push(producer);
      producer.on("transportclose", () => producer.close());

      // notify others with workerIndex
      socket.to(socket.data.roomId).emit("newProducer", {
        producerId: producer.id,
        socketId: socket.id,
        kind,
        type,
        workerIndex: entry.workerIndex,
      });

      cb({ id: producer.id });
      console.log(`${socket.id} producing ${kind} ${type} on worker ${entry.workerIndex}`);

    } catch (err) {
      cb({ error: err.message });
    }
  });

  // ── CONSUME ──
  socket.on("consume", async ({ producerId, rtpCapabilities, transportId }, cb) => {
    if (typeof cb !== "function") return;
    const room = socket.data.room;
    if (!room) return cb({ error: "no room" });

    const tEntry = room.transports.get(transportId);
    if (!tEntry) return cb({ error: "transport not found" });

    const consumerWorkerIndex = tEntry.workerIndex;

    // find which student has this producer
    let producerWorkerIndex = -1;
    let producerFound = false;

    for (const [, student] of room.students) {
      for (const p of student.producers) {
        if (p.producer.id === producerId && !p.producer.closed) {
          producerWorkerIndex = student.workerIndex;
          producerFound = true;
          break;
        }
      }
      if (producerFound) break;
    }

    if (!producerFound) return cb({ error: "producer gone" });

    // PIPE if producer and consumer are on different workers
    if (producerWorkerIndex !== consumerWorkerIndex) {
      await ensurePipe(room, producerId, producerWorkerIndex, consumerWorkerIndex);
    }

    const router = room.routers.get(consumerWorkerIndex);
    if (!router) return cb({ error: "router not found" });

    if (!router.canConsume({ producerId, rtpCapabilities })) {
      return cb({ error: "cannot consume" });
    }

    try {
      const consumer = await tEntry.transport.consume({
        producerId,
        rtpCapabilities,
        paused: false,
      });

      consumer.on("transportclose", () => consumer.close());
      consumer.on("producerclose", () => {
        socket.emit("consumerClosed", {
          consumerId: consumer.id,
          producerId,
        });
        consumer.close();
      });

      cb({
        id: consumer.id,
        producerId: consumer.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });

    } catch (err) {
      console.error("consume error:", err.message);
      cb({ error: err.message });
    }
  });

  // ── GET PRODUCERS ──
  socket.on("getProducers", (cb) => {
    if (typeof cb !== "function") return;
    const room = socket.data.room;
    if (!room) return cb([]);

    const result = [];
    for (const [socketId, student] of room.students) {
      if (socketId === socket.id) continue;
      for (const p of student.producers) {
        if (p.producer.closed) continue;
        result.push({
          producerId: p.producer.id,
          socketId,
          kind: p.kind,
          type: p.type,
          workerIndex: student.workerIndex,
        });
      }
    }
    cb(result);
  });

  // ── DISCONNECT ──
  socket.on("disconnect", () => {
    const room = socket.data.room;
    if (!room) return;
    const roomId = socket.data.roomId;

    // close producers
    socket.data.producers.forEach((p) => {
      if (!p.closed) p.close();
    });
    room.students.delete(socket.id);

    // close transports
    socket.data.transportIds.forEach((id) => {
      const entry = room.transports.get(id);
      if (entry && !entry.transport.closed) entry.transport.close();
      room.transports.delete(id);
    });

    room.members.delete(socket.id);
    socket.to(roomId).emit("studentLeft", socket.id);
    console.log(`${socket.id} left "${roomId}" (${room.members.size} left)`);

    // cleanup empty room
    if (room.members.size === 0) {
      for (const [, router] of room.routers) {
        router.close();
      }
      rooms.delete(roomId);
      console.log(`Room deleted: "${roomId}"`);
    }
  });
});

// ─── MONITOR — see what's happening ──────────────────────────────
setInterval(async () => {
  if (!ready) return;

  const lines = ["\n═══ MONITOR ═══"];

  for (let i = 0; i < workers.length; i++) {
    try {
      const usage = await workers[i].getResourceUsage();
      lines.push(
        `  W${i} pid=${workers[i].pid} cpu=${Math.round(usage.ru_utime / 1000)}ms`
      );
    } catch (_) {}
  }

  for (const [roomId, room] of rooms) {
    const perWorker = new Array(workers.length).fill(0);
    let totalProd = 0;

    for (const [, s] of room.students) {
      perWorker[s.workerIndex] += s.producers.length;
      totalProd += s.producers.length;
    }

    const transPerWorker = new Array(workers.length).fill(0);
    for (const [, t] of room.transports) {
      transPerWorker[t.workerIndex]++;
    }

    lines.push(`  Room "${roomId}": ${room.members.size} members, ${totalProd} producers`);
    lines.push(`    Producers/worker:  [${perWorker.join(", ")}]`);
    lines.push(`    Transports/worker: [${transPerWorker.join(", ")}]`);
    lines.push(`    Pipes: ${room.pipes.size}`);
    lines.push(`    Routers: ${room.routers.size}`);
  }

  lines.push("═══════════════\n");
  console.log(lines.join("\n"));
}, 15000);

export { io };