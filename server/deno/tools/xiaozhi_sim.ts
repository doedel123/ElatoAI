/**
 * XIAOZHI device simulator — exercises the server end-to-end without hardware.
 *
 * Mirrors the warble Go test client (server/cmd/testclient): OTA bootstrap ->
 * WebSocket connect -> hello exchange -> drive a turn and validate the reply
 * sequence (stt / tts.start / tts.sentence_start / opus audio / tts.stop).
 *
 * Because Deno's WebSocket client can't set request headers, the device MAC is
 * passed to the server as a `?device_id=` query param (the server accepts both).
 *
 * Run:
 *   deno run --allow-net --allow-read --allow-env tools/xiaozhi_sim.ts \
 *     --ota https://elatoai.aionetwo.deno.net/xiaozhi/ota/ \
 *     --device aa:bb:cc:dd:ee:ff \
 *     --scenario full --fixture speech.wav
 *
 * Scenarios: hello | full | barge      Fixtures: wire | tone | <path-to-mono16.wav>
 */

import { Decoder, Encoder } from "@evan/opus";

const UPSTREAM_HZ = 16000;
const DOWNSTREAM_HZ = 24000;
const FRAME_MS = 60;
const SAMPLES_PER_FRAME = UPSTREAM_HZ * FRAME_MS / 1000; // 960

// ---- args ----------------------------------------------------------------
function parseArgs(argv: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith("--")) {
            const key = argv[i].slice(2);
            const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
            out[key] = val;
        }
    }
    return out;
}
const args = parseArgs(Deno.args);
const otaURL = args.ota ?? "https://elatoai.aionetwo.deno.net/xiaozhi/ota/";
const deviceID = args.device ?? "aa:bb:cc:dd:ee:ff";
const clientID = args.client ?? "elato-xiaozhi-sim-0001";
const scenario = args.scenario ?? "full";
const fixture = args.fixture ?? "tone";
const bargeAfter = Number(args["barge-after"] ?? "5");
const timeoutMs = Number(args.timeout ?? "30000");
// --photo <jpg>: act as a camera device. Responds to the server's take_photo
// MCP call by uploading this JPEG to the advertised vision URL.
const photoPath = args.photo;

// Vision config the server hands us via MCP initialize.
let visionCfg: { url: string; token: string } | null = null;

