import { Buffer } from "node:buffer";
import { Image } from "imagescript";
import { openaiApiKey } from "./utils.ts";

// gpt-image-1 only generates >=1024px (1024x1024, 1536x1024, 1024x1536).
// We generate at 1536x1024 (3:2) then downscale to the device screen, which
// keeps the WS payload tiny (~10KB) and lets the firmware just decode + blit.
const IMAGE_MODEL = Deno.env.get("IMAGE_MODEL") ?? "gpt-image-1";
const IMAGE_SIZE = Deno.env.get("IMAGE_SIZE") ?? "1536x1024";
const IMAGE_QUALITY = Deno.env.get("IMAGE_QUALITY") ?? "low";
const IMAGE_COMPRESSION = Number(Deno.env.get("IMAGE_COMPRESSION") ?? "60");
// Downscale target = device screen. Set IMAGE_TARGET_SIZE="none" to send full-res.
const IMAGE_TARGET_SIZE = Deno.env.get("IMAGE_TARGET_SIZE") ?? "480x320";
const IMAGE_JPEG_QUALITY = Number(Deno.env.get("IMAGE_JPEG_QUALITY") ?? "80");

const STYLE =
    "Warm, colorful, child-friendly storybook illustration. Simple, clear " +
    "composition that reads well on a tiny screen. No text, letters, words or " +
    "captions anywhere in the image.";

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
    if (!openaiApiKey) throw new Error("OPENAI_API_KEY not configured for image generation");

    const [genW, genH] = IMAGE_SIZE.split("x").map(Number);
    const resp = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${openaiApiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: IMAGE_MODEL,
            prompt: `${description.trim()}\n\n${STYLE}`,
            size: IMAGE_SIZE,
            quality: IMAGE_QUALITY,
            output_format: "jpeg",
            output_compression: IMAGE_COMPRESSION,
            n: 1,
        }),
    });

    if (!resp.ok) {
        throw new Error(`image gen error ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }
    const data = await resp.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (typeof b64 !== "string" || !b64) throw new Error("image gen returned no image");

    let jpegBytes: Uint8Array = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    let outW = genW || 1536;
    let outH = genH || 1024;

    // Downscale to the device screen so the payload stays tiny.
    if (IMAGE_TARGET_SIZE.includes("x")) {
        const [tw, th] = IMAGE_TARGET_SIZE.split("x").map(Number);
        try {
            const img = await Image.decode(jpegBytes);
            img.resize(tw, th);
            jpegBytes = await img.encodeJPEG(IMAGE_JPEG_QUALITY);
            outW = tw;
            outH = th;
        } catch (e) {
            console.warn("image downscale failed, sending original:", (e as Error).message);
        }
    }

    return { jpegBase64: Buffer.from(jpegBytes).toString("base64"), width: outW, height: outH };
}
