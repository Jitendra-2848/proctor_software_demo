import React, { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { io } from "socket.io-client";
import { Device } from "mediasoup-client";

const Room = () => {
    const { id } = useParams();
    const deviceRef = useRef(null);
    const socketRef = useRef(null);
    const transportRef = useRef(null);
    const videoRef = useRef(null);
    const init = useRef(false);
    const started = useRef(false);
    const [status, setStatus] = useState("connecting...");
    const [role, setRole] = useState(null);

    useEffect(() => {
        if (init.current) return;
        init.current = true;

        const socket = io("http://localhost:3000");
        socketRef.current = socket;

        socket.on("connect", () => {
            console.log("connected:", socket.id);
            // Join as STUDENT
            socket.emit("join", id, "student");
        });

        socket.on("role", (r) => {
            console.log("Role assigned:", r);
            setRole(r);
        });

        socket.on("rtp", async (rtp) => {
            if (deviceRef.current) return;
            try {
                const device = new Device();
                await device.load({ routerRtpCapabilities: rtp });
                deviceRef.current = device;

                socket.emit("createTransport", { type: "send" }, (data) => {
                    if (!data || data.error) {
                        setStatus("transport error: " + data?.error);
                        return;
                    }
                    setup(device, socket, data);
                });
            } catch (e) {
                setStatus("error: " + e.message);
            }
        });

        return () => socket.disconnect();
    }, [id]);

    function setup(device, socket, data) {
        const t = device.createSendTransport({
            id: data.id,
            iceParameters: data.iceParameters,
            iceCandidates: data.iceCandidates,
            dtlsParameters: data.dtlsParameters,
        });
        transportRef.current = t;

        t.on("connect", ({ dtlsParameters }, cb, eb) => {
            socket.emit(
                "connectTransport",
                { transportId: t.id, dtlsParameters },
                (r) => (r?.connected ? cb() : eb(new Error(r?.error)))
            );
        });

        t.on("produce", ({ kind, rtpParameters, appData }, cb, eb) => {
            socket.emit(
                "produce",
                { transportId: t.id, kind, rtpParameters, appData },
                (r) => (r?.error ? eb(new Error(r.error)) : cb({ id: r.id }))
            );
        });

        t.on("connectionstatechange", (state) => {
            console.log("transport:", state);
            if (state === "connected") setStatus("streaming ✓");
            if (state === "failed") setStatus("connection failed — check server config");
        });

        setStatus("ready, starting...");
        setTimeout(() => startMedia(), 500);
    }

    async function startMedia() {
        if (started.current) return;
        started.current = true;

        const t = transportRef.current;
        if (!t) return;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 720 },
                    height: { ideal: 480 },
                    frameRate: { ideal: 25 },
                },
                audio: true,
            });

            if (videoRef.current) videoRef.current.srcObject = stream;

            // ========== ASYMMETRIC SIMULCAST ==========
            // Two layers:
            //   Layer 0 (rid: "peer")   — 360p@15fps — for other students
            //   Layer 1 (rid: "proctor")— 720p@25fps — for proctor only
            const vt = stream.getVideoTracks()[0];
            if (vt) {
                await t.produce({
                    track: vt,
                    appData: { type: "camera" },
                    encodings: [
                        {
                            rid: "peer",
                            maxBitrate: 150000,
                            scaleResolutionDownBy: 2,
                            maxFramerate: 15,
                        },
                        {
                            rid: "proctor",
                            maxBitrate: 700000,
                            scaleResolutionDownBy: 1,
                            maxFramerate: 25,
                        },
                    ],
                    codecOptions: {
                        videoGoogleStartBitrate: 300,
                    },
                });
                console.log("Video producing with 2-layer simulcast");
            }

            const at = stream.getAudioTracks()[0];
            if (at) {
                await t.produce({
                    track: at,
                    appData: { type: "camera" },
                });
                console.log("Audio producing");
            }

            setStatus("streaming ✓ (simulcast: peer + proctor layers)");
        } catch (e) {
            setStatus("error: " + e.message);
        }
    }

    return (
        <div style={{ padding: 10 }}>
            <h3>
                Room: {id} | {role || "..."} | {status}
            </h3>
            <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                style={{ width: 400, height: 300, backgroundColor: "#000" }}
            />
        </div>
    );
};

export default Room;