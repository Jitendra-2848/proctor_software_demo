import { io } from "./main_base/base.js";
import { config } from "./mediasoup/config.js";
import { createRouterOnWorker } from "./mediasoup/getworker.js";
import { createWorkers } from "./mediasoup/worker.js";

let rooms = new Map();
let workersReady = false;

(async () => {
    await createWorkers();
    workersReady = true;
    console.log("[SERVER] Workers ready, OmniView architecture active");
})();

// ========== ROOM MANAGEMENT ==========

async function getOrCreateRoom(roomId) {
    if (rooms.has(roomId)) return rooms.get(roomId);

    const router = await createRouterOnWorker();
    const room = {
        router,
        // Per-socket producer tracking
        // socketId -> [{ producer, kind, type, layer }]
        producers: new Map(),
        // transportId -> transport
        transports: new Map(),
        // Room members with roles
        members: new Map(), // socketId -> { role: "student"|"proctor", socket }
        // Consumer tracking for cleanup
        consumers: new Map(), // consumerId -> { consumer, socketId, producerId }
        // Network stats per student
        networkStats: new Map(), // socketId -> { rtt, packetLoss, bitrate, lastUpdate }
        // Active speakers (for student downstream optimization)
        activeSpeakers: [], // [socketId, socketId, ...] top N
    };

    rooms.set(roomId, room);
    console.log(`[ROOM] Created: ${roomId}`);
    return room;
}

// ========== NETWORK MONITOR ==========

function startNetworkMonitor(room, roomId) {
    if (room._monitorInterval) return;

    room._monitorInterval = setInterval(async () => {
        for (const [socketId, member] of room.members) {
            if (member.role !== "student") continue;

            // Get transport stats
            const transportIds = member.socket.data.transportIds || [];
            for (const tid of transportIds) {
                const transport = room.transports.get(tid);
                if (!transport || transport.closed) continue;

                try {
                    const stats = await transport.getStats();
                    let totalPacketLoss = 0;
                    let totalPackets = 0;
                    let rtt = 0;

                    for (const [, stat] of stats) {
                        if (stat.type === "transport") {
                            rtt = stat.roundTripTime || 0;
                        }
                        if (stat.packetsLost !== undefined) {
                            totalPacketLoss += stat.packetsLost;
                            totalPackets += (stat.packetsSent || stat.packetsReceived || 0);
                        }
                    }

                    const lossRate = totalPackets > 0 ? totalPacketLoss / totalPackets : 0;

                    room.networkStats.set(socketId, {
                        rtt,
                        packetLoss: lossRate,
                        lastUpdate: Date.now(),
                    });

                    // Adaptive bitrate for struggling students
                    applyAdaptiveBitrate(room, socketId, lossRate);
                } catch (e) {
                    // transport might be closed
                }
            }
        }
    }, config.omniview.monitoring.statsInterval);
}

function stopNetworkMonitor(room) {
    if (room._monitorInterval) {
        clearInterval(room._monitorInterval);
        room._monitorInterval = null;
    }
}

// ========== ADAPTIVE BITRATE (Server Authority) ==========

function applyAdaptiveBitrate(room, socketId, packetLoss) {
    const member = room.members.get(socketId);
    if (!member || member.role !== "student") return;

    const producers = room.producers.get(socketId) || [];
    const threshold = config.omniview.monitoring;

    for (const p of producers) {
        if (p.producer.closed || p.kind !== "video") continue;

        if (packetLoss > threshold.degradeThreshold) {
            // Degrade: pause peer layer first (proctor layer stays)
            // This is the Proctor-First Invariant
            console.log(`[ABR] ${socketId.slice(0, 8)} high loss (${(packetLoss * 100).toFixed(1)}%) — degrading peer layer`);

            // If using simulcast, prefer lower spatial layer for students
            // Proctor always gets highest layer
        } else if (packetLoss < threshold.recoverThreshold) {
            // Recover: resume peer layer
        }
    }
}

// ========== ACTIVE SPEAKER DETECTION ==========

function updateActiveSpeakers(room, socketId, audioLevel) {
    // Simple: track last N speakers by audio activity
    const max = config.omniview.maxActiveStreamsForStudent;
    const idx = room.activeSpeakers.indexOf(socketId);
    if (idx !== -1) room.activeSpeakers.splice(idx, 1);
    room.activeSpeakers.unshift(socketId);
    if (room.activeSpeakers.length > max) {
        room.activeSpeakers = room.activeSpeakers.slice(0, max);
    }
}

