import { Buffer } from "node:buffer";
import { openaiApiKey } from "./utils.ts";

const VISION_MODEL = Deno.env.get("VISION_MODEL") ?? "gpt-4o-mini";

const SYSTEM_PROMPT =
    "You are the eyes of a small talking toy with a camera. Describe what you " +
    "see to answer the user's question. Be brief and conversational (1-3 " +
    "sentences), since your answer will be spoken aloud. Focus on what's " +
    "actually visible; if the image is too dark or unclear, say so.";

/**
 * Describes a JPEG image to answer a question, using a vision LLM. This runs
 * completely independently of the realtime audio session, so it works for any
 * audio provider (incl. OpenAI Realtime, which has no vision of its own).
 */
export async function describeImage(
    jpegBytes: Uint8Array,
    question: string,
): Promise<string> {
    if (!openaiApiKey) throw new Error("OPENAI_API_KEY not configured for vision");

    const dataUri = `data:image/jpeg;base64,${Buffer.from(jpegBytes).toString("base64")}`;
    const userText = question?.trim() || "What do you see?";

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${openaiApiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: VISION_MODEL,
            max_tokens: 300,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                {
                    role: "user",
                    content: [
                        { type: "text", text: userText },
                        { type: "image_url", image_url: { url: dataUri, detail: "low" } },
                    ],
                },
            ],
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`vision model error ${response.status}: ${err.slice(0, 200)}`);
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
        throw new Error("vision model returned no description");
    }
    return text.trim();
}
