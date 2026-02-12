import React, { useState, useEffect, useRef, useCallback } from "react";
import { Device } from "mediasoup-client";
import { io } from "socket.io-client";

const streamStore = {};

export default function ProctorUI() {
  const [roomId, setRoomId] = useState("");
  const [joined, setJoined] = useState(false);
  const [studentIds, setStudentIds] = useState([]);
  const [tick, setTick] = useState(0);
  const [audioOn, setAudioOn] = useState(false);

  const socketRef = useRef(null);
  const deviceRef = useRef(null);
  const consumed = useRef(new Set());
  const started = useRef(false);

  // KEY: one recv transport per worker
  const workerTransports = useRef(new Map()); // workerIndex -> transport
  const transportPromises = useRef(new Map()); // workerIndex -> Promise

  function refresh() {
    setTick((t) => t + 1);
  }

  // get or create recv transport for a specific worker
  // uses promise cache so we don't create duplicates
  function getRecvTransport(workerIndex) {
    // already have it
    if (workerTransports.current.has(workerIndex)) {
      return Promise.resolve(workerTransports.current.get(workerIndex));
    }

    // already creating it
    if (transportPromises.current.has(workerIndex)) {
      return transportPromises.current.get(workerIndex);
    }

    // create new
    const promise = new Promise((resolve) => {
      const socket = socketRef.current;
      const device = deviceRef.current;
      if (!socket || !device) return resolve(null);

      console.log(`Creating recv transport for worker ${workerIndex}...`);

      socket.emit(
        "createTransport",
        { type: "recv", workerIndex },
        (data) => {
          if (!data || data.error) {
            console.error(`Transport error worker ${workerIndex}:`, data?.error);
            transportPromises.current.delete(workerIndex);
            return resolve(null);
          }

          const transport = device.createRecvTransport({
            id: data.id,
            iceParameters: data.iceParameters,
            iceCandidates: data.iceCandidates,
            dtlsParameters: data.dtlsParameters,
          });

          transport.on("connect", ({ dtlsParameters }, cb, eb) => {
            socket.emit(
              "connectTransport",
              { transportId: transport.id, dtlsParameters },
              (r) => (r?.connected ? cb() : eb(new Error(r?.error)))
            );
          });

          workerTransports.current.set(workerIndex, transport);
          transportPromises.current.delete(workerIndex);
          console.log(`✅ Recv transport on worker ${workerIndex} ready`);
          resolve(transport);
        }
      );
    });

    transportPromises.current.set(workerIndex, promise);
    return promise;
  }

  // consume one producer
  const consumeProducer = useCallback(
    async ({ producerId, socketId, kind, type, workerIndex }) => {
      if (consumed.current.has(producerId)) return;
      consumed.current.add(producerId);

      const socket = socketRef.current;
      const device = deviceRef.current;
      if (!socket || !device) {
        consumed.current.delete(producerId);
        return;
      }

      // get transport for the worker this producer is on
      const transport = await getRecvTransport(workerIndex);
      if (!transport) {
        consumed.current.delete(producerId);
        return;
      }

      socket.emit(
        "consume",
        {
          producerId,
          rtpCapabilities: device.rtpCapabilities,
          transportId: transport.id,
        },
        async (res) => {
          if (!res || res.error) {
            console.error("Consume error:", res?.error);
            consumed.current.delete(producerId);
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
            const sType = type || "camera";

            if (!streamStore[socketId]) streamStore[socketId] = {};

            if (sType === "camera") {
              if (!streamStore[socketId].camera)
                streamStore[socketId].camera = new MediaStream();
              if (!streamStore[socketId].audio)
                streamStore[socketId].audio = new MediaStream();

              if (track.kind === "audio") {
                streamStore[socketId].camera
                  .getAudioTracks()
                  .forEach((t) => streamStore[socketId].camera.removeTrack(t));
                streamStore[socketId].audio
                  .getAudioTracks()
                  .forEach((t) => streamStore[socketId].audio.removeTrack(t));
                streamStore[socketId].camera.addTrack(track);
                streamStore[socketId].audio.addTrack(track);
              } else {
                streamStore[socketId].camera
                  .getVideoTracks()
                  .forEach((t) => streamStore[socketId].camera.removeTrack(t));
                streamStore[socketId].camera.addTrack(track);
              }
            }

            if (sType === "screen") {
              if (!streamStore[socketId].screen)
                streamStore[socketId].screen = new MediaStream();
              streamStore[socketId].screen
                .getVideoTracks()
                .forEach((t) => streamStore[socketId].screen.removeTrack(t));
              streamStore[socketId].screen.addTrack(track);
            }

            setStudentIds((prev) =>
              prev.includes(socketId) ? prev : [...prev, socketId]
            );
            refresh();
          } catch (e) {
            console.error("Consumer error:", e);
            consumed.current.delete(producerId);
          }
        }
      );
    },
    []
  );

  function handleJoin() {
    if (!roomId.trim() || started.current) return;
    started.current = true;

    const socket = io("http://localhost:3000");
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("join", roomId);
    });

    socket.on("rtp", async (rtp) => {
      if (deviceRef.current) return;

      const device = new Device();
      await device.load({ routerRtpCapabilities: rtp });
      deviceRef.current = device;
      console.log("Device loaded");

      // get existing producers
      socket.emit("getProducers", (producers) => {
        console.log(`${producers.length} existing producers`);
        // consume in small batches to avoid CPU spike
        let i = 0;
        function consumeNext() {
          if (i >= producers.length) return;
          consumeProducer(producers[i]);
          i++;
          setTimeout(consumeNext, 100); // 100ms between each
        }
        consumeNext();
      });
    });

    socket.on("newProducer", (info) => {
      consumeProducer(info);
    });

    socket.on("studentLeft", (sid) => {
      delete streamStore[sid];
      setStudentIds((prev) => prev.filter((id) => id !== sid));
      refresh();
    });

    socket.on("consumerClosed", ({ producerId }) => {
      consumed.current.delete(producerId);
    });

    setJoined(true);
  }

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
      Object.keys(streamStore).forEach((k) => delete streamStore[k]);
    };
  }, []);

  if (!joined) {
    return (
      <div style={{ padding: 40, textAlign: "center" }}>
        <h2>Proctor Dashboard</h2>
        <input
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleJoin()}
          placeholder="Room ID"
          style={{ padding: 10, fontSize: 16, marginRight: 10 }}
        />
        <button onClick={handleJoin} style={{ padding: 10, fontSize: 16 }}>
          Join
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: 10 }}>
      <div style={{ marginBottom: 10, display: "flex", justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>
          Room: {roomId} | Students: {studentIds.length} |
          Workers: {workerTransports.current.size}
        </h3>
        <button onClick={() => setAudioOn((a) => !a)} style={{ padding: "5px 15px" }}>
          {audioOn ? "🔊 Audio ON" : "🔇 Audio OFF"}
        </button>
      </div>

      {studentIds.length === 0 && <p>Waiting for students...</p>}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {studentIds.map((sid) => (
          <StudentCard key={sid} socketId={sid} tick={tick} audioOn={audioOn} />
        ))}
      </div>
    </div>
  );
}

