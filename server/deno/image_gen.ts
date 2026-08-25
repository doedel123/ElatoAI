/// <reference path="./types.d.ts" />

import { Buffer } from "node:buffer";
import { Image } from "imagescript";
import { type DaypartInfo, getDaypart } from "./daypart.ts";
import { geminiApiKey, openaiApiKey, xaiApiKey } from "./utils.ts";

// Scene images default to xAI's grok-imagine-image: OpenAI's gpt-image
// models reject many kid requests (copyrighted characters like Elsa) with
// 400 moderation errors, and the v1 imagine model is about twice as fast
// (and cheaper) than grok-imagine-image-2.0 at sufficient quality for the
// tiny screen. "grok*" models route to api.x.ai (JPG at the requested aspect
// ratio), anything else to the OpenAI images API (IMAGE_SIZE/COMPRESSION
// apply there). Either way the result is downscaled to the device screen,
// which keeps the WS payload tiny and lets the firmware just decode + blit.
const IMAGE_MODEL = Deno.env.get("IMAGE_MODEL") ?? "grok-imagine-image";
const IMAGE_SIZE = Deno.env.get("IMAGE_SIZE") ?? "1536x1024";
const IMAGE_QUALITY = Deno.env.get("IMAGE_QUALITY") ?? "low";
const IMAGE_COMPRESSION = Number(Deno.env.get("IMAGE_COMPRESSION") ?? "60");
// Downscale target = device screen. Set IMAGE_TARGET_SIZE="none" to send full-res.
const IMAGE_TARGET_SIZE = Deno.env.get("IMAGE_TARGET_SIZE") ?? "480x320";
const IMAGE_JPEG_QUALITY = Number(Deno.env.get("IMAGE_JPEG_QUALITY") ?? "80");

const STYLE =
    "Warm, colorful, child-friendly storybook illustration. Simple, clear " +
    "composition that reads well on a tiny screen. No text, letters, words or " +
    "captions anywhere in the image. If the description references a " +
    "well-known or trademarked character, depict an original generic " +
    "character with a similar look and colors instead, without the brand.";

export interface GeneratedImage {
    jpegBase64: string;
    width: number;
    height: number;
}

/**
 * Generate a scene illustration from a text description as a small JPEG
 * (base64), downscaled to the device screen. Independent of the audio session —
 * runs in the background and is pushed to the device when ready.
 */
export async function generateSceneImage(description: string): Promise<GeneratedImage> {
    const prompt = `${description.trim()}\n\n${STYLE}`;

    if (IMAGE_MODEL.startsWith("grok")) {
        // 3:2 matches the device screen (480x320); at "low"/1k that comes
        // back as a 1248x832 JPG.
        const bytes = await xaiImageRequest("generations", { prompt });
        return await toDeviceJpeg(bytes, 1248, 832);
    }

    if (!openaiApiKey) throw new Error("OPENAI_API_KEY not configured for image generation");
    const [genW, genH] = IMAGE_SIZE.split("x").map(Number);
    const fallbackW = genW || 1536;
    const fallbackH = genH || 1024;
    const resp = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${openaiApiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: IMAGE_MODEL,
            prompt,
            size: IMAGE_SIZE,
            quality: IMAGE_QUALITY,
            output_format: "jpeg",
            output_compression: IMAGE_COMPRESSION,
            n: 1,
        }),
    });

    if (!resp.ok) {
        throw new Error(`image gen (${IMAGE_MODEL}) error ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }
    const data = await resp.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (typeof b64 !== "string" || !b64) throw new Error("image gen returned no image");

    const jpegBytes: Uint8Array = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return await toDeviceJpeg(jpegBytes, fallbackW, fallbackH);
}

/**
 * Call xAI's images API ("generations" for text-to-image, "edits" for
 * reference-based) and return the raw JPEG bytes. size/output_format params
 * are unsupported there; quality is "low" | "medium".
 */
async function xaiImageRequest(
    endpoint: "generations" | "edits",
    body: Record<string, unknown>,
): Promise<Uint8Array> {
    if (!xaiApiKey) {
        throw new Error("XAI_API_KEY / GROK_API_KEY not configured for image generation");
    }
    const resp = await fetch(`https://api.x.ai/v1/images/${endpoint}`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${xaiApiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: IMAGE_MODEL,
            quality: IMAGE_QUALITY,
            aspect_ratio: "3:2",
            n: 1,
            response_format: "b64_json",
            ...body,
        }),
    });
    if (!resp.ok) {
        throw new Error(
            `image ${endpoint} (${IMAGE_MODEL}) error ${resp.status}: ${(await resp.text()).slice(0, 200)}`,
        );
    }
    const data = await resp.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (typeof b64 !== "string" || !b64) throw new Error(`image ${endpoint} returned no image`);
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * Transcode any PNG/JPEG bytes to a small device-ready JPEG (downscaled to
 * IMAGE_TARGET_SIZE unless set to "none"), base64-encoded.
 */