const log = (...a: unknown[]) => console.log(`[${(new Date()).toISOString().slice(11, 23)}]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- audio helpers -------------------------------------------------------
function resamplePcm16(pcm: Int16Array, from: number, to: number): Int16Array {
    if (from === to) return pcm;
    const out = new Int16Array(Math.max(1, Math.floor(pcm.length * to / from)));
    for (let i = 0; i < out.length; i++) {
        const sp = i * from / to;
        const l = Math.floor(sp);
        const r = Math.min(l + 1, pcm.length - 1);
        const f = sp - l;
        out[i] = Math.round(pcm[l] + (pcm[r] - pcm[l]) * f);
    }
    return out;
}

function parseWavMono16(bytes: Uint8Array): { pcm: Int16Array; rate: number } {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
    if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");
    let off = 12, rate = 16000, channels = 1, bits = 16, dataOff = -1, dataLen = 0;
    while (off + 8 <= bytes.length) {
        const id = tag(off);
        const size = dv.getUint32(off + 4, true);
        if (id === "fmt ") {
            channels = dv.getUint16(off + 10, true);
            rate = dv.getUint32(off + 12, true);
            bits = dv.getUint16(off + 22, true);
        } else if (id === "data") {
            dataOff = off + 8;
            dataLen = size;
        }
        off += 8 + size + (size % 2);
    }
    if (dataOff < 0) throw new Error("no data chunk");
    if (bits !== 16) throw new Error(`only 16-bit PCM supported (got ${bits}-bit)`);
    const total = Math.floor(dataLen / 2);
    const interleaved = new Int16Array(total);
    for (let i = 0; i < total; i++) interleaved[i] = dv.getInt16(dataOff + i * 2, true);
    if (channels === 1) return { pcm: interleaved, rate };
    const mono = new Int16Array(Math.floor(total / channels));
    for (let i = 0; i < mono.length; i++) {
        let s = 0;
        for (let c = 0; c < channels; c++) s += interleaved[i * channels + c];
        mono[i] = Math.round(s / channels);
    }
    return { pcm: mono, rate };
}

function tonePcm(seconds: number, freq = 440): Int16Array {
    const n = Math.floor(seconds * UPSTREAM_HZ);
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin(2 * Math.PI * freq * i / UPSTREAM_HZ) * 8000);
    return out;
}

function encodeFixture(): Uint8Array[] {
    if (fixture === "wire") return []; // handled separately (garbage frames)
    let pcm: Int16Array;
    if (fixture === "tone") {
        pcm = tonePcm(1.5);
        log("fixture: 1.5s synthetic 440Hz tone (audio-path smoke; won't transcribe)");
    } else {
        const { pcm: raw, rate } = parseWavMono16(Deno.readFileSync(fixture));
        pcm = resamplePcm16(raw, rate, UPSTREAM_HZ);
        log(`fixture: ${fixture} (${raw.length} samples @ ${rate}Hz -> ${pcm.length} @ ${UPSTREAM_HZ}Hz)`);
    }
    const enc = new Encoder({ channels: 1, sample_rate: UPSTREAM_HZ, application: "voip" });
    enc.expert_frame_duration = 60;
    enc.bitrate = 16000;
    const frames: Uint8Array[] = [];
    for (let i = 0; i + SAMPLES_PER_FRAME <= pcm.length; i += SAMPLES_PER_FRAME) {
        const frame = pcm.subarray(i, i + SAMPLES_PER_FRAME);
        const view = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
        frames.push(enc.encode(view).slice());
    }
    return frames;
}

// ---- OTA bootstrap -------------------------------------------------------
async function bootstrap(): Promise<string> {
    const resp = await fetch(otaURL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Device-Id": deviceID,
            "Client-Id": clientID,
            "User-Agent": "elato-xiaozhi-sim/0.1",
        },
        body: JSON.stringify({ version: 1, application: { version: "0.0.0" } }),
    });
    if (resp.status !== 200) throw new Error(`OTA status=${resp.status} body=${await resp.text()}`);
    const data = await resp.json();
    const url = data?.websocket?.url;
    if (!url) throw new Error("OTA response missing websocket.url");
    if (!data?.server_time?.timestamp) throw new Error("OTA response missing server_time.timestamp");
    log(`ota.ok ws=${url} server_time=${data.server_time.timestamp} fw=${data.firmware?.version}`);
    return url.replace("ws://0.0.0.0", "ws://127.0.0.1");
}

// ---- WebSocket plumbing --------------------------------------------------
type Msg = { kind: "text"; data: string } | { kind: "bin"; data: Uint8Array };

class Conn {
    private inbox: Msg[] = [];
    private waiter: (() => void) | null = null;
    closed = false;
    closeInfo = "";
    constructor(private ws: WebSocket) {
        ws.binaryType = "arraybuffer";
        ws.onmessage = (e) => {
            this.inbox.push(
                typeof e.data === "string"
                    ? { kind: "text", data: e.data }
                    : { kind: "bin", data: new Uint8Array(e.data as ArrayBuffer) },
            );
            this.wake();
        };
        ws.onclose = (e) => {
            this.closed = true;
            this.closeInfo = `code=${e.code} reason=${e.reason}`;
            this.wake();
        };
        ws.onerror = () => {
            this.closed = true;
            this.wake();
        };
    }
    private wake() {
        this.waiter?.();
        this.waiter = null;
    }
    sendText(v: unknown) {
        this.ws.send(JSON.stringify(v));
    }
    sendBin(b: Uint8Array) {
        this.ws.send(b);
    }
    async recv(deadline: number): Promise<Msg | null> {
        while (this.inbox.length === 0) {
            if (this.closed) return null;
            const remaining = deadline - Date.now();
            if (remaining <= 0) return null;
            await Promise.race([
                new Promise<void>((r) => (this.waiter = r)),
                sleep(remaining),
            ]);
        }
        return this.inbox.shift()!;
    }
    close() {
        try {
            this.ws.close();
        } catch { /* ignore */ }
    }
}

function connect(wsBase: string): Promise<Conn> {
    const u = new URL(wsBase);
    u.searchParams.set("device_id", deviceID);
    const ws = new WebSocket(u.toString());
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("ws connect timeout")), 10000);
        ws.onopen = () => {
            clearTimeout(t);
            resolve(new Conn(ws));
        };
        ws.onerror = () => {
            clearTimeout(t);
            reject(new Error("ws connect error (auth rejected? check device MAC is registered)"));
        };
    });
}

async function exchangeHello(conn: Conn): Promise<string> {
    conn.sendText({
        type: "hello",
        version: 1,
        transport: "websocket",
        features: { mcp: true },
        audio_params: { format: "opus", sample_rate: 16000, channels: 1, frame_duration: 60 },
    });
    log("→ hello");
    const deadline = Date.now() + 10000;
    while (true) {
        const m = await conn.recv(deadline);
        if (!m) throw new Error(`no server hello within 10s (${conn.closeInfo})`);
        if (m.kind !== "text") continue;
        const h = JSON.parse(m.data);
        if (h.type !== "hello" || h.transport !== "websocket" || !h.session_id) {
            throw new Error(`bad server hello: ${m.data}`);
        }
        log(`← hello session=${h.session_id} rate=${h.audio_params?.sample_rate} frame_ms=${h.audio_params?.frame_duration}`);
        return h.session_id;
    }
}

async function sendAudio(conn: Conn) {
    if (fixture === "wire") {
        for (let i = 0; i < 5; i++) conn.sendBin(new Uint8Array(80));
        log("→ 5 garbage frames (wire mode — server should log decode errors, no turn)");
        return;
    }
    const frames = encodeFixture();
    log(`→ streaming ${frames.length} opus frames (${(frames.length * FRAME_MS / 1000).toFixed(1)}s) paced at ${FRAME_MS}ms`);
    for (const f of frames) {
        conn.sendBin(f);
        await sleep(FRAME_MS);
    }
}

// ---- MCP (camera) device side --------------------------------------------
async function uploadPhoto(question: string): Promise<string> {
    if (!visionCfg) return JSON.stringify({ success: false, result: "no vision url configured" });
    if (!photoPath) {
        return JSON.stringify({ success: true, result: "(simulated camera: pass --photo <jpg> to upload a real image)" });
    }
    const jpeg = Deno.readFileSync(photoPath);
    const fd = new FormData();
    fd.set("question", question);
    fd.set("file", new Blob([jpeg], { type: "image/jpeg" }), "camera.jpg");
    const resp = await fetch(visionCfg.url, {
        method: "POST",
        headers: { "Device-Id": deviceID, "Client-Id": clientID, "Authorization": `Bearer ${visionCfg.token}` },
        body: fd,
    });
    return await resp.text();
}

async function handleSimMcp(conn: Conn, payload: any) {
    if (!payload) return;
    const { id, method, params } = payload;
    if (method === "initialize") {
        const vision = params?.capabilities?.vision;
        if (vision?.url) {
            visionCfg = { url: vision.url, token: vision.token ?? "" };
            log(`← mcp initialize (vision url=${vision.url})`);
        }
        conn.sendText({
            type: "mcp",
            payload: { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "elato-sim", version: "0.1" } } },
        });
    } else if (method === "tools/call") {
        const name = params?.name;
        let text: string;
        if (name === "self.camera.take_photo") {
            log(`← mcp take_photo question=${JSON.stringify(params?.arguments?.question ?? "")} -> uploading to vision URL`);
            text = await uploadPhoto(params?.arguments?.question ?? "");
        } else if (name === "self.get_device_status") {
            log("← mcp get_device_status");
            text = JSON.stringify({ battery: { level: 88, charging: false }, audio_speaker: { volume: 70 } });
        } else {
            // set_volume / set_brightness / set_theme — simulate executing it.
            log(`← mcp ${name} args=${JSON.stringify(params?.arguments ?? {})} (simulated)`);
            text = JSON.stringify({ success: true });
        }
        conn.sendText({ type: "mcp", payload: { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: false } } });
        log(`→ mcp tool result: ${text.slice(0, 120)}`);
    } else if (method === "notifications/initialized") {
        // no-op
    } else if (id != null) {
        conn.sendText({ type: "mcp", payload: { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } } });
    }
}

// ---- turn expectation ----------------------------------------------------
async function expectTurn(conn: Conn, sessionID: string, bargeAt = 0): Promise<boolean> {
    const dec = new Decoder({ channels: 1, sample_rate: DOWNSTREAM_HZ });
    let seenStt = false, seenStart = false, seenSentence = false;
    let audioFrames = 0, audioSamples = 0;
    let emotion = "";
    let bargeSent = 0;
    const sentences: string[] = [];
    const deadline = Date.now() + timeoutMs;

    while (true) {
        const m = await conn.recv(deadline);
        if (!m) {
            log(conn.closed ? `server closed (${conn.closeInfo})` : "timeout waiting for tts.stop");
            break;
        }
        if (m.kind === "bin") {
            audioFrames++;
            try {
                audioSamples += dec.decode(m.data).length / 2;
            } catch { /* count anyway */ }
            if (bargeAt > 0 && !bargeSent && audioFrames >= bargeAt) {
                conn.sendText({ type: "abort", session_id: sessionID, reason: "wake_word_detected" });
                bargeSent = Date.now();
                log(`→ abort (after ${audioFrames} audio frames)`);
            }
            continue;
        }
        const env = JSON.parse(m.data);
        switch (env.type) {
            case "stt":
                log(`← stt  text=${JSON.stringify(env.text)}`);
                seenStt = true;
                break;
            case "llm":
                log(`← llm  emotion=${JSON.stringify(env.emotion)}`);
                emotion = env.emotion;
                break;
            case "tts":
                if (env.state === "start") { seenStart = true; log("← tts.start"); }
                else if (env.state === "sentence_start") { seenSentence = true; sentences.push(env.text); log(`← tts.sentence_start text=${JSON.stringify(env.text)}`); }
                else if (env.state === "stop") {
                    log("← tts.stop");
                    if (bargeSent) log(`barge: tts.stop arrived ${Date.now() - bargeSent}ms after abort`);
                    return summarize(seenStt, seenStart, seenSentence, audioFrames, audioSamples, emotion, sentences, bargeAt > 0, !!bargeSent);
                }
                break;
            case "mcp":
                await handleSimMcp(conn, env.payload);
                break;
            case "alert":
                log(`← alert status=${env.status} message=${JSON.stringify(env.message)}`);
                return false;
            default:
                log(`← ${env.type}`);
        }
    }
    return summarize(seenStt, seenStart, seenSentence, audioFrames, audioSamples, emotion, sentences, bargeAt > 0, !!bargeSent);
}

function summarize(
    stt: boolean, start: boolean, sentence: boolean, frames: number, samples: number,
    emotion: string, sentences: string[], wasBarge: boolean, barged: boolean,
): boolean {
    const audioSec = (samples / DOWNSTREAM_HZ).toFixed(2);
    log("─".repeat(60));
    log(`summary: stt=${stt} tts.start=${start} sentence_start=${sentence} audio_frames=${frames} (~${audioSec}s) emotion=${emotion || "—"}`);
    if (sentences.length) log(`subtitles: ${sentences.map((s) => JSON.stringify(s)).join(" | ")}`);
    const issues: string[] = [];
    if (!start && frames > 0) issues.push("got audio but no tts.start");
    if (frames > 0 && !sentence) issues.push("got audio but no sentence_start");
    if (wasBarge && !barged) issues.push("barge: never triggered (clean stop first)");
    if (frames === 0) issues.push("no audio frames — likely the fixture wasn't speech (try a WAV of real speech)");
    if (issues.length) { log("⚠️  " + issues.join("; ")); return frames > 0 && start; }
    log("✅ turn OK");
    return true;
}

// ---- scenarios -----------------------------------------------------------
async function runFull(conn: Conn, sessionID: string, bargeAt = 0): Promise<boolean> {
    conn.sendText({ type: "listen", session_id: sessionID, state: "start", mode: "auto" });
    log("→ listen.start");
    await sendAudio(conn);
    conn.sendText({ type: "listen", session_id: sessionID, state: "stop" });
    log("→ listen.stop");
    return await expectTurn(conn, sessionID, bargeAt);
}

async function main() {
    log(`scenario=${scenario} device=${deviceID} fixture=${fixture}`);
    const wsBase = await bootstrap();
    const conn = await connect(wsBase);
    log("ws.connected");
    const sessionID = await exchangeHello(conn);

    let ok = true;
    if (scenario === "hello") {
        log("✅ handshake OK (OTA + hello exchange)");
    } else if (scenario === "full") {
        ok = await runFull(conn, sessionID);
    } else if (scenario === "barge") {
        ok = await runFull(conn, sessionID, bargeAfter);
    } else {
        log(`unknown scenario: ${scenario} (use hello | full | barge)`);
        ok = false;
    }
    conn.close();
    Deno.exit(ok ? 0 : 1);
}

main().catch((e) => {
    log("❌ " + (e instanceof Error ? e.message : String(e)));
    Deno.exit(1);
});