function StudentCard({ socketId, tick, audioOn }) {
  const [main, setMain] = useState("camera");
  const mainRef = useRef(null);
  const pipRef = useRef(null);
  const audioRef = useRef(null);

  const streams = streamStore[socketId] || {};
  const hasCam = !!streams.camera;
  const hasScr = !!streams.screen;
  const pip = main === "camera" ? "screen" : "camera";

  useEffect(() => {
    if (mainRef.current && streams[main]) {
      if (mainRef.current.srcObject !== streams[main])
        mainRef.current.srcObject = streams[main];
      mainRef.current.play().catch(() => {});
    }
  }, [tick, main, streams]);

  useEffect(() => {
    if (pipRef.current && streams[pip]) {
      if (pipRef.current.srcObject !== streams[pip])
        pipRef.current.srcObject = streams[pip];
      pipRef.current.play().catch(() => {});
    }
  }, [tick, pip, streams]);

  useEffect(() => {
    if (audioRef.current && streams.audio) {
      if (audioRef.current.srcObject !== streams.audio)
        audioRef.current.srcObject = streams.audio;
      audioRef.current.muted = !audioOn;
      audioRef.current.volume = 0.6;
      if (audioOn) audioRef.current.play().catch(() => {});
    }
  }, [tick, audioOn, streams]);

  return (
    <div style={{ border: "1px solid #ccc", width: 340, background: "#111", borderRadius: 8, overflow: "hidden" }}>
      <audio ref={audioRef} autoPlay playsInline />
      <div style={{ padding: "6px 10px", background: "#222", color: "#fff", fontSize: 12, display: "flex", justifyContent: "space-between" }}>
        <span>🟢 {socketId.slice(0, 8)}...</span>
        <span>{hasCam && "📷"} {hasScr && "🖥️"}</span>
      </div>
      <div style={{ position: "relative", width: "100%", height: 200 }}>
        <video ref={mainRef} autoPlay playsInline muted style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000" }} />
        <span style={{ position: "absolute", top: 4, left: 4, background: "rgba(0,0,0,0.6)", color: "#fff", fontSize: 10, padding: "2px 6px", borderRadius: 3 }}>
          {main === "camera" ? "📷 Camera" : "🖥️ Screen"}
        </span>
        {hasCam && hasScr && (
          <div onClick={() => setMain((m) => (m === "camera" ? "screen" : "camera"))} style={{ position: "absolute", bottom: 6, right: 6, width: 110, height: 70, border: "2px solid rgba(255,255,255,0.4)", borderRadius: 6, overflow: "hidden", cursor: "pointer", background: "#000" }}>
            <video ref={pipRef} autoPlay playsInline muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            <span style={{ position: "absolute", top: 2, left: 2, fontSize: 9, background: "rgba(0,0,0,0.6)", color: "#fff", padding: "1px 4px", borderRadius: 2 }}>
              {pip === "camera" ? "📷" : "🖥️"} 🔄
            </span>
          </div>
        )}
      </div>
    </div>
  );
}