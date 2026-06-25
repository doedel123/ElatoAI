/// <reference path="./types.d.ts" />

import { Buffer } from "node:buffer";
import { createOpusDecoder, resamplePcm16Mono } from "./utils.ts";

// XIAOZHI device uplink: opus, 16kHz mono. Our providers expect 24kHz PCM.
const DEVICE_SAMPLE_RATE = 16000;
const PROVIDER_SAMPLE_RATE = 24000;
// What we advertise/send on the downlink. The device resamples after decode.
const SERVER_DOWNLINK_SAMPLE_RATE = 24000;
const SERVER_FRAME_DURATION_MS = 60;

type MessageHandler = (data: Buffer, isBinary: boolean) => void;
type ErrorHandler = (error: unknown) => void;
type CloseHandler = (code: number, reason: string) => void;

/**
 * Adapts a XIAOZHI-ESP32 WebSocket connection to the ELATO provider interface.
 *
 * Outward (to the device) it speaks the XIAOZHI protocol: the `hello`
 * handshake, raw Opus audio frames, and `tts`/`stt`/`llm` JSON control
 * messages.
 *
 * Inward (to connectToOpenAI et al.) it presents the same ClientWebSocket
 * surface as ClientWebSocketAdapter, so the existing provider code runs
 * unchanged: binary = PCM16 @ 24kHz, text = `{ type: "instruction", ... }`,
 * and it accepts Opus packets + `{ type: "server" }` messages via send().
 *
 * Phase 1 scope: hello handshake + Opus bridge + tts start/stop. Turn
 * detection relies on OpenAI server_vad; `listen`/`abort` are logged only.
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

    constructor(private readonly socket: WebSocket) {
        this.socket.binaryType = "arraybuffer";

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

        const pcm24k = resamplePcm16Mono(
            pcm16k,
            DEVICE_SAMPLE_RATE,
            PROVIDER_SAMPLE_RATE,
        );
        this.dispatch(pcm24k, true);
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
            case "abort":
                // Phase 1: barge-in handled by server VAD; log only.
                console.log("XIAOZHI abort:", message.reason ?? "");
                break;
            case "listen":
                // Phase 1: OpenAI server_vad handles turn detection; no-op.
                console.log("XIAOZHI listen:", message.state, message.mode ?? "");
                break;
            default:
                console.log("XIAOZHI unhandled message:", message.type);
        }
    }

    private answerHello() {
        if (this.helloAnswered) return;
        this.helloAnswered = true;
        this.socket.send(JSON.stringify({
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
        // Binary: Opus packet already encoded at 24kHz/60ms — forward as-is.
        this.socket.send(data);
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
        if (message.type !== "server") return;

        switch (message.msg) {
            case "RESPONSE.CREATED":
                this.socket.send(JSON.stringify({
                    type: "tts",
                    state: "start",
                    session_id: this.sessionId,
                }));
                break;
            case "RESPONSE.COMPLETE":
                this.socket.send(JSON.stringify({
                    type: "tts",
                    state: "stop",
                    session_id: this.sessionId,
                }));
                break;
            case "SESSION.END":
                this.close(1000, "session ended");
                break;
            // AUDIO.COMMITTED / RESPONSE.ERROR: no XIAOZHI equivalent in Phase 1.
        }
    }

    // ---- ClientWebSocket interface ----------------------------------------

    close(code?: number, reason?: string) {
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
