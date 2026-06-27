/// <reference path="./types.d.ts" />

import { Buffer } from "node:buffer";
import { createOpusDecoder, resamplePcm16Mono } from "./utils.ts";

// XIAOZHI device uplink: opus, 16kHz mono. Providers want different PCM rates
// (OpenAI/Hume 24kHz, Gemini/Grok 16kHz) — set per connection via opts.
const DEVICE_SAMPLE_RATE = 16000;
const DEFAULT_UPLINK_SAMPLE_RATE = 24000;
// What we advertise/send on the downlink. The device resamples after decode.
const SERVER_DOWNLINK_SAMPLE_RATE = 24000;
const SERVER_FRAME_DURATION_MS = 60;
// Downlink pacing (PROTOCOL.md §7). Send a short burst, then release frames at
// wall-clock rate so the device's audio buffer neither overflows nor starves.
const PREBUFFER_FRAMES = 5; // 5 * 60ms = 300ms headroom
const DRAIN_DELAY_MS = 420; // wait after the queue drains before tts:stop

type MessageHandler = (data: Buffer, isBinary: boolean) => void;
type ErrorHandler = (error: unknown) => void;
type CloseHandler = (code: number, reason: string) => void;

/**
 * Wall-clock pacer for the downlink Opus stream.
 *
 * Providers (e.g. OpenAI) emit audio far faster than real time. Streaming those
 * frames straight to the device would overflow its playback buffer, so we hold
 * them and release at ~frame_duration cadence with a small prebuffer:
 *
 *   - prebuffer: the first PREBUFFER_FRAMES go out immediately (headroom)
 *   - pace: a virtual playhead advances frame_duration per frame; we sleep until
 *     wall-clock catches up to (playhead - prebuffer)
 *   - drain: once the provider signals completion AND the queue empties, wait
 *     DRAIN_DELAY_MS, then fire tts:stop (so it lands ~when playback finishes)
 */
class FramePacer {
    private queue: Uint8Array[] = [];
    private timer: number | null = null;
    private stopTimer: number | null = null;
    private startTime = 0;
    private playheadMs = 0;
    private speaking = false;
    private started = false; // first frame of the current utterance sent?
    private generationComplete = false;
    private readonly prebufferMs: number;

    constructor(
        private readonly frameDurationMs: number,
        prebufferFrames: number,
        private readonly drainDelayMs: number,
        private readonly sendFrame: (frame: Uint8Array) => void,
        private readonly onUtteranceStart: () => void,
        private readonly onUtteranceEnd: () => void,
    ) {
        this.prebufferMs = prebufferFrames * frameDurationMs;
    }

    /** A new assistant response is starting. */
    startUtterance() {
        this.cancelStopTimer();
        this.queue = [];
        this.startTime = 0;
        this.playheadMs = 0;
        this.started = false;
        this.generationComplete = false;
        this.speaking = true;
    }

    enqueue(frame: Uint8Array) {
        if (!this.speaking) this.startUtterance(); // defensive: audio with no CREATED
        this.queue.push(frame);
        this.ensureRunning();
    }

    /** The provider finished generating; stop once the queue has drained. */
    markComplete() {
        if (!this.speaking) return;
        this.generationComplete = true;
        if (this.timer === null && this.queue.length === 0) this.armStop();
    }

    /**
     * Flush everything and stop speaking immediately (user interrupt).
     * Returns the estimated ms of audio the device actually played, for
     * conversation truncation.
     */
    abort(): number {
        const playedMs = Math.max(0, this.playheadMs - this.prebufferMs);
        this.queue = [];
        this.clearTimer();
        this.cancelStopTimer();
        if (this.speaking && this.started) this.onUtteranceEnd();
        this.speaking = false;
        this.started = false;
        return playedMs;
    }

    dispose() {
        this.queue = [];
        this.clearTimer();
        this.cancelStopTimer();
        this.speaking = false;
    }

    private ensureRunning() {
        if (this.timer === null) this.process();
    }

    private process() {
        this.timer = null;
        if (this.startTime === 0) this.startTime = Date.now();

        while (this.queue.length > 0) {
            const targetTime = this.startTime + this.playheadMs - this.prebufferMs;
            if (targetTime > Date.now()) break;
            const frame = this.queue.shift()!;
            if (!this.started) {
                this.started = true;
                this.onUtteranceStart();
            }
            this.sendFrame(frame);
            this.playheadMs += this.frameDurationMs;
        }

        if (this.queue.length > 0) {
            const targetTime = this.startTime + this.playheadMs - this.prebufferMs;
            const wait = Math.max(0, targetTime - Date.now());
            this.timer = setTimeout(() => this.process(), wait);
        } else if (this.generationComplete) {
            this.armStop();
        }
    }

