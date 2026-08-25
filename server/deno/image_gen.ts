import { Buffer } from "node:buffer";
import { Image } from "imagescript";
import { geminiApiKey, openaiApiKey, xaiApiKey } from "./utils.ts";

// Scene images default to xAI's grok-imagine-image-2.0 ("Grok Image 2"):
// OpenAI's gpt-image models reject many kid requests (copyrighted characters
// like Elsa) with 400 moderation errors. "grok*" models route to api.x.ai
// (JPG at the requested aspect ratio; quality low/medium via IMAGE_QUALITY),
// anything else to the OpenAI images API (IMAGE_SIZE/COMPRESSION apply
// there). Either way the result is downscaled to the device screen, which
// keeps the WS payload tiny (~10KB) and lets the firmware just decode + blit.
const IMAGE_MODEL = Deno.env.get("IMAGE_MODEL") ?? "grok-imagine-image-2.0";
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
    const prompt = `${description.trim()}\n\n${STYLE}`;
    const useXai = IMAGE_MODEL.startsWith("grok");

    let resp: Response;
    let fallbackW: number;
    let fallbackH: number;
    if (useXai) {
        if (!xaiApiKey) {
            throw new Error("XAI_API_KEY / GROK_API_KEY not configured for image generation");
        }
        // 3:2 matches the device screen (480x320); at "low"/1k that comes
        // back as a 1248x832 JPG. size/output_format params are unsupported.
        fallbackW = 1248;
        fallbackH = 832;
        resp = await fetch("https://api.x.ai/v1/images/generations", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${xaiApiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: IMAGE_MODEL,
                prompt,
                quality: IMAGE_QUALITY,
                aspect_ratio: "3:2",
                n: 1,
                response_format: "b64_json",
            }),
        });
    } else {
        if (!openaiApiKey) throw new Error("OPENAI_API_KEY not configured for image generation");
        const [genW, genH] = IMAGE_SIZE.split("x").map(Number);
        fallbackW = genW || 1536;
        fallbackH = genH || 1024;
        resp = await fetch("https://api.openai.com/v1/images/generations", {
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
    }

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

// Reference-based restyling ("photo -> cartoon") via Gemini image generation.
const STYLIZE_MODEL = Deno.env.get("STYLIZE_MODEL") ?? "gemini-2.5-flash-image";

/**
 * Turn a camera photo into a new AI-generated picture in the given style,
 * using the photo as the reference image. Returns a device-ready JPEG.
 */
export async function stylizeImage(
    photoJpeg: Uint8Array,
    instruction: string,
): Promise<GeneratedImage> {
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
                            text:
                                `Redraw this photo: ${instruction.trim()}. Keep the main subject and ` +
                                `composition clearly recognizable. Landscape orientation. No text, ` +
                                `letters or captions anywhere in the image.`,
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
