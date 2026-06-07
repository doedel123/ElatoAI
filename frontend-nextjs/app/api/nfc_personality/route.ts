import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { join } from "path";
import { createClient } from "@/utils/supabase/server";
import { hasPersonalityImage } from "@/lib/utils";

export const runtime = "nodejs";

/**
 * NFC -> Personality lookup for the ESP32 (Toniebox-style).
 *
 * The device reads an NFC tag's UID and calls this endpoint. We map the tag to a
 * personality (via the `nfc_tags` table) and return the personality data plus an
 * absolute image URL, analogous to how a device identifies itself via MAC in
 * `generate_auth_token`.
 *
 * This is read-only: it does NOT change the device's active personality.
 *
 * Example:
 *   GET /api/nfc_personality?nfcId=04:4E:E5:7A:60:1B:90
 */

// Normalize any UID format (colons/dashes/lowercase) to uppercase hex w/o separators.
const normalizeNfcId = (raw: string): string =>
    raw.replace(/[^0-9a-fA-F]/g, "").toUpperCase();

const personalityImageBase64Cache = new Map<string, string>();

const getPersonalityImageFileKey = (key: string): string => {
    const normalizedKey = key.toLowerCase().replace(/\s+/g, "_");
    return hasPersonalityImage(normalizedKey) ? normalizedKey : "elato_default";
};

const getPersonalityImageUrl = (origin: string, fileKey: string): string => {
    return `${origin}/personality/${fileKey}.jpeg`;
};

const getPersonalityImageJpegBase64 = async (fileKey: string): Promise<string> => {
    const cachedImage = personalityImageBase64Cache.get(fileKey);
    if (cachedImage) {
        return cachedImage;
    }

    const imagePath = join(
        process.cwd(),
        "public",
        "personality",
        `${fileKey}.jpeg`,
    );
    const imageBase64 = await readFile(imagePath, "base64");
    personalityImageBase64Cache.set(fileKey, imageBase64);

    return imageBase64;
};

export async function GET(req: Request) {
    try {
        const { searchParams, origin } = new URL(req.url);
        const nfcIdParam = searchParams.get("nfcId");

        if (!nfcIdParam) {
            return NextResponse.json(
                { error: "nfcId is required" },
                { status: 400 },
            );
        }

        const nfcId = normalizeNfcId(nfcIdParam);
        if (!nfcId) {
            return NextResponse.json(
                { error: "nfcId is invalid" },
                { status: 400 },
            );
        }

        const supabase = await createClient();
        const { data, error } = await supabase
            .from("nfc_tags")
            .select("nfc_id, label, personality:personalities(*)")
            .eq("nfc_id", nfcId)
            .single();

        if (error || !data?.personality) {
            return NextResponse.json(
                { error: "No personality found for this NFC tag" },
                { status: 404 },
            );
        }

        const personality = Array.isArray(data.personality)
            ? data.personality[0]
            : data.personality;
        const personalityImageFileKey = getPersonalityImageFileKey(
            personality.key ?? "",
        );

        return NextResponse.json({
            nfc_id: data.nfc_id,
            label: data.label,
            personality,
            image_url: getPersonalityImageUrl(origin, personalityImageFileKey),
            personality_image_jpeg_base64: await getPersonalityImageJpegBase64(
                personalityImageFileKey,
            ),
        });
    } catch (error) {
        return NextResponse.json(
            {
                error: error instanceof Error
                    ? error.message
                    : "Internal server error",
            },
            { status: 500 },
        );
    }
}
