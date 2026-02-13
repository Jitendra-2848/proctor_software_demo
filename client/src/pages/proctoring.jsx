import React, { useState, useEffect, useRef, useCallback } from "react";
import { Device } from "mediasoup-client";
import { io } from "socket.io-client";

const streamStore = {};

function ProctorUI() {
  const [roomId, setRoomId] = useState("");
  const [joined, setJoined] = useState(false);
  const [studentIds, setStudentIds] = useState([]);
  const [renderTick, setRenderTick] = useState(0);
  const [roomStats, setRoomStats] = useState(null);
  const [logs, setLogs] = useState([]);

  const socketRef = useRef(null);
  const deviceRef = useRef(null);
  const recvTransportRef = useRef(null);
  const consumedSet = useRef(new Set());
  const initDone = useRef(false);

  function log(msg) {
    const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    console.log(entry);
    setLogs((prev) => [...prev.slice(-30), entry]);
  }

  function forceUpdate() {
    setRenderTick((t) => t + 1);
  }

  const consumeProducer = useCallback(
    ({ producerId, socketId, kind, type }) => {
      if (consumedSet.current.has(producerId)) return;
      consumedSet.current.add(producerId);

      const socket = socketRef.current;
      const device = deviceRef.current;
      const transport = recvTransportRef.current;

      if (!socket || !device || !transport) {
        consumedSet.current.delete(producerId);
        return;
      }

      log(`Consuming ${kind} from ${socketId.slice(0, 8)} (PROCTOR PRIORITY)`);

      socket.emit(
        "consume",
        {
          producerId,
          rtpCapabilities: device.rtpCapabilities,
          transportId: transport.id,
        },
        async (res) => {
          if (!res || res.error) {
            log(`Consume error: ${res?.error}`);
            consumedSet.current.delete(producerId);
            return;
          }

          try {
            const consumer = await transport.consume({
              id: res.id,
              producerId: res.producerId,
              kind: res.kind,
              rtpParameters: res.rtpParameters,
            });

            const track = consumer.track;
            const streamType = type || "camera";

            track.onended = () => log(`Track ended: ${socketId.slice(0, 8)} ${kind}`);
            track.onmute = () => log(`Track muted: ${socketId.slice(0, 8)} ${kind}`);
            track.onunmute = () => log(`Track unmuted: ${socketId.slice(0, 8)} ${kind}`);

            if (!streamStore[socketId]) streamStore[socketId] = {};
            if (!streamStore[socketId][streamType]) {
              streamStore[socketId][streamType] = new MediaStream();
            }

            streamStore[socketId][streamType]
              .getTracks()
              .filter((t) => t.kind === track.kind)
              .forEach((t) => streamStore[socketId][streamType].removeTrack(t));

            streamStore[socketId][streamType].addTrack(track);

            setStudentIds((prev) => {
              if (!prev.includes(socketId)) return [...prev, socketId];
              return prev;
            });

            forceUpdate();
            log(`✅ ${kind} consuming from ${socketId.slice(0, 8)} (HIGH QUALITY)`);
          } catch (e) {
            log(`Consumer error: ${e.message}`);
            consumedSet.current.delete(producerId);
          }
        }
      );
    },
    []
  );

  function handleJoin() {
    if (!roomId.trim()) return;
    if (initDone.current) return;
    initDone.current = true;

    log("Joining as PROCTOR...");
    const socket = io("http://localhost:3000");
    socketRef.current = socket;

    socket.on("connect", () => {
      log(`Connected: ${socket.id}`);
      // JOIN AS PROCTOR
      socket.emit("join", roomId, "proctor");
    });

    socket.on("role", (r) => log(`Role: ${r}`));

    socket.on("rtp", async (rtp) => {
      if (deviceRef.current) return;

      try {
        const device = new Device();
        await device.load({ routerRtpCapabilities: rtp });
        deviceRef.current = device;
        log("Device loaded");

        socket.emit("createTransport", { type: "recv" }, (data) => {
          if (!data || data.error) {
            log(`Transport error: ${data?.error}`);
            return;
          }

          const transport = device.createRecvTransport({
            id: data.id,
            iceParameters: data.iceParameters,
            iceCandidates: data.iceCandidates,
            dtlsParameters: data.dtlsParameters,
          });
          recvTransportRef.current = transport;

          transport.on("connect", ({ dtlsParameters }, cb, errback) => {
            socket.emit(
              "connectTransport",
              { transportId: transport.id, dtlsParameters },
              (res) => {
                if (res?.connected) cb();
                else errback(new Error(res?.error || "fail"));
              }
            );
          });

          transport.on("connectionstatechange", (state) => {
            log(`ICE: ${state}`);
            if (state === "failed") log("⚠️ Check announcedIp in config!");
          });

          log("Transport ready, getting producers...");
          socket.emit("getProducers", (producers) => {
            log(`Got ${producers?.length} existing producers`);
            if (producers) producers.forEach(consumeProducer);
          });
        });
      } catch (e) {
        log(`Device error: ${e.message}`);
      }
    });

    socket.on("newProducer", (info) => {
      log(`New producer: ${info.kind} from ${info.socketId.slice(0, 8)}`);
      consumeProducer(info);
    });

    socket.on("studentLeft", (socketId) => {
      log(`Student left: ${socketId.slice(0, 8)}`);
      delete streamStore[socketId];
      setStudentIds((prev) => prev.filter((id) => id !== socketId));
      forceUpdate();
    });

    socket.on("consumerClosed", ({ producerId }) => {
      consumedSet.current.delete(producerId);
    });

    // Poll room stats every 5 seconds
    const statsInterval = setInterval(() => {
      socket.emit("getRoomStats", (stats) => {
        if (stats && !stats.error) setRoomStats(stats);
      });
    }, 5000);

    socket.on("disconnect", () => clearInterval(statsInterval));

    setJoined(true);
  }

  useEffect(() => {
    return () => {
      if (socketRef.current) socketRef.current.disconnect();
      Object.keys(streamStore).forEach((k) => delete streamStore[k]);
    };
  }, []);

  return (
    <div style={{ padding: 10 }}>
      {!joined ? (
        <div>
          <h3>OmniView Proctor</h3>
          <input
            type="text"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            placeholder="Room ID"
          />
          <button onClick={handleJoin}>Join as Proctor</button>
        </div>
      ) : (
        <div>
          <h3>
            Room: {roomId} | Students: {studentIds.length}
            {roomStats && (
              <span style={{ fontSize: 12, marginLeft: 10, color: "#666" }}>
                | Producers: {roomStats.producers} | Consumers: {roomStats.consumers}
              </span>
            )}
          </h3>

          {/* Network stats bar */}
          {roomStats?.networkStats && Object.keys(roomStats.networkStats).length > 0 && (
            <div
              style={{
                padding: 5,
                backgroundColor: "#e8f5e9",
                marginBottom: 10,
                fontSize: 12,
                fontFamily: "monospace",
              }}
            >
              {Object.entries(roomStats.networkStats).map(([sid, ns]) => (
                <span key={sid} style={{ marginRight: 15 }}>
                  {sid}: RTT={ns.rtt}ms Loss={ns.packetLoss}
                </span>
              ))}
            </div>
          )}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {studentIds.map((sid) => (
              <StudentCard key={sid} socketId={sid} tick={renderTick} log={log} />
            ))}
          </div>

          {/* Logs */}
          <div
            style={{
              marginTop: 20,
              padding: 10,
              backgroundColor: "#111",
              color: "#0f0",
              fontFamily: "monospace",
              fontSize: 11,
              maxHeight: 200,
              overflow: "auto",
            }}
          >
            {logs.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StudentCard({ socketId, tick, log }) {
  const cameraRef = useRef(null);
  const screenRef = useRef(null);
  const playingRef = useRef(false);
  const streams = streamStore[socketId] || {};

  useEffect(() => {
    const el = cameraRef.current;
    const stream = streams.camera;
    if (!el || !stream) return;

    if (el.srcObject !== stream) {
      el.srcObject = stream;
      playingRef.current = false;
    }

    if (!playingRef.current) {
      const timer = setTimeout(() => {
        el.play()
          .then(() => {
            playingRef.current = true;
            log(`▶️ Playing ${socketId.slice(0, 8)} (${el.videoWidth}x${el.videoHeight})`);
          })
          .catch((e) => log(`Play error: ${e.message}`));
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [tick, socketId]);

  useEffect(() => {
    const el = screenRef.current;
    const stream = streams.screen;
    if (!el || !stream) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    setTimeout(() => el.play().catch(() => { }), 150);
  }, [tick, socketId]);

  return (
    <div
      style={{
        border: "2px solid #666",
        padding: 8,
        width: 320,
        backgroundColor: "#f0f0f0",
      }}
    >
      <div style={{ fontWeight: "bold", marginBottom: 5 }}>
        {socketId.slice(0, 12)}
        {streams.camera && ` (${streams.camera.getTracks().length} tracks)`}
      </div>
      <div>
        <video
          ref={cameraRef}
          autoPlay
          playsInline
          muted
          style={{ width: "100%", height: 200, backgroundColor: "#000" }}
        />
      </div>
      {streams.screen && (
        <div>
          <video
            ref={screenRef}
            autoPlay
            playsInline
            style={{ width: "100%", height: 200, backgroundColor: "#000" }}
          />
        </div>
      )}
    </div>
  );
}

export default ProctorUI;