    private armStop() {
        if (this.stopTimer !== null) return;
        this.stopTimer = setTimeout(() => {
            this.stopTimer = null;
            if (!this.speaking) return;
            this.speaking = false;
            this.started = false;
            this.onUtteranceEnd();
        }, this.drainDelayMs);
    }

    private clearTimer() {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private cancelStopTimer() {
        if (this.stopTimer !== null) {
            clearTimeout(this.stopTimer);
            this.stopTimer = null;
        }
    }
}

/**
 * Adapts a XIAOZHI-ESP32 WebSocket connection to the ELATO provider interface.
 *
 * Outward (to the device) it speaks the XIAOZHI protocol: the `hello`
 * handshake, raw Opus audio frames (paced), and `tts` control messages.
 *
 * Inward (to connectToOpenAI et al.) it presents the same ClientWebSocket
 * surface as ClientWebSocketAdapter, so the existing provider code runs
 * unchanged: binary = PCM16 @ 24kHz, text = `{ type: "instruction", ... }`,
 * and it accepts Opus packets + `{ type: "server" }` messages via send().
 */
export class XiaozhiWebSocketAdapter implements ClientWebSocket {
    private readonly decoder = createOpusDecoder({
        sampleRate: DEVICE_SAMPLE_RATE,
        channels: 1,
    });
    private messageHandlers: MessageHandler[] = [];
    private errorHandlers: ErrorHandler[] = [];
    private closeHandlers: CloseHandler[] = [];
    // Audio that arrives before the provider registers its message handler.
    private pendingInbound: Array<{ data: Buffer; isBinary: boolean }> = [];
    private readonly sessionId = crypto.randomUUID();
    private helloAnswered = false;
    private readonly pacer: FramePacer;
    private readonly uplinkSampleRate: number;

    constructor(
        private readonly socket: WebSocket,
        opts: { uplinkSampleRate?: number } = {},
    ) {
        this.uplinkSampleRate = opts.uplinkSampleRate ?? DEFAULT_UPLINK_SAMPLE_RATE;
        this.socket.binaryType = "arraybuffer";

        this.pacer = new FramePacer(
            SERVER_FRAME_DURATION_MS,
            PREBUFFER_FRAMES,
            DRAIN_DELAY_MS,
            (frame) => this.rawSend(frame),
            () => this.sendTts("start"),
            () => this.sendTts("stop"),
        );

        this.socket.onmessage = (event) => {
            try {
                if (typeof event.data === "string") {
                    this.handleDeviceJson(event.data);
                } else {
                    this.handleDeviceAudio(event.data as ArrayBuffer);
                }
            } catch (err) {
                console.error("XIAOZHI inbound handling failed:", err);
            }
        };

        this.socket.onerror = (event) => {
            const error = (event as ErrorEvent)?.error ?? event;
            for (const handler of this.errorHandlers) handler(error);
        };

        this.socket.onclose = (event) => {
            this.pacer.dispose();
            for (const handler of this.closeHandlers) {
                handler(event.code, event.reason);
            }
        };
    }

    // ---- Device -> provider ------------------------------------------------

    private handleDeviceAudio(buf: ArrayBuffer) {
        const opusFrame = new Uint8Array(buf);
        if (opusFrame.length === 0) return;

        let pcm16k: Uint8Array;
        try {
            pcm16k = this.decoder.decode(opusFrame);
        } catch (err) {
            console.error("XIAOZHI opus decode failed:", err);
            return;
        }

        // Resample to whatever the active provider expects (no-op if equal).
        const pcm = resamplePcm16Mono(
            pcm16k,
            DEVICE_SAMPLE_RATE,
            this.uplinkSampleRate,
        );
        this.dispatch(pcm, true);
    }

