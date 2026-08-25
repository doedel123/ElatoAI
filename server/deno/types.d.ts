import { SupabaseClient } from '@supabase/supabase-js';

declare global {
    interface IConversation {
        conversation_id: string;
        role: 'user' | 'assistant';
        content: string;
        user_id: string;
        is_sensitive: boolean;
        personality_key: string;
        created_at: string;
    }

    interface IPayload {
        user: IUser;
        supabase: SupabaseClient;
        timestamp: string;
    }

    interface IDevice {
        device_id: string;
        volume: number;
        is_ota: boolean;
        is_reset: boolean;
        mac_address: string;
        user_code: string;
    }

    type ModelProvider = 'openai' | 'gemini' | 'elevenlabs' | 'hume' | 'grok';

    type GrokVoice =
        | 'Ara'
        | 'Eve'
        | 'Leo'
        | 'Rex'
        | 'Sal';

    type GeminiVoice =
        | 'Zephyr'
        | 'Puck'
        | 'Charon'
        | 'Kore'
        | 'Fenrir'
        | 'Leda'
        | 'Orus'
        | 'Aoede'
        | 'Callirrhoe'
        | 'Autonoe'
        | 'Enceladus'
        | 'Iapetus'
        | 'Umbriel'
        | 'Algieba'
        | 'Despina'
        | 'Erinome'
        | 'Algenib'
        | 'Rasalgethi'
        | 'Laomedeia'
        | 'Achernar'
        | 'Alnilam'
        | 'Schedar'
        | 'Gacrux'
        | 'Pulcherrima'
        | 'Achird'
        | 'Zubenelgenubi'
        | 'Vindemiatrix'
        | 'Sadachbia'
        | 'Sadaltager'
        | 'Sulafat';

    type OaiVoice =
        | 'ash'
        | 'alloy'
        | 'echo'
        | 'shimmer'
        | 'ballad'
        | 'coral'
        | 'sage'
        | 'verse';

    /**
     * Note: oai_voice is essentially the name of the voice.
     * the naming here sucks, please change it
     */
    interface IPersonality {
        personality_id: string;
        is_doctor: boolean;
        is_child_voice: boolean;
        is_story: boolean;
        key: string;
        voice?: {
            config?: {
                config_id?: string;
            };
        };
        oai_voice: string;
        provider: ModelProvider;
        voice_description: string;
        title: string;
        subtitle: string;
        short_description: string;
        character_prompt: string;
        voice_prompt: string;
        creator_id: string | null;
        pitch_factor: number;
        first_message_prompt: string;
    }

    interface ILanguage {
        language_id: string;
        code: string;
        name: string;
        flag: string;
    }

    interface IDoctorMetadata {
        doctor_name: string;
        specialization: string;
        hospital_name: string;
        favorite_phrases: string;
    }

    interface IUserMetadata {}
    interface IBusinessMetadata {}

    type UserInfo =
        | {
            user_type: 'user';
            user_metadata: IUserMetadata;
        }
        | {
            user_type: 'doctor';
            user_metadata: IDoctorMetadata;
        }
        | {
            user_type: 'business';
            user_metadata: IBusinessMetadata;
        };

    interface IUser {
        user_id: string;
        avatar_url: string;
        is_premium: boolean;
        email: string;
        supervisor_name: string;
        supervisee_name: string;
        supervisee_persona: string;
        supervisee_age: number;
        personality_id: string;
        personality?: IPersonality;
        language: ILanguage;
        language_code: string;
        session_time: number;
        user_info: UserInfo;
        device_id: string;
        device?: IDevice;
    }

    // Hume EVI WebSocket message types
    interface HumeMessage {
        type: string;
        [key: string]: any;
    }

    interface HumeAudioInput {
        type: 'audio_input';
        data: string; // base64 encoded audio
    }

    interface HumeUserInput {
        type: 'user_input';
        text: string;
    }

    interface HumeAssistantInput {
        type: 'assistant_input';
        text: string;
    }

    interface HumeSessionSettings {
        type: 'session_settings';
        [key: string]: any;
    }

    interface HumeAssistantMessage {
        type: 'assistant_message';
        message: {
            role: 'assistant';
            content: string;
        };
        models: {
            prosody?: {
                scores: Record<string, number>;
            };
        };
    }

    interface HumeAudioOutput {
        type: 'audio_output';
        data: string; // base64 encoded audio
    }

    interface HumeError {
        type: 'error';
        code: string;
        message: string;
    }

    interface ClientWebSocket {
        send(data: any): void;
        close(code?: number, reason?: string): void;
        on(event: string, handler: (...args: any[]) => void | Promise<void>): ClientWebSocket;
    }

    interface OpusPacketizer {
        push(pcm: Uint8Array): void;
        flush(padFinalFrame?: boolean): void;
        reset(): void;
        close(): void;
        bufferedBytes(): number;
    }

    type OpusPacketizerFactory = (
        sendPacket: (packet: Uint8Array) => void,
    ) => OpusPacketizer;

    interface ProviderArgs {
        ws: ClientWebSocket;
        payload: IPayload;
        connectionPcmFile: Deno.FsFile | null;
        firstMessage: string;
        systemPrompt: string;
        closeHandler: () => Promise<void>;
        // Optional override for the downlink Opus packetizer. Used by the
        // XIAOZHI adapter to emit 60ms frames instead of the ELATO default 120ms.
        opusFactory?: OpusPacketizerFactory;
        // When true, providers emit extra { type: "server", msg: "STT" |
        // "TTS_SENTENCE" | "EMOTION" } control messages so the XIAOZHI adapter
        // can drive the device screen. Left false (default) for ELATO devices.
        emitTextEvents?: boolean;
        // When present (XIAOZHI with a camera), providers register a take_photo
        // tool. It asks the device for a photo via MCP and returns a textual
        // description from a vision model — decoupled from the audio session.
        requestPhoto?: (question: string) => Promise<string>;
        // Raw-JPEG variant of requestPhoto: triggers the camera and resolves
        // with the uploaded bytes. Multimodal providers (Gemini Live) push the
        // image straight into the audio session instead of describing it.
        capturePhoto?: () => Promise<Uint8Array>;
        // Concierge mode (XIAOZHI entry): Gemini-only session with memory,
        // google_search grounding and personality list/switch tools.
        conciergeMode?: boolean;
        // When present (XIAOZHI with MCP), providers register the curated
        // device-control tools (volume, brightness, theme, status) that route
        // to the device via MCP tools/call.
        callDeviceTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
        // When present (XIAOZHI with a screen), providers register a show_image
        // tool. Fire-and-forget: kicks off async image generation and pushes the
        // result to the device screen — does not block the audio response.
        showImage?: (description: string) => void;
        // When present (XIAOZHI with camera + screen), providers register a
        // stylize_photo tool: takes a camera photo, restyles it via an image
        // model (photo as reference), and pushes the result to the screen.
        // Resolves once the photo is captured; generation continues async.
        stylizePhoto?: (instruction: string) => Promise<string>;
        // When present (XIAOZHI with a screen), the session pushes a
        // time-of-day greeting image of the active character on start and
        // after a personality switch (structurally a GeneratedImage).
        pushImage?: (
            img: { jpegBase64: string; width: number; height: number },
            durationMs?: number,
        ) => void;
    }
}
