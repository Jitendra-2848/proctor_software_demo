import os from "os";

const totalCores = os.cpus().length;
const workerCount = Math.max(2, totalCores);

export const config = {
  listenPort: 3000,

  mediasoup: {
    numWorkers: workerCount,

    worker: {
      rtcMinPort: 3100,
      rtcMaxPort: 3600, // 500 ports for many transports
      logLevel: "warn",
      logTags: ["info"],
    },

    router: {
      mediaCodecs: [
        {
          kind: "video",
          mimeType: "video/VP8",
          clockRate: 90000,
          parameters: {},
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
      initialAvailableOutgoingBitrate: 200000,
      maxIncomingBitrate: 300000,
    },
  },
};