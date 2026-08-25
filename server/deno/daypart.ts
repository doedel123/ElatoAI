// Local-time helpers for time-of-day-aware greetings. The server runs in UTC
// (Deno Deploy), so the user's local time comes from the TIMEZONE env (IANA
// name, e.g. "Europe/Berlin").
const TIMEZONE = Deno.env.get("TIMEZONE") ?? "Europe/Berlin";

export interface DaypartInfo {
    key: "morning" | "midday" | "evening" | "night";
    // English label for prompt text ("morning", "evening", ...).
    label: string;
    // Visual scene descriptor for greeting images.
    scene: string;
    // "07:32" in the configured timezone.
    localTime: string;
    // "Tuesday" in the configured timezone.
    weekday: string;
}

const DAYPARTS: Record<DaypartInfo["key"], { label: string; scene: string }> = {
    morning: {
        label: "morning",
        scene: "soft golden sunrise light, fresh cheerful morning atmosphere",
    },
    midday: {
        label: "midday",
        scene: "bright daylight, blue sky with fluffy clouds, lively daytime mood",
    },
    evening: {
        label: "evening",
        scene: "warm golden sunset light, cozy evening glow",
    },
    night: {
        label: "night",
        scene: "calm starry night sky, gentle moonlight, cozy sleepy atmosphere",
    },
};

/** The current time of day in the configured timezone. */
export function getDaypart(now = new Date()): DaypartInfo {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: TIMEZONE,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        weekday: "long",
    }).formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

    const hour = Number(get("hour"));
    const key: DaypartInfo["key"] = hour >= 5 && hour < 11
        ? "morning"
        : hour >= 11 && hour < 17
        ? "midday"
        : hour >= 17 && hour < 22
        ? "evening"
        : "night";

    return {
        key,
        ...DAYPARTS[key],
        localTime: `${get("hour")}:${get("minute")}`,
        weekday: get("weekday"),
    };
}

/** Instruction appended to first messages so the spoken greeting fits the time of day. */
export function greetingTimeInstruction(d = getDaypart()): string {
    return `The user's local time is ${d.localTime} on ${d.weekday} (${d.label}). ` +
        `Open with a short greeting that matches this time of day, in your language.`;
}

/** Human-readable local time line for system prompts. */
export function localTimeLine(d = getDaypart()): string {
    return `${d.weekday}, ${d.localTime} (${d.label})`;
}
