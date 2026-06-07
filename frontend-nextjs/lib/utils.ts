import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { defaultPersonalityId } from "./data";

export const getOpenGraphMetadata = (title: string) => {
    return {
        openGraph: {
            title: `${title} | Elato AI`,
        },
    };
};

export const PitchFactors = [
    { emoji: "🧟‍♂️", label: "Super Deep", desc: "Like Hulk" },
    { emoji: "👤", label: "Normal", desc: "Regular voice" },
    { emoji: "👧", label: "Higher", desc: "Kid-like voice" },
    { emoji: "🐿️", label: "Squeaky", desc: "Like Alvin" },
];

// code in the form: aabbccddeeff
export const isValidMacAddress = (macAddress: string): boolean => {
    // Check if macAddress is a valid MAC address with colon separators
    const macRegex = /^([0-9A-Fa-f]{2}:){5}([0-9A-Fa-f]{2})$/;
    return macRegex.test(macAddress);
};

export const getMacAddressFromDeviceCode = (deviceCode: string): string => {
    // add colons to the device code
    return deviceCode.substring(0, 2) + ":" + deviceCode.substring(2, 4) + ":" +
        deviceCode.substring(4, 6) + ":" + deviceCode.substring(6, 8) + ":" +
        deviceCode.substring(8, 10) + ":" + deviceCode.substring(10, 12);
};

export const AVAILABLE_PERSONALITY_KEYS = [
    "aggie_blood_test_pal",
    "art_guru",
    "art_guru3",
    "batman",
    "bear_maximillian",
    "bear_oliver",
    "bear_sam",
    "blood_test_pal_1",
    "captain_coral_reef",
    "dramatic_theater_actor",
    "eco_champ",
    "elato_default",
    "elsa",
    "elsa_ice_explorer",
    "female_lover",
    "fitness_coach",
    "gandalf",
    "geo_guide",
    "geo_guide2",
    "hipster_barista_sarcastic",
    "ironman",
    "kids_astronomy",
    "kids_books",
    "kids_english_teacher",
    "kids_football_teacher",
    "kids_math_teacher",
    "luna_epilepsy_pal",
    "luna_stargazer",
    "male_lover",
    "marco_time_machine",
    "master_chef",
    "math_wiz",
    "miles_multiverse_mission",
    "pip_pixie_garden",
    "porous_pete",
    "professor_particle_lab",
    "qura",
    "rex_lost_world",
    "santa_claus",
    "sherlock",
    "standup_comedian_funny_friend",
    "surfer_bro_chill_vibe",
    "surfer_gal_beach_vibes",
    "toad",
    "trixie_time_safari",
    "vax_buddy",
    "zara_zoo_detective"
];

export const hasPersonalityImage = (key: string): boolean => {
    if (!key) return false;
    const normalizedKey = key.toLowerCase().replace(/\s+/g, "_");
    return AVAILABLE_PERSONALITY_KEYS.includes(normalizedKey);
};

export const getPersonalityImageSrc = (title: string) => {
    if (!title) return "/personality/elato_default.jpeg";
    const key = title.toLowerCase().replace(/\s+/g, "_");
    if (["toad", "elsa"].includes(key)) {
        return `/personality/${key}.jpg`;
    }
    return `/personality/${key}.jpeg`;
};

export function removeEmojis(text: string): string {
    const emojiPattern: RegExp =
        /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2702}-\u{27B0}\u{24C2}-\u{1F251}]/gu;
    return text.replace(emojiPattern, "");
}

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export const isDefaultPersonality = (personality: IPersonality) => {
    return personality.personality_id === defaultPersonalityId;
};

export const getBaseUrl = () => {
    return process.env.NEXT_PUBLIC_VERCEL_ENV === "production"
        ? "https://elatoai.com"
        : "http://localhost:3000";
};

export const getUserAvatar = (avatar_url: string) => {
    return avatar_url;
};

export const getAssistantAvatar = (imageSrc: string) => {
    return "/" + imageSrc + ".png";
};