async function toDeviceJpeg(
    bytes: Uint8Array,
    fallbackW: number,
    fallbackH: number,
): Promise<GeneratedImage> {
    try {
        const img = await Image.decode(bytes);
        let outW = img.width;
        let outH = img.height;
        if (IMAGE_TARGET_SIZE.includes("x")) {
            const [tw, th] = IMAGE_TARGET_SIZE.split("x").map(Number);
            // Cover-fit: scale to fill the screen, then center-crop the
            // overflow, so sources with a different aspect ratio (Grok 4:3,
            // Gemini varies) aren't stretched.
            const scale = Math.max(tw / img.width, th / img.height);
            img.resize(
                Math.max(tw, Math.ceil(img.width * scale)),
                Math.max(th, Math.ceil(img.height * scale)),
            );
            img.crop(
                Math.floor((img.width - tw) / 2),
                Math.floor((img.height - th) / 2),
                tw,
                th,
            );
            outW = tw;
            outH = th;
        }
        const jpeg = await img.encodeJPEG(IMAGE_JPEG_QUALITY);
        return { jpegBase64: Buffer.from(jpeg).toString("base64"), width: outW, height: outH };
    } catch (e) {
        // Source may already be a device-compatible JPEG — send it unchanged.
        console.warn("image transcode failed, sending original:", (e as Error).message);
        return { jpegBase64: Buffer.from(bytes).toString("base64"), width: fallbackW, height: fallbackH };
    }
}

// Reference-based restyling ("photo -> cartoon"). "grok*" models route to
// xAI's images/edits (photo as reference image), "gemini*" models to Gemini
// image generation.
const STYLIZE_MODEL = Deno.env.get("STYLIZE_MODEL") ?? "grok-imagine-image";

/**
 * Turn a camera photo into a new AI-generated picture in the given style,
 * using the photo as the reference image. Returns a device-ready JPEG.
 */