    private handleDeviceJson(raw: string) {
        let message: Record<string, unknown>;
        try {
            message = JSON.parse(raw);
        } catch {
            console.warn("XIAOZHI: ignoring non-JSON text frame");
            return;
        }

        switch (message.type) {
            case "hello":
                this.answerHello();
                break;
            case "abort": {
                // User interrupted: flush queued audio, stop the device, and
                // truncate the assistant turn at what was actually played.
                console.log("XIAOZHI abort:", message.reason ?? "");
                const playedMs = this.pacer.abort();
                this.dispatch(
                    Buffer.from(JSON.stringify({
                        type: "instruction",
                        msg: "INTERRUPT",
                        audio_end_ms: playedMs,
                    })),
                    false,
                );
                break;
            }
            case "listen":
                // OpenAI server_vad handles turn detection; log for now.
                console.log("XIAOZHI listen:", message.state, message.mode ?? "");
                break;
            default:
                console.log("XIAOZHI unhandled message:", message.type);
        }
    }

    private answerHello() {
        if (this.helloAnswered) return;
        this.helloAnswered = true;
        this.rawSend(JSON.stringify({
            type: "hello",
            transport: "websocket",
            session_id: this.sessionId,
            audio_params: {
                format: "opus",
                sample_rate: SERVER_DOWNLINK_SAMPLE_RATE,
                channels: 1,
                frame_duration: SERVER_FRAME_DURATION_MS,
            },
        }));
    }

    private dispatch(data: Buffer, isBinary: boolean) {
        if (this.messageHandlers.length === 0) {
            this.pendingInbound.push({ data, isBinary });
            return;
        }
        for (const handler of this.messageHandlers) handler(data, isBinary);
    }

    // ---- Provider -> device ------------------------------------------------

    send(data: string | Uint8Array | ArrayBuffer) {
        if (typeof data === "string") {
            this.translateServerJson(data);
            return;
        }
        // Binary: an Opus packet (24kHz/60ms). Hand it to the pacer.
        const frame = data instanceof Uint8Array ? data : new Uint8Array(data);
        this.pacer.enqueue(frame);
    }

    private translateServerJson(raw: string) {
        let message: Record<string, unknown>;
        try {
            message = JSON.parse(raw);
        } catch {
            return;
        }

        // Only ELATO `{ type: "server" }` control messages map to XIAOZHI.
        // The ELATO `auth` message has no equivalent and is dropped.
        // tts:start / tts:stop are driven by the pacer, not sent here.
        if (message.type !== "server") return;

        switch (message.msg) {
            case "RESPONSE.CREATED":
                this.pacer.startUtterance();
                break;
            case "RESPONSE.COMPLETE":
                this.pacer.markComplete();
                break;
            case "STT":
                // User transcript -> device subtitle line.
                this.rawSend(JSON.stringify({
                    type: "stt",
                    text: message.text ?? "",
                    session_id: this.sessionId,
                }));
                break;
            case "TTS_SENTENCE":
                // Assistant sentence -> shown before its audio plays.
                this.rawSend(JSON.stringify({
                    type: "tts",
                    state: "sentence_start",
                    text: message.text ?? "",
                    session_id: this.sessionId,
                }));
                break;
            case "EMOTION":
                this.rawSend(JSON.stringify({
                    type: "llm",
                    emotion: message.emotion ?? "neutral",
                    text: "",
                }));
                break;
            case "SESSION.END":
                this.close(1000, "session ended");
                break;
            // AUDIO.COMMITTED / RESPONSE.ERROR: no XIAOZHI equivalent.
        }
    }

    private sendTts(state: "start" | "stop") {
        this.rawSend(JSON.stringify({
            type: "tts",
            state,
            session_id: this.sessionId,
        }));
    }

    private rawSend(data: string | Uint8Array) {
        if (this.socket.readyState !== WebSocket.OPEN) return;
        try {
            this.socket.send(data);
        } catch (err) {
            console.error("XIAOZHI socket send failed:", err);
        }
    }

    // ---- ClientWebSocket interface ----------------------------------------

    close(code?: number, reason?: string) {
        this.pacer.dispose();
        try {
            this.socket.close(code, reason);
        } catch (err) {
            console.error("XIAOZHI socket close failed:", err);
        }
    }

    on(
        event: string,
        handler: (...args: any[]) => void | Promise<void>,
    ): ClientWebSocket {
        if (event === "message") {
            this.messageHandlers.push(handler as MessageHandler);
            // Replay audio that arrived before the provider was ready.
            if (this.pendingInbound.length > 0) {
                const queued = this.pendingInbound;
                this.pendingInbound = [];
                for (const item of queued) {
                    (handler as MessageHandler)(item.data, item.isBinary);
                }
            }
        } else if (event === "error") {
            this.errorHandlers.push(handler as ErrorHandler);
        } else if (event === "close") {
            this.closeHandlers.push(handler as CloseHandler);
        }
        return this;
    }
}
