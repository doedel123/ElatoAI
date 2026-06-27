/**
 * Curated set of built-in XIAOZHI device MCP tools exposed to the realtime
 * model. Provider-neutral specs; each provider (OpenAI / Gemini) converts them
 * to its own function-tool schema. All calls are routed to the device via MCP
 * `tools/call` (see XiaozhiWebSocketAdapter.callDeviceTool).
 *
 * `name` is the model-facing tool name (no dots — OpenAI requires
 * `^[a-zA-Z0-9_-]+$`); `mcpName` is the device's MCP method.
 *
 * Tools the device doesn't actually have (e.g. screen tools on a screenless
 * device) simply return an error from the device, which the model handles.
 */
export interface DeviceToolParam {
    name: string;
    type: "integer" | "string";
    description: string;
    minimum?: number;
    maximum?: number;
}

export interface DeviceToolSpec {
    name: string;
    mcpName: string;
    description: string;
    params: DeviceToolParam[];
}

export const XIAOZHI_DEVICE_TOOLS: DeviceToolSpec[] = [
    {
        name: "get_device_status",
        mcpName: "self.get_device_status",
        description:
            "Get the device's current status, including battery level, charging state, speaker volume and other hardware info. Use when the user asks about battery or device state.",
        params: [],
    },
    {
        name: "set_volume",
        mcpName: "self.audio_speaker.set_volume",
        description:
            "Set the speaker volume of the device. Use when the user asks to make it louder, quieter, or to set a specific volume.",
        params: [{
            name: "volume",
            type: "integer",
            description: "Target volume from 0 (mute) to 100 (max).",
            minimum: 0,
            maximum: 100,
        }],
    },
    {
        name: "set_brightness",
        mcpName: "self.screen.set_brightness",
        description:
            "Set the screen brightness. Only works on devices that have a screen.",
        params: [{
            name: "brightness",
            type: "integer",
            description: "Target brightness from 0 to 100.",
            minimum: 0,
            maximum: 100,
        }],
    },
    {
        name: "set_theme",
        mcpName: "self.screen.set_theme",
        description:
            "Set the screen theme (for example 'light' or 'dark'). Only works on devices that have a screen.",
        params: [{
            name: "theme",
            type: "string",
            description: "Theme name, e.g. 'light' or 'dark'.",
        }],
    },
];

// Quick lookup from model-facing name -> device MCP method.
export const XIAOZHI_DEVICE_TOOL_BY_NAME: Record<string, DeviceToolSpec> = Object
    .fromEntries(XIAOZHI_DEVICE_TOOLS.map((t) => [t.name, t]));
