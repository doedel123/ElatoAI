/// <reference path="./types.d.ts" />

/**
 * Concierge mode: the device no longer boots into the DB-assigned personality
 * but into a general Gemini Live assistant with memory, camera, web search,
 * and the ability to list and switch into the stored personalities.
 */

import { SupabaseClient } from '@supabase/supabase-js';

export interface PersonalitySummary {
    personality_id: string;
    key: string;
    title: string;
    subtitle: string;
    short_description: string;
    is_story: boolean;
}

/** Public personalities plus the user's own creations. */
export async function listPersonalities(
    supabase: SupabaseClient,
    userId: string,
): Promise<PersonalitySummary[]> {
    const { data, error } = await supabase
        .from('personalities')
        .select('personality_id, key, title, subtitle, short_description, is_story, creator_id')
        .or(`creator_id.is.null,creator_id.eq.${userId}`)
        .order('title');
    if (error) throw new Error(`listPersonalities failed: ${error.message}`);
    return (data ?? []).map(({ creator_id: _creator, ...p }) => p as PersonalitySummary);
}

/**
 * Resolve a personality by key or (fuzzy) title. The model passes back what
 * the user said, so match case-insensitively on key, then title substring.
 */
export async function resolvePersonality(
    supabase: SupabaseClient,
    userId: string,
    nameOrKey: string,
): Promise<IPersonality | null> {
    const needle = nameOrKey.trim().toLowerCase();
    if (!needle) return null;
    const { data, error } = await supabase
        .from('personalities')
        .select('*')
        .or(`creator_id.is.null,creator_id.eq.${userId}`);
    if (error) throw new Error(`resolvePersonality failed: ${error.message}`);
    const rows = (data ?? []) as IPersonality[];
    return rows.find((p) => p.key?.toLowerCase() === needle) ??
        rows.find((p) => p.title?.toLowerCase() === needle) ??
        rows.find((p) => p.title?.toLowerCase().includes(needle)) ??
        null;
}

/** Persist the switch so the web app and future sessions agree. */
export async function setUserPersonality(
    supabase: SupabaseClient,
    userId: string,
    personalityId: string,
): Promise<void> {
    const { error } = await supabase
        .from('users')
        .update({ personality_id: personalityId })
        .eq('user_id', userId);
    if (error) throw new Error(`setUserPersonality failed: ${error.message}`);
}

/** System prompt for the concierge agent. Memory context is appended by the caller. */
export function createConciergePrompt(payload: IPayload): string {
    const { user } = payload;
    const language = user.language?.name ?? 'German';
    const superviseeName = user.supervisee_name ? ` The user's name is ${user.supervisee_name}.` : '';
    return `You are Elato, the friendly voice assistant living inside a small device with a screen, a camera and a speaker.${superviseeName}

The default language is: ${language} but you must switch to any other language if the user asks for it. Keep answers short and conversational — you are a voice, not a wall of text.

Your abilities, and when to use them:
- You have a long-term memory. Facts you learned earlier are provided in the <memory_bank> block below (if present). Use the "remember" tool when the user tells you something worth keeping (preferences, names, important events), and the "recall" tool when you need something that is not in the block.
- You can see through the camera: call "take_photo" and the picture will be attached to our conversation for you to look at directly. Use it whenever the user refers to something in front of the device.
- You can search the web for current information (news, weather, facts you are unsure about). Prefer searching over guessing.
- You can show pictures on the screen with "show_image" and restyle camera photos with "stylize_photo".
- The user can switch you into a different character. When asked which characters/personalities are available, call "list_personalities" and read the titles with a one-line description aloud in ${language}. When the user picks one, call "switch_personality" — announce the switch in one short sentence first.

Do not mention tool names or technical details to the user. Never claim you saved something to memory unless you actually called the tool.`;
}
