// fakeStudent.js — Efficient: shares ffmpeg decoders across all bots
// Usage:
//   node fakeStudent.js room1 1
//   node fakeStudent.js room1 10
//   node fakeStudent.js room1 10 1500

import { io } from "socket.io-client";
import { Device } from "mediasoup-client";
import pkg from "@roamhq/wrtc";
import { spawn, execSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const {
  nonstandard,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  MediaStream,
  MediaStreamTrack,
} = pkg;
const { RTCAudioSource, RTCVideoSource } = nonstandard;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVER  = process.env.SERVER || "http://localhost:3000";
const ROOM_ID = process.argv[2] || "room1";
const NUM     = parseInt(process.argv[3] || "1", 10);
const DELAY   = parseInt(process.argv[4] || "1500", 10);

const VIDEO_FILE = path.join(__dirname, "public", "x.mp4");
const VIDEO_FILE2 = path.join(__dirname, "public", "x2.mp4");
const AUDIO_FILE = path.join(__dirname, "public", "x.mp3");

const CAM_W = 320, CAM_H = 240, CAM_FPS = 15;
const SCR_W = 480, SCR_H = 360, SCR_FPS = 5;  // lower res+fps for screen
const SR = 48000;

const CAM_FRAME_SIZE    = Math.floor(CAM_W * CAM_H * 3 / 2);
const SCR_FRAME_SIZE    = Math.floor(SCR_W * SCR_H * 3 / 2);
const SAMPLES_PER_FRAME = Math.floor(SR / 100);
const BYTES_PER_AUDIO   = SAMPLES_PER_FRAME * 2;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function log(i, m) { console.log(`[${ts()}][bot-${i}] ${m}`); }
function ok(i, m)  { console.log(`[${ts()}][bot-${i}] ✅ ${m}`); }
function err(i, m) { console.error(`[${ts()}][bot-${i}] ❌ ${m}`); }
function ts()      { return new Date().toLocaleTimeString(); }

globalThis.RTCPeerConnection     = RTCPeerConnection;
globalThis.RTCSessionDescription = RTCSessionDescription;
globalThis.RTCIceCandidate       = RTCIceCandidate;
globalThis.MediaStream           = MediaStream;
globalThis.MediaStreamTrack      = MediaStreamTrack;

try {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Mozilla/5.0 Chrome/120.0.0.0" },
    writable: true, configurable: true,
  });
} catch (_) {
  try {
    Object.defineProperty(globalThis.navigator, "userAgent", {
      value: "Mozilla/5.0 Chrome/120.0.0.0",
      writable: true, configurable: true,
    });
  } catch (_2) {}
}

// ─── PRE-FLIGHT ──────────────────────────────────────────────────
console.log("\n=== PRE-FLIGHT ===");
try {
  const v = execSync("ffmpeg -version", { encoding: "utf8", timeout: 5000 });
  console.log(`ffmpeg: ✅ ${v.split("\n")[0]}`);
} catch (e) { console.error("❌ ffmpeg not found!"); process.exit(1); }
if (!existsSync(VIDEO_FILE)) { console.error(`❌ Not found: ${VIDEO_FILE}`); process.exit(1); }
if (!existsSync(AUDIO_FILE)) { console.error(`❌ Not found: ${AUDIO_FILE}`); process.exit(1); }

console.log(`Server: ${SERVER}`);
console.log(`Video:  ${VIDEO_FILE}`);
console.log(`Audio:  ${AUDIO_FILE}`);
console.log(`Camera: ${CAM_W}x${CAM_H}@${CAM_FPS}fps`);
console.log(`Screen: ${SCR_W}x${SCR_H}@${SCR_FPS}fps`);

try { const td = new Device(); console.log(`Device: ${td.handlerName}`); }
catch (e) { console.error("Device FAILED:", e.message); process.exit(1); }
console.log("=== OK ===\n");

// ═══════════════════════════════════════════════════════════════════
// SHARED DECODERS — ONE ffmpeg per media type, feeds ALL bots
// Instead of 10 bots × 3 ffmpeg = 30 processes
// We run ONLY 3 ffmpeg total, broadcast frames to all bot sources
// ═══════════════════════════════════════════════════════════════════

class SharedVideoDecoder {
  constructor(label, filePath, w, h, fps) {
    this.label = label;
    this.filePath = filePath;
    this.w = w;
    this.h = h;
    this.fps = fps;
    this.frameSize = Math.floor(w * h * 3 / 2);
    this.listeners = []; // array of RTCVideoSource
    this.killed = false;
    this.proc = null;
    this.frameCount = 0;
    this.lastFrame = null; // cache last frame for late joiners
  }

