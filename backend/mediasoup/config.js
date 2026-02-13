import os from "os";

const core = os.cpus().length || 1;

export const config = {
    listenIp: "0.0.0.0",
    listenPort: 3001,
    mediasoup: {
        numworker: core,
        worker: {
            rtcMinPort: 3100,
            rtcMaxPort: 3200 + (core * 100), // more ports for more workers
            logLevel: "warn",
            logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
        },
        router: {
            mediaCodecs: [
                {
                    kind: "video",
                    mimeType: "video/VP8",
                    clockRate: 90000,
                    parameters: {
                        "x-google-start-bitrate": 300,
                    },
                },
                {
                    kind: "audio",
                    mimeType: "audio/opus",
                    clockRate: 48000,
                    channels: 2,
                    parameters: {
                        minptime: 10,
                        useinbandfec: 1,
                    },
                },
            ],
        },
        webRtcTransport: {
            listenIps: [
                {
                    ip: "0.0.0.0",
                    announcedIp: "127.0.0.1",
                },
            ],
        },
        initialAvailableOutgoingBitrate: 300000,
        minimumAvailableOutgoingBitrate: 100000,
    },

    // OmniView specific config
    omniview: {
        // QoS Priority levels
        priority: {
            AUDIO: 0,          // P0 — never drop
            PROCTOR_VIDEO: 1,  // P1 — proctor-bound video
            STUDENT_VIDEO: 2,  // P2 — student-bound video
            SCREEN_SHARE: 3,   // P3 — screen share
            DATA: 4,           // P4 — data channels
        },

        // Simulcast layers
        layers: {
            // High quality — only sent to proctor
            proctor: {
                maxBitrate: 700000,   // 700kbps
                scaleResolutionDownBy: 1,
                maxFramerate: 25,
            },
            // Low quality — sent to other students
            peer: {
                maxBitrate: 150000,   // 150kbps
                scaleResolutionDownBy: 2,
                maxFramerate: 15,
            },
        },

        // Student downstream limit
        maxActiveStreamsForStudent: 4, // only show 4 active speakers to students

        // Bandwidth thresholds
        bandwidth: {
            minStudentUplink: 256000,   // 256kbps minimum
            audioReserve: 64000,        // always reserve 64kbps for audio
            proctorMinBitrate: 300000,  // proctor always gets 300kbps+
        },

        // Network monitoring intervals
        monitoring: {
            statsInterval: 2000,        // check stats every 2s
            degradeThreshold: 0.05,     // 5% packet loss triggers degrade
            recoverThreshold: 0.01,     // 1% packet loss allows recovery
        },
    },
};