/// <reference path="./types.d.ts" />

import { isDev } from "./utils.ts";

/**
 * Debug recorder for the uplink (mic) audio as the provider receives it —
 * i.e. after the XIAOZHI adapter's Opus decode + resample, or the raw PCM an
 * ELATO board sends. Writes a playable 16-bit mono WAV next to main.ts.
 *
 * Enable with DEBUG_AUDIO=1 (or DEV_MODE=True, kept for backwards compat).
 * Files: debug_audio_<timestamp>_<label>_<rate>Hz.wav — covered by .gitignore.
 */
export interface DebugRecorder {
    readonly path: string;
    write(data: Uint8Array): Promise<void>;
    close(): void;
}

const HEADER_BYTES = 44;
// Patch the WAV size fields every N writes so a file from a crashed/killed
// server is still playable (players tolerate a short header vs. actual size).
const HEADER_PATCH_EVERY = 50;

export function debugAudioEnabled(): boolean {
    const v = (Deno.env.get("DEBUG_AUDIO") ?? "").toLowerCase();
    return v === "1" || v === "true" || isDev;
}

export async function openDebugRecorder(
    sampleRate: number,
    label: string,
): Promise<DebugRecorder | null> {
    if (!debugAudioEnabled()) return null;
    const safeLabel = label.replace(/[^a-z0-9_-]/gi, "_");
    const path = `debug_audio_${Date.now()}_${safeLabel}_${sampleRate}Hz.wav`;
    let file: Deno.FsFile;
    try {
        file = await Deno.open(path, { create: true, write: true, truncate: true });
    } catch (e) {
        console.warn("DEBUG_AUDIO: cannot open recording file:", (e as Error).message);
        return null;
    }
    await writeAll(file, wavHeader(sampleRate, 0));
    console.log(`DEBUG_AUDIO: recording uplink to ${path} (${sampleRate}Hz, pcm16 mono)`);

    let dataBytes = 0;
    let writes = 0;
    let closed = false;
    // Serialize all file ops: providers call write() without awaiting, and
    // the header patch seeks around in the file.
    let chain: Promise<void> = Promise.resolve();
    const enqueue = (op: () => Promise<void>) => {
        chain = chain.then(op).catch((e) =>
            console.warn("DEBUG_AUDIO: write failed:", (e as Error).message)
        );
        return chain;
    };
    const patchHeader = async () => {
        await file.seek(0, Deno.SeekMode.Start);
        await writeAll(file, wavHeader(sampleRate, dataBytes));
        await file.seek(0, Deno.SeekMode.End);
    };

    return {
        path,
        write(data: Uint8Array) {
            if (closed || data.length === 0) return Promise.resolve();
            return enqueue(async () => {
                await writeAll(file, data);
                dataBytes += data.length;
                if (++writes % HEADER_PATCH_EVERY === 0) await patchHeader();
            });
        },
        close() {
            if (closed) return;
            closed = true;
            void enqueue(async () => {
                await patchHeader();
                file.close();
                const secs = (dataBytes / 2 / sampleRate).toFixed(1);
                console.log(`DEBUG_AUDIO: closed ${path} (${secs}s)`);
            });
        },
    };
}

async function writeAll(file: Deno.FsFile, data: Uint8Array) {
    let off = 0;
    while (off < data.length) off += await file.write(data.subarray(off));
}

function wavHeader(sampleRate: number, dataBytes: number): Uint8Array {
    const channels = 1;
    const bitsPerSample = 16;
    const blockAlign = channels * bitsPerSample / 8;
    const buf = new ArrayBuffer(HEADER_BYTES);
    const v = new DataView(buf);
    const ascii = (off: number, s: string) => {
        for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    };
    ascii(0, "RIFF");
    v.setUint32(4, 36 + dataBytes, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    v.setUint32(16, 16, true); // fmt chunk size
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, channels, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * blockAlign, true);
    v.setUint16(32, blockAlign, true);
    v.setUint16(34, bitsPerSample, true);
    ascii(36, "data");
    v.setUint32(40, dataBytes, true);
    return new Uint8Array(buf);
}
