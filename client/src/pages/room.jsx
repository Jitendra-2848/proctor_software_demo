// Room.jsx
import React, { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { io } from "socket.io-client"
import { Device } from "mediasoup-client"

const Room = () => {
    const { id } = useParams();
    const deviceRef = useRef(null);
    const socketRef = useRef(null);
    const sendTransportRef = useRef(null);
    const videoRef = useRef(null);
    const [status, setStatus] = useState("connecting...");
    const initialized = useRef(false);

    useEffect(() => {
        // prevent double init in strict mode
        if (initialized.current) return;
        initialized.current = true;

        const socket = io("http://localhost:3000");
        socketRef.current = socket;
        const device = new Device();
        deviceRef.current = device;

        socket.on("connect", () => {
            console.log("Socket connected:", socket.id);
            socket.emit("join", id);
        });

        socket.on("rtp", async (rtp) => {
            try {
                if (!device.loaded) {
                    await device.load({ routerRtpCapabilities: rtp });
                    console.log("Device loaded");
                }

                // create send transport
                socket.emit("createTransport", { type: "send" }, (data) => {
                    if (data.error) {
                        console.error("Transport error:", data.error);
                        setStatus("transport error");
                        return;
                    }
                    setupSendTransport(device, socket, data);
                    setStatus("ready - click Start Camera");
                });
            } catch (err) {
                console.error("Device load error:", err);
                setStatus("device error");
            }
        });

        return () => {
            socket.disconnect();
        };
    }, [id]);

    function setupSendTransport(device, socket, data) {
        const transport = device.createSendTransport({
            id: data.id,
            iceParameters: data.iceParameters,
            iceCandidates: data.iceCandidates,
            dtlsParameters: data.dtlsParameters,
        });
        sendTransportRef.current = transport;

        transport.on("connect", ({ dtlsParameters }, cb, errback) => {
            socket.emit("connectTransport", {
                transportId: transport.id,
                dtlsParameters,
            }, (res) => {
                if (res.connected) cb();
                else errback(new Error(res.error || "connect failed"));
            });
        });

        transport.on("produce", ({ kind, rtpParameters, appData }, cb, errback) => {
            socket.emit("produce", {
                transportId: transport.id,
                kind,
                rtpParameters,
                appData,
            }, (res) => {
                if (res.error) errback(new Error(res.error));
                else cb({ id: res.id });
            });
        });

        console.log("Send transport ready");
    }

    async function getMedia() {
        try {
            const transport = sendTransportRef.current;
            if (!transport) {
                alert("Transport not ready yet");
                return;
            }

            const stream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true,
            });

            if (videoRef.current) videoRef.current.srcObject = stream;

            const videoTrack = stream.getVideoTracks()[0];
            if (videoTrack) {
                await transport.produce({
                    track: videoTrack,
                    appData: { type: "camera" },
                });
                console.log("Video producing");
            }

            const audioTrack = stream.getAudioTracks()[0];
            if (audioTrack) {
                await transport.produce({
                    track: audioTrack,
                    appData: { type: "camera" },
                });
                console.log("Audio producing");
            }

            setStatus("streaming ✓");
        } catch (err) {
            console.error("Media error:", err);
            setStatus("media error: " + err.message);
        }
    }

    return (
        <div style={{ padding: 10 }}>
            <h3>Room: {id}</h3>
            <p>Status: {status}</p>
            <video ref={videoRef} autoPlay muted playsInline
                style={{ width: 400, height: 300, backgroundColor: "#000" }} />
            <br />
            <button onClick={getMedia}>Start Camera</button>
        </div>
    );
};

export default Room;