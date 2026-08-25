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

// The chat models keep slipping franchise names into image descriptions
// despite instructions (observed mid-session), and xAI then rejects the
// generated image (imagine:content-moderated). So known kid-culture names are
// replaced server-side with generic look-alike descriptions before
// prompting. Common first names (Anna, Mario, ...) are included on purpose:
// in practice kids mean the franchise character, and the generic replacement
// is still a fine picture if they didn't.
const BRAND_REPLACEMENTS: Array<[RegExp, string]> = [
    [/\belsa('s)?\b/gi, "an ice princess with a long platinum-blonde braid and a sparkling ice-blue gown"],
    [/\banna('s)?\b/gi, "a cheerful princess with reddish-brown braids and a green dress"],
    [/\bolaf('s)?\b/gi, "a happy little snowman with stick arms, big eyes and a carrot nose"],
    [/\bkristoff\b/gi, "a friendly mountain man in warm clothes"],
    [/\barendelle\b/gi, "a cozy fairytale mountain village by a fjord"],
    [/\b(die )?eisk[oö]nigin\b/gi, "an ice queen"],
    [/\biron[ -]?man\b/gi, "a superhero in shiny red-and-gold metal armor"],
    [/\bbatman\b/gi, "a superhero in a dark bat-themed suit with a cape"],
    [/\bspider[ -]?man\b/gi, "a superhero in a red-and-blue suit with a web pattern"],
    [/\bsuperman\b/gi, "a superhero with a red cape and a blue suit"],
    [/\bhulk\b/gi, "a giant friendly green-skinned strongman"],
    [/\bpikachu\b/gi, "a cute chubby yellow creature with long ears and a lightning-bolt tail"],
    [/\bpok[eé]mon\b/gi, "cute collectible fantasy creatures"],
    [/\bmi(c)?key (mouse|maus)\b/gi, "a cheerful cartoon mouse with big round ears and red shorts"],
    [/\bminnie (mouse|maus)\b/gi, "a cheerful cartoon mouse girl with a polka-dot bow"],
    [/\bdonald duck\b/gi, "a cartoon duck in a blue sailor shirt"],
    [/\bpaw patrol\b/gi, "a team of heroic rescue puppies in colorful uniforms"],
    [/\bpeppa( pig| wutz)?\b/gi, "a cheerful little cartoon pig in a red dress"],
    [/\b(super )?mario('s)?\b/gi, "a cheerful mustachioed plumber with a red cap and blue overalls"],
    [/\bluigi\b/gi, "a tall mustachioed plumber with a green cap"],
    [/\bminions?\b/gi, "small yellow capsule-shaped helpers in blue overalls and goggles"],
    [/\bharry potter\b/gi, "a young wizard with round glasses and a lightning-shaped scar"],
    [/\bhogwarts\b/gi, "a grand old castle school for wizards"],
    [/\bdarth vader\b/gi, "a tall figure in black armor with a black helmet and flowing cape"],
    [/\bstar wars\b/gi, "a space adventure with glowing laser swords"],
    [/\bbarbie('s)?\b/gi, "a glamorous doll-like woman with long blonde hair dressed in pink"],
    [/\bbluey\b/gi, "a playful blue cartoon puppy"],
    [/\bwinnie[ -](the[ -])?(pooh|puuh)\b/gi, "a friendly honey-loving yellow teddy bear in a red shirt"],
];

/** Replace known franchise/character names with generic descriptions. */
export function scrubBrandNames(text: string): string {
    let out = text;
    for (const [re, replacement] of BRAND_REPLACEMENTS) {
        out = out.replace(re, replacement);
    }
    return out;
}

// Appended on the moderation retry to push the model further away from
// recognizable IP.
const MODERATION_RETRY_SUFFIX =
    " Depict only original generic characters of your own design — do not " +
    "depict any franchise, movie or video-game character.";

const isModerationError = (e: unknown): boolean =>
    (e as Error)?.message?.includes("content-moderated") ?? false;

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
    const scrubbed = scrubBrandNames(description.trim());
    if (scrubbed !== description.trim()) {
        console.log(`image prompt debranded: "${scrubbed.slice(0, 100)}"`);
    }
    const prompt = `${scrubbed}\n\n${STYLE}`;

    if (IMAGE_MODEL.startsWith("grok")) {
        // 3:2 matches the device screen (480x320); at "low"/1k that comes
        // back as a 1248x832 JPG.
        try {
            const bytes = await xaiImageRequest("generations", { prompt });
            return await toDeviceJpeg(bytes, 1248, 832);
        } catch (e) {
            // Output moderation is probabilistic; one retry pushed further
            // away from recognizable IP usually passes.
            if (!isModerationError(e)) throw e;
            console.warn("image moderated, retrying with generic-only prompt");
            const bytes = await xaiImageRequest("generations", {
                prompt: prompt + MODERATION_RETRY_SUFFIX,
            });
            return await toDeviceJpeg(bytes, 1248, 832);
        }
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
    const prompt = `Redraw this photo: ${scrubBrandNames(instruction.trim())}. Keep the main ` +
        `subject and composition clearly recognizable. No text, letters or ` +
        `captions anywhere in the image.`;

    if (STYLIZE_MODEL.startsWith("grok")) {
        const dataUrl = `data:image/jpeg;base64,${Buffer.from(photoJpeg).toString("base64")}`;
        const image = { url: dataUrl };
        try {
            const bytes = await xaiImageRequest("edits", { model: STYLIZE_MODEL, prompt, image });
            return await toDeviceJpeg(bytes, 1248, 832);
        } catch (e) {
            if (!isModerationError(e)) throw e;
            console.warn("stylize moderated, retrying with generic-only prompt");
            const bytes = await xaiImageRequest("edits", {
                model: STYLIZE_MODEL,
                prompt: prompt + MODERATION_RETRY_SUFFIX,
                image,
            });
            return await toDeviceJpeg(bytes, 1248, 832);
        }
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