  addSource(videoSource) {
    this.listeners.push(videoSource);
    // feed last frame immediately so track isn't empty
    if (this.lastFrame) {
      try {
        const data = new Uint8ClampedArray(this.lastFrame);
        videoSource.onFrame({ width: this.w, height: this.h, data });
      } catch (_) {}
    }
  }

  removeSource(videoSource) {
    this.listeners = this.listeners.filter(s => s !== videoSource);
  }

  start() {
    if (this.killed) return;

    this.proc = spawn("ffmpeg", [
      "-re",
      "-stream_loop", "-1",
      "-i", this.filePath,
      "-vf", `scale=${this.w}:${this.h}`,
      "-r", String(this.fps),
      "-pix_fmt", "yuv420p",
      "-f", "rawvideo",
      "-an",
      "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let buf = Buffer.alloc(0);

    this.proc.stderr.on("data", () => {}); // suppress

    this.proc.stdout.on("data", (chunk) => {
      if (this.killed) return;
      buf = Buffer.concat([buf, chunk]);

      while (buf.length >= this.frameSize) {
        const raw = buf.subarray(0, this.frameSize);
        buf = buf.subarray(this.frameSize);

        // copy once, reuse for all listeners
        const frameCopy = new Uint8ClampedArray(this.frameSize);
        for (let j = 0; j < this.frameSize; j++) frameCopy[j] = raw[j];

        this.lastFrame = frameCopy;
        this.frameCount++;

        if (this.frameCount === 1) console.log(`[shared-${this.label}] ✅ first frame`);
        if (this.frameCount % (this.fps * 60) === 0) {
          console.log(`[shared-${this.label}] frames: ${this.frameCount}, listeners: ${this.listeners.length}`);
        }

        // broadcast to all bot sources
        for (let i = 0; i < this.listeners.length; i++) {
          try {
            // each source needs its own copy to avoid conflicts
            const copy = new Uint8ClampedArray(frameCopy);
            this.listeners[i].onFrame({ width: this.w, height: this.h, data: copy });
          } catch (_) {}
        }
      }
    });

    this.proc.on("error", (e) => {
      if (!this.killed) console.error(`[shared-${this.label}] ❌ ffmpeg error: ${e.message}`);
    });

    this.proc.on("close", (code) => {
      if (!this.killed) {
        console.log(`[shared-${this.label}] ffmpeg exited (${code}), restarting...`);
        setTimeout(() => this.start(), 1000);
      }
    });
  }

  kill() {
    this.killed = true;
    try { this.proc?.kill("SIGKILL"); } catch (_) {}
  }
}

class SharedAudioDecoder {
  constructor(filePath) {
    this.filePath = filePath;
    this.listeners = []; // array of RTCAudioSource
    this.killed = false;
    this.proc = null;
    this.frameCount = 0;
  }

  addSource(audioSource) {
    this.listeners.push(audioSource);
  }

  removeSource(audioSource) {
    this.listeners = this.listeners.filter(s => s !== audioSource);
  }

  start() {
    if (this.killed) return;

    this.proc = spawn("ffmpeg", [
      "-re",
      "-stream_loop", "-1",
      "-i", this.filePath,
      "-ar", String(SR),
      "-ac", "1",
      "-f", "s16le",
      "-acodec", "pcm_s16le",
      "-vn",
      "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let buf = Buffer.alloc(0);

    this.proc.stderr.on("data", () => {});

    this.proc.stdout.on("data", (chunk) => {
      if (this.killed) return;
      buf = Buffer.concat([buf, chunk]);

      while (buf.length >= BYTES_PER_AUDIO) {
        const raw = buf.subarray(0, BYTES_PER_AUDIO);
        buf = buf.subarray(BYTES_PER_AUDIO);

        const aligned = Buffer.alloc(BYTES_PER_AUDIO);
        raw.copy(aligned);
        const masterSamples = new Int16Array(
          aligned.buffer, aligned.byteOffset, SAMPLES_PER_FRAME
        );

        this.frameCount++;
        if (this.frameCount === 1) console.log(`[shared-audio] ✅ first frame`);
        if (this.frameCount % 6000 === 0) {
          console.log(`[shared-audio] frames: ${this.frameCount}, listeners: ${this.listeners.length}`);
        }

        for (let i = 0; i < this.listeners.length; i++) {
          try {
            // each source needs its own copy
            const copy = new Int16Array(masterSamples);
            this.listeners[i].onData({
              samples: copy,
              sampleRate: SR,
              bitsPerSample: 16,
              channelCount: 1,
              numberOfFrames: SAMPLES_PER_FRAME,
            });
          } catch (_) {}
        }
      }
    });

    this.proc.on("error", (e) => {
      if (!this.killed) console.error(`[shared-audio] ❌ ffmpeg error: ${e.message}`);
    });

    this.proc.on("close", (code) => {
      if (!this.killed) {
        console.log(`[shared-audio] ffmpeg exited (${code}), restarting...`);
        setTimeout(() => this.start(), 1000);
      }
    });
  }

  kill() {
    this.killed = true;
    try { this.proc?.kill("SIGKILL"); } catch (_) {}
  }
}

// create shared decoders (only 3 ffmpeg total!)
const sharedCamVideo = new SharedVideoDecoder("camera", VIDEO_FILE, CAM_W, CAM_H, CAM_FPS);
const sharedScrVideo = new SharedVideoDecoder("screen", VIDEO_FILE2, SCR_W, SCR_H, SCR_FPS);
const sharedAudio    = new SharedAudioDecoder(AUDIO_FILE);

// ─── CREATE ONE BOT ──────────────────────────────────────────────
function createStudent(index) {
  return new Promise((resolve, reject) => {
    log(index, "=== STARTING ===");

    let resolved = false;

    const camVideoSrc = new RTCVideoSource();
    const camAudioSrc = new RTCAudioSource();
    const scrVideoSrc = new RTCVideoSource();
    const camVideoTrack = camVideoSrc.createTrack();
    const camAudioTrack = camAudioSrc.createTrack();
    const scrVideoTrack = scrVideoSrc.createTrack();

    // register with shared decoders
    sharedCamVideo.addSource(camVideoSrc);
    sharedAudio.addSource(camAudioSrc);
    sharedScrVideo.addSource(scrVideoSrc);

    ok(index, `tracks: camV=${camVideoTrack.readyState} camA=${camAudioTrack.readyState} scrV=${scrVideoTrack.readyState}`);

    function cleanup() {
      sharedCamVideo.removeSource(camVideoSrc);
      sharedAudio.removeSource(camAudioSrc);
      sharedScrVideo.removeSource(scrVideoSrc);
    }

    const socket = io(SERVER, { reconnection: false, timeout: 10000 });

    const timeout = setTimeout(() => {
      if (!resolved) {
        err(index, "TIMEOUT 30s");
        cleanup(); socket.disconnect();
        resolved = true; reject(new Error("timeout"));
      }
    }, 30000);

    socket.on("connect_error", (e) => {
      if (!resolved) {
        err(index, `socket error: ${e.message}`);
        clearTimeout(timeout); cleanup();
        resolved = true; reject(e);
      }
    });

    socket.on("connect", () => {
      ok(index, `socket: ${socket.id}`);
      socket.emit("join", ROOM_ID);
    });

    socket.on("disconnect", (r) => log(index, `disconnected: ${r}`));

    let rtpHandled = false;
    socket.on("rtp", async (rtp) => {
      if (rtpHandled) return;
      rtpHandled = true;
      ok(index, `RTP: ${rtp.codecs?.length || 0} codecs`);

      try {
        if (!rtp?.codecs?.length) throw new Error("empty RTP");

        const device = new Device();
        await device.load({ routerRtpCapabilities: rtp });
        ok(index, `device: ${device.handlerName}`);

        if (!device.canProduce("video")) throw new Error("cannot produce video");
        if (!device.canProduce("audio")) throw new Error("cannot produce audio");

        socket.emit("createTransport", { type: "send" }, async (data) => {
          try {
            if (!data || data.error) throw new Error(data?.error || "null transport");
            if (!data.id || !data.iceParameters || !data.iceCandidates || !data.dtlsParameters) {
              throw new Error(`missing fields: ${JSON.stringify(Object.keys(data))}`);
            }

            ok(index, `transport: ${data.id.slice(0, 8)}...`);

            const transport = device.createSendTransport({
              id: data.id,
              iceParameters: data.iceParameters,
              iceCandidates: data.iceCandidates,
              dtlsParameters: data.dtlsParameters,
            });

            transport.on("connect", ({ dtlsParameters }, cb, eb) => {
              socket.emit("connectTransport", {
                transportId: transport.id, dtlsParameters,
              }, (r) => {
                if (r?.connected) { ok(index, "DTLS connected"); cb(); }
                else eb(new Error(r?.error || "connect fail"));
              });
            });

            transport.on("produce", ({ kind, rtpParameters, appData }, cb, eb) => {
              log(index, `produce → ${kind} (${appData?.type || "?"})`);
              socket.emit("produce", {
                transportId: transport.id, kind, rtpParameters, appData,
              }, (r) => {
                if (!r || r.error || !r.id) eb(new Error(r?.error || "produce fail"));
                else { ok(index, `producer: ${r.id.slice(0, 8)}... (${kind} ${appData?.type})`); cb({ id: r.id }); }
              });
            });

            transport.on("connectionstatechange", (s) => {
              if (s === "connected")         ok(index, "🟢 CONNECTED!");
              else if (s === "failed")       err(index, "🔴 ICE FAILED");
              else if (s === "disconnected") err(index, "🟠 disconnected");
              else log(index, `ICE: ${s}`);
            });

            // frames are already being fed by shared decoders
            // just wait a bit for some frames to be ready
            log(index, "waiting for shared decoder frames...");
            await sleep(800);

            log(index, "producing camera video...");
            const camVP = await transport.produce({
              track: camVideoTrack,
              appData: { type: "camera" },
              encodings: [{ maxBitrate: 150000 }],
            });

            log(index, "producing camera audio...");
            const camAP = await transport.produce({
              track: camAudioTrack,
              appData: { type: "camera" },
            });

            log(index, "producing screen video...");
            const scrVP = await transport.produce({
              track: scrVideoTrack,
              appData: { type: "screen" },
              encodings: [{ maxBitrate: 300000 }],
            });

            clearTimeout(timeout);
            ok(index, "══════ STREAMING: camera + audio + screen ══════");

            camVP.on("trackended", () => err(index, "camera video ended!"));
            camAP.on("trackended", () => err(index, "camera audio ended!"));
            scrVP.on("trackended", () => err(index, "screen video ended!"));

            const si = setInterval(() => {
              log(index, `STATUS: ice=${transport.connectionState} camV=${camVideoTrack.readyState} camA=${camAudioTrack.readyState} scrV=${scrVideoTrack.readyState}`);
            }, 30000); // less frequent status

            resolved = true;
            resolve({
              index,
              stop: () => {
                clearInterval(si);
                cleanup();
                try { if (!transport.closed) transport.close(); } catch (_) {}
                socket.disconnect();
                log(index, "stopped");
              },
            });

          } catch (e) {
            if (!resolved) {
              clearTimeout(timeout); cleanup();
              err(index, `error: ${e.message}`);
              resolved = true; reject(e);
            }
          }
        });
      } catch (e) {
        if (!resolved) {
          clearTimeout(timeout); cleanup();
          err(index, `device error: ${e.message}`);
          resolved = true; reject(e);
        }
      }
    });
  });
}

// ─── MAIN ────────────────────────────────────────────────────────
(async () => {
  process.on("unhandledRejection", (r) => console.error(`\n❌ Unhandled: ${r}`));
  await sleep(300);

  console.log("╔════════════════════════════════════════════════════╗");
  console.log(`║  Server:  ${SERVER.padEnd(40)}║`);
  console.log(`║  Room:    ${ROOM_ID.padEnd(40)}║`);
  console.log(`║  Bots:    ${String(NUM).padEnd(40)}║`);
  console.log(`║  Camera:  ${(`${CAM_W}x${CAM_H}@${CAM_FPS}fps`).padEnd(40)}║`);
  console.log(`║  Screen:  ${(`${SCR_W}x${SCR_H}@${SCR_FPS}fps`).padEnd(40)}║`);
  console.log(`║  Audio:   ${(`${SR}Hz mono`).padEnd(40)}║`);
  console.log(`║  FFmpeg:  3 total (shared across all bots)${" ".repeat(9)}║`);
  console.log("╚════════════════════════════════════════════════════╝\n");

  // start shared decoders ONCE
  console.log("Starting shared decoders (3 ffmpeg total)...");
  sharedCamVideo.start();
  sharedScrVideo.start();
  sharedAudio.start();

  // wait for first frames
  await sleep(2000);
  console.log("Shared decoders ready. Starting bots...\n");

  const bots = [];
  let fails = 0;

  for (let i = 0; i < NUM; i++) {
    try {
      bots.push(await createStudent(i));
      ok(i, `bot ${i} live ✅`);
    } catch (e) {
      err(i, `FAILED: ${e.message}`);
      fails++;
    }
    if (i < NUM - 1) await sleep(DELAY);
  }

  console.log(`\n✅ ${bots.length} streaming | ❌ ${fails} failed | Ctrl+C to stop`);
  console.log(`📊 Total ffmpeg processes: 3 (not ${NUM * 3})\n`);

  process.on("SIGINT", () => {
    console.log("\n🛑 Stopping...");
    bots.forEach(b => b.stop());
    sharedCamVideo.kill();
    sharedScrVideo.kill();
    sharedAudio.kill();
    setTimeout(() => process.exit(0), 2000);
  });
})();