export async function stylizeImage(
    photoJpeg: Uint8Array,
    instruction: string,
): Promise<GeneratedImage> {
    const prompt = `Redraw this photo: ${instruction.trim()}. Keep the main subject and ` +
        `composition clearly recognizable. No text, letters or captions ` +
        `anywhere in the image.`;

    if (STYLIZE_MODEL.startsWith("grok")) {
        const dataUrl = `data:image/jpeg;base64,${Buffer.from(photoJpeg).toString("base64")}`;
        const bytes = await xaiImageRequest("edits", {
            model: STYLIZE_MODEL,
            prompt,
            image: { url: dataUrl },
        });
        return await toDeviceJpeg(bytes, 1248, 832);
    }

    if (!geminiApiKey) throw new Error("GEMINI_API_KEY not configured for photo stylization");

    const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${STYLIZE_MODEL}:generateContent?key=${geminiApiKey}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        {
                            inlineData: {
                                mimeType: "image/jpeg",
                                data: Buffer.from(photoJpeg).toString("base64"),
                            },
                        },
                        {
                            // Gemini has no aspect_ratio param, so ask for
                            // landscape in the prompt instead.
                            text: `${prompt} Landscape orientation.`,
                        },
                    ],
                }],
                generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
            }),
        },
    );

    if (!resp.ok) {
        throw new Error(`stylize error ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }
    const data = await resp.json();
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    let b64: string | null = null;
    for (const p of parts) {
        const inline = p?.inlineData ?? p?.inline_data;
        if (inline?.data) {
            b64 = inline.data;
            break;
        }
    }
    if (!b64) throw new Error("stylize model returned no image");

    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return await toDeviceJpeg(bytes, 480, 320);
}

// ---------------------------------------------------------------------------
// Time-of-day greeting images: on session start (and after a personality
// switch) the active character appears on the screen in a scene matching the
// local time of day. When a stored portrait exists, xAI's /images/edits takes
// it as reference so the picture actually looks like that character. Results
// are cached in memory per character+daypart, so each combination is paid for
// at most once per server instance.

const greetingImageCache = new Map<string, Promise<GeneratedImage>>();

const CONCIERGE_VISUAL = "James, a friendly elegant concierge with a warm smile, " +
    "wearing a smart dark suit";

async function loadPortrait(key: string | undefined): Promise<Uint8Array | null> {
    if (!key || !/^[a-zA-Z0-9_-]+$/.test(key)) return null;
    try {
        return await Deno.readFile(new URL(`./personality/${key}.jpeg`, import.meta.url));
    } catch {
        return null;
    }
}

/**
 * Greeting image for a character (null = concierge James), themed for the
 * given time of day. Cached; concurrent callers share one generation.
 */
export function generateGreetingImage(
    personality: IPersonality | null,
    daypart: DaypartInfo,
): Promise<GeneratedImage> {
    const cacheKey = `${personality?.key ?? "concierge"}:${daypart.key}`;
    const cached = greetingImageCache.get(cacheKey);
    if (cached) return cached;

    const pending = (async () => {
        const scene = `greeting the viewer warmly, ${daypart.scene}`;
        const portrait = personality ? await loadPortrait(personality.key) : null;

        if (portrait && IMAGE_MODEL.startsWith("grok")) {
            // Reference-based: the character from the stored portrait, redrawn
            // in a time-of-day scene.
            const dataUrl = `data:image/jpeg;base64,${Buffer.from(portrait).toString("base64")}`;
            const prompt =
                `Exactly this character — same face, hair and outfit — ${scene}. ${STYLE}`;
            const bytes = await xaiImageRequest("edits", { prompt, image: { url: dataUrl } });
            return await toDeviceJpeg(bytes, 1248, 832);
        }

        const who = personality
            ? `${personality.title ?? personality.key}` +
                (personality.short_description ? ` (${personality.short_description})` : "")
            : CONCIERGE_VISUAL;
        return await generateSceneImage(`${who}, ${scene}`);
    })();

    // Cache the promise so parallel session starts share one generation; drop
    // it on failure so the next session retries.
    greetingImageCache.set(cacheKey, pending);
    pending.catch(() => greetingImageCache.delete(cacheKey));
    return pending;
}

/**
 * Fire-and-forget helper: generate the greeting image for the current time of
 * day and hand it to `push` when ready. Never blocks or throws.
 */
export function pushGreetingImage(
    personality: IPersonality | null,
    push: (img: GeneratedImage, durationMs?: number) => void,
): void {
    const daypart = getDaypart();
    generateGreetingImage(personality, daypart)
        .then((img) => {
            push(img);
            console.log(
                `greeting image pushed (${personality?.key ?? "concierge"}, ${daypart.key})`,
            );
        })
        .catch((e) => console.warn("greeting image failed:", (e as Error)?.message ?? e));
}
