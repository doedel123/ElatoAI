/// <reference path="./types.d.ts" />

import { createClient } from "jsr:@supabase/supabase-js@2";
import { isDev } from "./utils.ts";

/**
 * Debug recorder for the uplink (mic) audio as the provider receives it —
 * i.e. after the XIAOZHI adapter's Opus decode + resample, or the raw PCM an
 * ELATO board sends. Produces a playable 16-bit mono WAV per connection.
 *
 * DEBUG_AUDIO=1          auto: Supabase Storage on Deno Deploy, local file otherwise
 * DEBUG_AUDIO=file       write debug_audio_<ts>_<label>_<rate>Hz.wav next to main.ts
 * DEBUG_AUDIO=supabase   buffer in memory, upload to the DEBUG_AUDIO_BUCKET
 *                        (default "debug-audio") on close. Needs
 *                        SUPABASE_SERVICE_ROLE_KEY (creates the private bucket
 *                        on first use). Download via Supabase Dashboard > Storage.
 * DEV_MODE=True still enables it (backwards compat).
 */
export interface DebugRecorder {
    readonly path: string;
    write(data: Uint8Array): Promise<void>;
    close(): void;
}

type Mode = "file" | "supabase";

const HEADER_BYTES = 44;
// File mode: patch the WAV size fields every N writes so a file from a
// crashed/killed server is still playable.
const HEADER_PATCH_EVERY = 50;
// Supabase mode: cap the in-memory buffer (30MB ≈ 15 min at 16kHz).
const MAX_BUFFER_BYTES = 30 * 1024 * 1024;
const BUCKET = Deno.env.get("DEBUG_AUDIO_BUCKET") ?? "debug-audio";

function resolveMode(): Mode | null {
    const v = (Deno.env.get("DEBUG_AUDIO") ?? "").toLowerCase();
    if (v === "file" || v === "local") return "file";
    if (v === "supabase" || v === "storage") return "supabase";
    if (v === "1" || v === "true" || isDev) {
        return Deno.env.get("DENO_DEPLOYMENT_ID") ? "supabase" : "file";
    }
    return null;
}

export function debugAudioEnabled(): boolean {
    return resolveMode() !== null;
}

export async function openDebugRecorder(
    sampleRate: number,
    label: string,
): Promise<DebugRecorder | null> {
    const mode = resolveMode();
    if (!mode) return null;
    const safeLabel = label.replace(/[^a-z0-9_-]/gi, "_");
    const name = `${Date.now()}_${safeLabel}_${sampleRate}Hz.wav`;
    return mode === "file"
        ? await openFileRecorder(sampleRate, name)
        : openSupabaseRecorder(sampleRate, safeLabel, name);
}

// ---- file backend -----------------------------------------------------------

async function openFileRecorder(
    sampleRate: number,
    name: string,
): Promise<DebugRecorder | null> {
    // Always next to main.ts, independent of the cwd the server was started from.
    const path = new URL(`./debug_audio_${name}`, import.meta.url).pathname;
    let file: Deno.FsFile;
    try {
        file = await Deno.open(path, { create: true, write: true, truncate: true });
    } catch (e) {
        console.warn(
            `DEBUG_AUDIO: cannot open ${path} (${(e as Error).message}). ` +
                "On Deno Deploy use DEBUG_AUDIO=supabase.",
        );
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
                console.log(`DEBUG_AUDIO: closed ${path} (${seconds(dataBytes, sampleRate)}s)`);
            });
        },
    };
}

// ---- supabase storage backend ------------------------------------------------

function openSupabaseRecorder(
    sampleRate: number,
    folder: string,
    name: string,
): DebugRecorder | null {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) {
        console.warn(
            "DEBUG_AUDIO: supabase mode needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY — recording disabled",
        );
        return null;
    }
    const client = createClient(url, key, { auth: { persistSession: false } });
    const path = `${folder}/${name}`;
    const chunks: Uint8Array[] = [];
    let dataBytes = 0;
    let truncated = false;
    let closed = false;
    console.log(`DEBUG_AUDIO: buffering uplink for upload to ${BUCKET}/${path} (${sampleRate}Hz)`);

    const upload = async () => {
        const wav = new Uint8Array(HEADER_BYTES + dataBytes);
        wav.set(wavHeader(sampleRate, dataBytes), 0);
        let off = HEADER_BYTES;
        for (const c of chunks) {
            wav.set(c, off);
            off += c.length;
        }
        chunks.length = 0;
        const doUpload = () =>
            client.storage.from(BUCKET).upload(path, wav, {
                contentType: "audio/wav",
                upsert: false,
            });
        let { error } = await doUpload();
        if (error && /bucket not found/i.test(error.message)) {
            const created = await client.storage.createBucket(BUCKET, { public: false });
            if (created.error) throw new Error(`createBucket: ${created.error.message}`);
            ({ error } = await doUpload());
        }
        if (error) throw new Error(error.message);
        console.log(
            `DEBUG_AUDIO: uploaded ${BUCKET}/${path} (${seconds(dataBytes, sampleRate)}s` +
                `${truncated ? ", truncated" : ""}) — Supabase Dashboard > Storage > ${BUCKET}`,
        );
    };

    return {
        path: `${BUCKET}/${path}`,
        write(data: Uint8Array) {
            if (closed || data.length === 0) return Promise.resolve();
            if (dataBytes + data.length > MAX_BUFFER_BYTES) {
                truncated = true;
                return Promise.resolve();
            }
            chunks.push(data.slice()); // copy: callers may reuse their buffer
            dataBytes += data.length;
            return Promise.resolve();
        },
        close() {
            if (closed) return;
            closed = true;
            if (dataBytes === 0) return;
            upload().catch((e) =>
                console.warn("DEBUG_AUDIO: upload failed:", (e as Error).message)
            );
        },
    };
}

// ---- helpers ----------------------------------------------------------------

const seconds = (bytes: number, rate: number) => (bytes / 2 / rate).toFixed(1);

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
