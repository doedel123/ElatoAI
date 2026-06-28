import { openaiApiKey } from "./utils.ts";

/** The 21 emotions the XIAOZHI firmware can display (emoji_collection.cc). */
export const XIAOZHI_EMOTIONS = [
    "neutral", "happy", "laughing", "funny", "sad", "angry", "crying", "loving",
    "embarrassed", "surprised", "shocked", "thinking", "winking", "cool",
    "relaxed", "delicious", "kissy", "confident", "sleepy", "silly", "confused",
] as const;

const EMOTION_SET = new Set<string>(XIAOZHI_EMOTIONS);

// Emoji -> emotion. Language-agnostic (works for any language's text).
const EMOJI_EMOTION: Array<[string, string]> = [
    ["😂", "laughing"], ["🤣", "laughing"], ["😆", "laughing"],
    ["😄", "happy"], ["😊", "happy"], ["🙂", "happy"], ["😃", "happy"],
    ["😍", "loving"], ["🥰", "loving"], ["❤", "loving"], ["😘", "kissy"],
    ["😢", "crying"], ["😭", "crying"], ["😠", "angry"], ["😡", "angry"],
    ["😮", "surprised"], ["😲", "shocked"], ["😱", "shocked"],
    ["🤔", "thinking"], ["😉", "winking"], ["😎", "cool"], ["😌", "relaxed"],
    ["😋", "delicious"], ["😴", "sleepy"], ["🤪", "silly"], ["😜", "silly"],
    ["😕", "confused"], ["😳", "embarrassed"], ["😏", "confident"],
];

/**
 * Instant, language-agnostic emotion guess from text. Relies only on universal
 * signals (emoji, laughter patterns, punctuation) — no per-language word lists,
 * so it keeps working as more languages are added. Returns null when there's no
 * strong signal (let the classifier decide).
 */
export function heuristicEmotion(text: string): string | null {
    if (!text) return null;
    for (const [emoji, emo] of EMOJI_EMOTION) {
        if (text.includes(emoji)) return emo;
    }
    const t = text.toLowerCase();
    if (/(ha){2,}|(he){2,}|\b(lol|lmao|rofl|haha+)\b/.test(t)) return "laughing";
    if (/!{2,}/.test(text)) return "surprised";
    if (text.trim().endsWith("?")) return "thinking";
    if (/\.\.\.|…/.test(text)) return "thinking";
    if (text.includes("!")) return "happy";
    return null;
}

const SYSTEM_PROMPT =
    "You label the dominant emotion of a short assistant message. The message " +
    "may be in ANY language. Reply with EXACTLY ONE of these English words and " +
    "nothing else: " + XIAOZHI_EMOTIONS.join(", ") +
    ". If unsure, reply: neutral.";

const classifierEnabled = Deno.env.get("EMOTION_CLASSIFIER") !== "false";

/**
 * Accurate, multilingual emotion classification via a small chat model. Always
 * resolves (never throws) — falls back to "neutral" on any error.
 */
export async function classifyEmotion(text: string): Promise<string> {
    if (!classifierEnabled || !openaiApiKey || !text.trim()) return "neutral";
    try {
        const resp = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${openaiApiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: Deno.env.get("EMOTION_MODEL") ?? "gpt-4.1-mini",
                max_tokens: 3,
                temperature: 0,
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: text.slice(0, 500) },
                ],
            }),
        });
        if (!resp.ok) return "neutral";
        const data = await resp.json();
        const word = String(data?.choices?.[0]?.message?.content ?? "")
            .trim().toLowerCase().replace(/[^a-z]/g, "");
        return EMOTION_SET.has(word) ? word : "neutral";
    } catch {
        return "neutral";
    }
}