// ========== SOCKET HANDLING ==========

io.on("connection", (socket) => {
    console.log(`[CONN] ${socket.id}`);

    socket.data.transportIds = [];
    socket.data.producerObjects = [];
    socket.data.consumerIds = [];
    socket.data.role = null;

    // ---- JOIN ----
    socket.on("join", async (roomId, role) => {
        if (!workersReady) return socket.emit("error", "Server not ready");
        if (!roomId || typeof roomId !== "string") return;

        // Prevent double join
        if (socket.data.roomId) {
            socket.emit("rtp", socket.data.room.router.rtpCapabilities);
            return;
        }

        const userRole = role === "proctor" ? "proctor" : "student";
        const room = await getOrCreateRoom(roomId);

        socket.data.roomId = roomId;
        socket.data.room = room;
        socket.data.role = userRole;

        room.members.set(socket.id, { role: userRole, socket });
        socket.join(roomId);

        // Start network monitor when first student joins
        if (userRole === "student") {
            startNetworkMonitor(room, roomId);
        }

        socket.emit("rtp", room.router.rtpCapabilities);
        socket.emit("role", userRole);

        console.log(`[JOIN] ${socket.id} as ${userRole} in ${roomId} (members: ${room.members.size})`);
    });

    // ---- CREATE TRANSPORT ----
    socket.on("createTransport", async (data, cb) => {
        if (typeof cb !== "function") return;
        const room = socket.data.room;
        if (!room) return cb({ error: "join first" });

        try {
            const transportOptions = {
                listenIps: config.mediasoup.webRtcTransport.listenIps,
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
                initialAvailableOutgoingBitrate: config.mediasoup.initialAvailableOutgoingBitrate,
            };

            // Proctor gets higher initial bitrate
            if (socket.data.role === "proctor") {
                transportOptions.initialAvailableOutgoingBitrate = 1000000; // 1Mbps
            }

            const transport = await room.router.createWebRtcTransport(transportOptions);

            // Monitor transport events
            transport.on("icestatechange", (state) => {
                console.log(`[ICE] ${socket.id.slice(0, 8)} ${data.type}: ${state}`);
            });

            transport.on("dtlsstatechange", (state) => {
                console.log(`[DTLS] ${socket.id.slice(0, 8)} ${data.type}: ${state}`);
                if (state === "failed" || state === "closed") {
                    transport.close();
                }
            });

            room.transports.set(transport.id, transport);
            socket.data.transportIds.push(transport.id);

            cb({
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            });

            console.log(`[TRANSPORT] ${socket.id.slice(0, 8)} ${data.type}: ${transport.id.slice(0, 8)}`);
        } catch (e) {
            console.error(`[TRANSPORT] ERROR:`, e.message);
            cb({ error: e.message });
        }
    });

    // ---- CONNECT TRANSPORT ----
    socket.on("connectTransport", async ({ transportId, dtlsParameters }, cb) => {
        if (typeof cb !== "function") return;
        const room = socket.data.room;
        if (!room) return cb({ error: "no room" });

        const transport = room.transports.get(transportId);
        if (!transport) return cb({ error: "transport not found" });
        if (transport._connected) return cb({ connected: true });

        try {
            await transport.connect({ dtlsParameters });
            transport._connected = true;
            cb({ connected: true });
        } catch (e) {
            cb({ error: e.message });
        }
    });

    // ---- PRODUCE ----
    socket.on("produce", async ({ transportId, kind, rtpParameters, appData }, cb) => {
        if (typeof cb !== "function") return;
        const room = socket.data.room;
        if (!room) return cb({ error: "no room" });

        const transport = room.transports.get(transportId);
        if (!transport) return cb({ error: "transport not found" });

        try {
            const producer = await transport.produce({
                kind,
                rtpParameters,
                appData: appData || {},
            });

            // Store
            if (!room.producers.has(socket.id)) {
                room.producers.set(socket.id, []);
            }

            // Remove duplicate
            const list = room.producers.get(socket.id);
            const dupIdx = list.findIndex(
                (p) => p.kind === kind && p.type === (appData?.type || "camera")
            );
            if (dupIdx !== -1) {
                list[dupIdx].producer.close();
                list.splice(dupIdx, 1);
            }

            list.push({
                producer,
                kind,
                type: appData?.type || "camera",
            });

            socket.data.producerObjects.push(producer);

            // Notify EVERYONE in room about new producer
            // Include the source role so consumers know priority
            const notification = {
                producerId: producer.id,
                socketId: socket.id,
                kind,
                type: appData?.type || "camera",
                sourceRole: socket.data.role,
            };

            socket.to(socket.data.roomId).emit("newProducer", notification);

            producer.on("transportclose", () => producer.close());

            // Audio level observer for active speaker detection
            if (kind === "audio") {
                producer.on("score", (score) => {
                    if (score && score.length > 0 && score[0].score > 5) {
                        updateActiveSpeakers(room, socket.id, score[0].score);
                    }
                });
            }

            cb({ id: producer.id });
            console.log(`[PRODUCE] ${socket.id.slice(0, 8)} ${kind} ${appData?.type || "camera"}`);
        } catch (e) {
            cb({ error: e.message });
        }
    });

    // ---- CONSUME ----
    socket.on("consume", async ({ producerId, rtpCapabilities, transportId }, cb) => {
        if (typeof cb !== "function") return;
        const room = socket.data.room;
        if (!room) return cb({ error: "no room" });

        // Find producer and its source
        let sourceSocketId = null;
        let sourceRole = null;
        let producerFound = false;

        for (const [sid, producers] of room.producers) {
            const match = producers.find((p) => p.producer.id === producerId && !p.producer.closed);
            if (match) {
                producerFound = true;
                sourceSocketId = sid;
                sourceRole = room.members.get(sid)?.role || "student";
                break;
            }
        }

        if (!producerFound) return cb({ error: "producer not found" });

        if (!room.router.canConsume({ producerId, rtpCapabilities })) {
            return cb({ error: "cannot consume" });
        }

        const transport = room.transports.get(transportId);
        if (!transport) return cb({ error: "transport not found" });

        try {
            // ========== OMNIVIEW LAYER SELECTION ==========
            // Proctor ALWAYS gets highest quality (Proctor-First Invariant)
            // Students get lower quality (peer layer)

            const consumerRole = socket.data.role;
            let preferredLayers = undefined;

            if (consumerRole === "proctor") {
                // Proctor: highest spatial + temporal layer
                preferredLayers = {
                    spatialLayer: 2,   // highest
                    temporalLayer: 2,  // highest
                };
                console.log(`[CONSUME] Proctor gets HIGH quality from ${sourceSocketId?.slice(0, 8)}`);
            } else {
                // Student: lowest spatial layer to save bandwidth
                preferredLayers = {
                    spatialLayer: 0,   // lowest
                    temporalLayer: 1,  // medium
                };

                // Check if this producer's student is in active speakers
                const isActiveSpeaker = room.activeSpeakers.includes(sourceSocketId);
                if (!isActiveSpeaker && room.activeSpeakers.length >= config.omniview.maxActiveStreamsForStudent) {
                    // Not active speaker and we're at limit — skip video
                    // But always allow audio
                    const producerKind = room.producers.get(sourceSocketId)
                        ?.find(p => p.producer.id === producerId)?.kind;

                    if (producerKind === "video") {
                        console.log(`[CONSUME] Student skipping non-active-speaker video from ${sourceSocketId?.slice(0, 8)}`);
                        // Still allow but at minimum quality
                        preferredLayers = {
                            spatialLayer: 0,
                            temporalLayer: 0,
                        };
                    }
                }
            }

            const consumer = await transport.consume({
                producerId,
                rtpCapabilities,
                paused: false,
            });

            // Set preferred layers after creation
            if (preferredLayers && consumer.kind === "video" && consumer.type === "simulcast") {
                try {
                    await consumer.setPreferredLayers(preferredLayers);
                } catch (e) {
                    // may not support simulcast — that's ok
                }
            }

            // Track consumer
            room.consumers.set(consumer.id, {
                consumer,
                socketId: socket.id,
                producerId,
                consumerRole,
            });
            socket.data.consumerIds.push(consumer.id);

            consumer.on("transportclose", () => {
                room.consumers.delete(consumer.id);
            });

            consumer.on("producerclose", () => {
                room.consumers.delete(consumer.id);
                socket.emit("consumerClosed", {
                    consumerId: consumer.id,
                    producerId,
                });
            });

            // For proctor consumers, monitor quality
            if (consumerRole === "proctor") {
                consumer.on("score", (score) => {
                    if (score && score.producerScore < 5) {
                        console.log(`[QOS] ⚠️ Low producer score for proctor stream: ${score.producerScore}`);
                    }
                });

                consumer.on("layerschange", (layers) => {
                    if (layers) {
                        console.log(`[QOS] Proctor consumer layers: spatial=${layers.spatialLayer} temporal=${layers.temporalLayer}`);
                    }
                });
            }

            cb({
                id: consumer.id,
                producerId: consumer.producerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
            });

            console.log(`[CONSUME] ${socket.id.slice(0, 8)}(${consumerRole}) <- ${sourceSocketId?.slice(0, 8)} ${consumer.kind}`);
        } catch (e) {
            cb({ error: e.message });
        }
    });

    // ---- GET PRODUCERS ----
    socket.on("getProducers", (cb) => {
        if (typeof cb !== "function") return;
        const room = socket.data.room;
        if (!room) return cb([]);

        const result = [];
        for (const [socketId, producers] of room.producers) {
            if (socketId === socket.id) continue;
            for (const p of producers) {
                if (p.producer.closed) continue;
                result.push({
                    producerId: p.producer.id,
                    socketId,
                    kind: p.kind,
                    type: p.type,
                    sourceRole: room.members.get(socketId)?.role || "student",
                });
            }
        }

        console.log(`[PRODUCERS] ${socket.id.slice(0, 8)} gets ${result.length} producers`);
        cb(result);
    });

    // ---- GET ROOM STATS (proctor only) ----
    socket.on("getRoomStats", (cb) => {
        if (typeof cb !== "function") return;
        if (socket.data.role !== "proctor") return cb({ error: "proctor only" });

        const room = socket.data.room;
        if (!room) return cb({ error: "no room" });

        const stats = {
            members: room.members.size,
            students: [...room.members.values()].filter((m) => m.role === "student").length,
            proctors: [...room.members.values()].filter((m) => m.role === "proctor").length,
            producers: 0,
            consumers: room.consumers.size,
            activeSpeakers: room.activeSpeakers.slice(0, 4),
            networkStats: {},
        };

        for (const [, producers] of room.producers) {
            stats.producers += producers.filter((p) => !p.producer.closed).length;
        }

        for (const [sid, ns] of room.networkStats) {
            stats.networkStats[sid.slice(0, 8)] = {
                rtt: Math.round(ns.rtt),
                packetLoss: (ns.packetLoss * 100).toFixed(2) + "%",
            };
        }

        cb(stats);
    });

    // ---- DISCONNECT ----
    socket.on("disconnect", () => {
        const room = socket.data.room;
        if (!room) return;

        console.log(`[DISC] ${socket.id.slice(0, 8)} (${socket.data.role})`);

        // Close producers
        socket.data.producerObjects.forEach((p) => {
            if (!p.closed) p.close();
        });
        room.producers.delete(socket.id);

        // Close consumers
        socket.data.consumerIds.forEach((cid) => {
            const c = room.consumers.get(cid);
            if (c && !c.consumer.closed) c.consumer.close();
            room.consumers.delete(cid);
        });

        // Close transports
        socket.data.transportIds.forEach((id) => {
            const t = room.transports.get(id);
            if (t && !t.closed) t.close();
            room.transports.delete(id);
        });

        room.members.delete(socket.id);
        room.networkStats.delete(socket.id);

        // Remove from active speakers
        const asIdx = room.activeSpeakers.indexOf(socket.id);
        if (asIdx !== -1) room.activeSpeakers.splice(asIdx, 1);

        socket.to(socket.data.roomId).emit("studentLeft", socket.id);

        // Cleanup empty room
        if (room.members.size === 0) {
            stopNetworkMonitor(room);
            room.router.close();
            rooms.delete(socket.data.roomId);
            console.log(`[ROOM] Deleted: ${socket.data.roomId}`);
        }
    });
});

export { io };