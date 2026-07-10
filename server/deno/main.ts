/// <reference path="./types.d.ts" />

import { Buffer } from 'node:buffer';
import * as jose from 'https://deno.land/x/jose@v5.9.6/index.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { authenticateUser, createOpusPacketizer } from './utils.ts';
import { XiaozhiWebSocketAdapter } from './xiaozhi.ts';
import { describeImage } from './vision.ts';
import { generateSceneImage } from './image_gen.ts';
import {
    createFirstMessage,
    createSystemPrompt,
    getChatHistory,
    getSupabaseClient,
} from './supabase.ts';
import { SupabaseClient } from '@supabase/supabase-js';
import { isDev } from './utils.ts';
import { connectToOpenAI } from './models/openai.ts';
import { connectToGemini } from './models/gemini.ts';
import { connectToElevenLabs } from './models/elevenlabs.ts';
import { connectToHume } from './models/hume.ts';
import { connectToGrok } from './models/grok.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_KEY')!;
const personalityImageBaseUrl = (Deno.env.get('PERSONALITY_IMAGE_BASE_URL') ?? 'https://elatoai.aionetwo.deno.net')
    .replace(/\/+$/, '');
const testAudiobookMp3Url = Deno.env.get('TEST_AUDIOBOOK_MP3_URL') ??
    'https://imagebuck-s3-wv.s3.eu-west-1.amazonaws.com/der-rattenfaenger-von-hameln.mp3';
const testAudiobookTitle = Deno.env.get('TEST_AUDIOBOOK_TITLE') ??
    'Der Rattenfaenger von Hameln';

// Uplink (mic) PCM rate each provider expects. The XIAOZHI adapter resamples
// the device's 16kHz audio to this rate. Providers absent here are not yet
// verified for XIAOZHI (only openai + gemini are wired with the 60ms downlink).
const XIAOZHI_PROVIDER_UPLINK_RATE: Record<string, number> = {
    openai: 24000,
    gemini: 16000,
};

// Shared secret handed to the device in the MCP `initialize` (capabilities.vision.token)
// and verified on the vision endpoint. Keeps random callers from hitting the VLM.
const XIAOZHI_VISION_TOKEN = Deno.env.get('XIAOZHI_VISION_TOKEN') ?? 'elato-vision';

function jsonResponse(
    status: number,
    payload: unknown,
) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
        },
    });
}

function healthResponse(method: string) {
    const body = JSON.stringify({
        ok: true,
        service: 'elato-deno-realtime',
        websocket: true,
        timestamp: new Date().toISOString(),
    });
    return new Response(method === 'HEAD' ? null : body, {
        status: 200,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
        },
    });
}

function getMacAddressVariants(macAddress: string): string[] {
    const trimmed = macAddress.trim();
    const compact = trimmed.replace(/[^0-9a-fA-F]/g, '');
    const variants = new Set<string>([
        trimmed,
        trimmed.toUpperCase(),
        trimmed.toLowerCase(),
    ]);

    if (/^[0-9a-fA-F]{12}$/.test(compact)) {
        const colonSeparated = compact.match(/.{1,2}/g)?.join(':');
        if (colonSeparated) {
            variants.add(colonSeparated.toUpperCase());
            variants.add(colonSeparated.toLowerCase());
        }
        variants.add(compact.toUpperCase());
        variants.add(compact.toLowerCase());
    }

    return [...variants].filter(Boolean);
}

function normalizeMacAddress(macAddress: string | null | undefined): string {
    return macAddress?.replace(/[^0-9a-fA-F]/g, '').toLowerCase() ?? '';
}

function getPersonalityImageUrl(personality: IPersonality | undefined): string | null {
    if (!personality?.key || personality.creator_id) {
        return null;
    }

    return `${personalityImageBaseUrl}/personality/${encodeURIComponent(personality.key)}.jpeg`;
}

function getAudiobookContent() {
    if (!testAudiobookMp3Url) {
        return {
            audiobook_mp3_url: null,
            audiobook_title: null,
        };
    }

    return {
        audiobook_mp3_url: testAudiobookMp3Url,
        audiobook_title: testAudiobookTitle,
    };
}

async function getPersonalityImageBase64(personality: IPersonality | undefined): Promise<string | null> {
    if (!personality?.key || personality.creator_id) {
        return null;
    }

    const filename = `${personality.key}.jpeg`;
    if (!/^[a-zA-Z0-9_-]+\.jpeg$/.test(filename)) {
        return null;
    }

    try {
        const imagePath = new URL(`./personality/${filename}`, import.meta.url);
        const data = await Deno.readFile(imagePath);
        return Buffer.from(data).toString('base64');
    } catch (error) {
        console.warn('Failed to inline personality image:', filename, error);
        return null;
    }
}

async function handlePersonalityImage(req: Request, pathname: string) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return jsonResponse(405, { error: 'Method not allowed' });
    }

    const filename = decodeURIComponent(pathname.slice('/personality/'.length));
    if (!/^[a-zA-Z0-9_-]+\.jpeg$/.test(filename)) {
        return jsonResponse(400, { error: 'Invalid image name' });
    }

    try {
        const imagePath = new URL(`./personality/${filename}`, import.meta.url);
        const data = req.method === 'HEAD' ? null : await Deno.readFile(imagePath);
        if (req.method === 'HEAD') {
            await Deno.stat(imagePath);
        }
        return new Response(data, {
            status: 200,
            headers: {
                'content-type': 'image/jpeg',
                'cache-control': 'public, max-age=86400',
            },
        });
    } catch {
        return jsonResponse(404, { error: 'Personality image not found' });
    }
}

async function getUserByMacAddress(macAddress: string): Promise<IUser | null> {
    const supabase = createClient(supabaseUrl, supabaseKey);

    for (const variant of getMacAddressVariants(macAddress)) {
        const { data, error } = await supabase.from('devices').select(
            'mac_address, user:user_id(*)',
        ).eq('mac_address', variant).maybeSingle();
        if (error) {
            throw new Error(error.message);
        }
        if (data) {
            return data.user as unknown as IUser | null;
        }
    }

    const { data, error } = await supabase.from('devices').select(
        'mac_address, user:user_id(*)',
    ).ilike('mac_address', macAddress.trim()).limit(1).maybeSingle();
    if (error) {
        throw new Error(error.message);
    }
    return data?.user as unknown as IUser | null;
}

async function getDevUser(): Promise<IUser | null> {
    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data, error } = await supabase.from('users').select('*').eq(
        'email',
        'admin@elatoai.com',
    ).single();
    if (error) {
        throw new Error(error.message);
    }
    return data as IUser | null;
}

async function createSupabaseToken(user: IUser, nfcId?: string | null): Promise<string> {
    const jwtSecretKey = Deno.env.get('JWT_SECRET_KEY');
    if (!jwtSecretKey) {
        throw new Error('JWT_SECRET_KEY not configured');
    }

    const payload = {
        email: user.email,
        user_id: user.user_id,
        created_time: new Date().toISOString(),
        nfc_id: nfcId || undefined,
    };
    const secret = new TextEncoder().encode(jwtSecretKey);

    return await new jose.SignJWT({
        role: 'authenticated',
        email: user.email,
        user_metadata: payload,
    })
        .setProtectedHeader({ alg: 'HS256' })
        .setAudience('authenticated')
        .setSubject(user.user_id)
        .setIssuedAt()
        .sign(secret);
}

async function handleGenerateAuthToken(
    url: URL,
) {
    const macAddress = url.searchParams.get('macAddress');
    if (!macAddress) {
        return jsonResponse(400, { error: 'MAC address is required' });
    }

    const nfcId = url.searchParams.get('nfcId');
    const normalizedNfcId = nfcId ? nfcId.replace(/[^0-9a-fA-F]/g, '').toUpperCase() : null;

    const skipDeviceRegistration = Deno.env.get('SKIP_DEVICE_REGISTRATION') === 'True' ||
        Deno.env.get('NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION') === 'True';

    const user = skipDeviceRegistration
        ? await getDevUser()
        : await getUserByMacAddress(macAddress);
    if (!user) {
        return jsonResponse(404, {
            error: 'Device not found or not linked to a user',
            macAddress,
        });
    }

    const token = await createSupabaseToken(user, normalizedNfcId);
    return jsonResponse(200, { token });
}

async function handleDeviceContent(url: URL) {
    const macAddress = url.searchParams.get('macAddress');
    if (!macAddress) {
        return jsonResponse(400, { error: 'MAC address is required' });
    }

    const skipDeviceRegistration = Deno.env.get('SKIP_DEVICE_REGISTRATION') === 'True' ||
        Deno.env.get('NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION') === 'True';

    const user = skipDeviceRegistration
        ? await getDevUser()
        : await getUserByMacAddress(macAddress);
    if (!user) {
        return jsonResponse(404, {
            error: 'Device not found or not linked to a user',
            macAddress,
        });
    }

    return jsonResponse(200, getAudiobookContent());
}

class ClientWebSocketAdapter {
    private messageHandlers: Array<(data: Buffer, isBinary: boolean) => void> = [];
    private errorHandlers: Array<(error: unknown) => void> = [];
    private closeHandlers: Array<(code: number, reason: string) => void> = [];

    constructor(private readonly socket: WebSocket) {
        this.socket.binaryType = 'arraybuffer';
        this.socket.onmessage = (event) => {
            const isBinary = typeof event.data !== 'string';
            const data = typeof event.data === 'string'
                ? Buffer.from(event.data)
                : event.data instanceof ArrayBuffer
                ? Buffer.from(event.data)
                : Buffer.from(event.data);

            for (const handler of this.messageHandlers) {
                handler(data, isBinary);
            }
        };
        this.socket.onerror = (event) => {
            for (const handler of this.errorHandlers) {
                handler(event);
            }
        };
        this.socket.onclose = (event) => {
            for (const handler of this.closeHandlers) {
                handler(event.code, event.reason);
            }
        };
    }

    send(data: string | Uint8Array | ArrayBuffer) {
        this.socket.send(data);
    }

    close(code?: number, reason?: string) {
        this.socket.close(code, reason);
    }

    on(event: string, handler: (...args: any[]) => void | Promise<void>) {
        if (event === 'message') {
            this.messageHandlers.push(handler as (data: Buffer, isBinary: boolean) => void);
        } else if (event === 'error') {
            this.errorHandlers.push(handler as (error: unknown) => void);
        } else if (event === 'close') {
            this.closeHandlers.push(handler as (code: number, reason: string) => void);
        }
        return this;
    }
}

async function handleConnection(
    ws: ClientWebSocket,
    payload: IPayload,
    opts: {
        sendAuthMessage?: boolean;
        opusFactory?: OpusPacketizerFactory;
        emitTextEvents?: boolean;
        requestPhoto?: (question: string) => Promise<string>;
        callDeviceTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
        showImage?: (description: string) => void;
    } = {},
) {
    const { user, supabase } = payload;

    let connectionPcmFile: Deno.FsFile | null = null;
    if (isDev) {
        const filename = `debug_audio_${Date.now()}.pcm`;
        connectionPcmFile = await Deno.open(filename, {
            create: true,
            write: true,
            append: true,
        });
    }

    const chatHistory = await getChatHistory(
        supabase,
        user.user_id,
        user.personality?.key ?? null,
        false,
    );
    const firstMessage = createFirstMessage(payload);
    const systemPrompt = createSystemPrompt(chatHistory, payload);

    const provider = user.personality?.provider ?? 'openai';
    if (!user.personality?.provider) {
        console.warn('Personality has no provider configured; falling back to openai');
    }
    const personalityImageBase64 = await getPersonalityImageBase64(user.personality);

    // send user details to client
    // when DEV_MODE is true, we send the default values 100, false, false
    // The XIAOZHI adapter has no use for this ELATO-specific message.
    if (opts.sendAuthMessage !== false) {
        ws.send(
            JSON.stringify({
                type: 'auth',
                volume_control: user.device?.volume ?? 50,
                is_ota: user.device?.is_ota ?? false,
                is_reset: user.device?.is_reset ?? false,
                pitch_factor: user.personality?.pitch_factor ?? 1,
                personality_image_url: getPersonalityImageUrl(user.personality),
                personality_image_jpeg_base64: personalityImageBase64,
                ...getAudiobookContent(),
            }),
        );
    }

    // Common close handler for cleanup
    const closeHandler = async () => {
        // Add any common cleanup logic here
    };

    // Common provider args
    const providerArgs: ProviderArgs = {
        ws,
        payload,
        connectionPcmFile,
        firstMessage,
        systemPrompt,
        closeHandler,
        opusFactory: opts.opusFactory,
        emitTextEvents: opts.emitTextEvents,
        requestPhoto: opts.requestPhoto,
        callDeviceTool: opts.callDeviceTool,
        showImage: opts.showImage,
    };

    switch (provider) {
        case 'openai':
            await connectToOpenAI(providerArgs);
            break;
        case 'gemini':
            await connectToGemini(providerArgs);
            break;
        case 'grok':
            await connectToGrok(providerArgs);
            break;
        case 'elevenlabs':
            await connectToElevenLabs(providerArgs);
            break;
        case 'hume':
            await connectToHume(providerArgs);
            break;
        default:
            throw new Error(`Unknown provider: ${provider}`);
    }
}

async function handleWebSocket(req: Request) {
    let user: IUser;
    let supabase: SupabaseClient;
    try {
        const authHeader = req.headers.get('authorization') ?? '';
        const rssi = req.headers.get('x-wifi-rssi') ?? '0';
        const deviceMac = req.headers.get('x-device-mac');
        const authToken = authHeader.replace(/^Bearer\s+/i, '');
        const wifiStrength = parseInt(rssi);

        console.log('WiFi RSSI:', wifiStrength);

        if (!authToken) {
            return new Response('Unauthorized', { status: 401 });
        }

        supabase = getSupabaseClient(authToken);
        user = await authenticateUser(supabase, authToken);

        // allow any mac address for dev
        const expectedMac = user.device?.mac_address;
        if (
            !isDev && deviceMac && expectedMac &&
            normalizeMacAddress(deviceMac) !== normalizeMacAddress(expectedMac)
        ) {
            return new Response('Unauthorized', { status: 401 });
        }
    } catch (error: any) {
        console.error('WS authentication failed:', error?.message ?? error);
        return new Response('Unauthorized', { status: 401 });
    }

    const { socket, response } = Deno.upgradeWebSocket(req);
    const ws = new ClientWebSocketAdapter(socket);

    socket.onopen = () => {
        void handleConnection(ws, {
            user,
            supabase,
            timestamp: new Date().toISOString(),
        }).catch((error: any) => {
            console.error('Connection setup failed:', error?.message ?? error);
            ws.close(1011, 'Connection setup failed');
        });
    };

    return response;
}

/**
 * Entry point for XIAOZHI-ESP32 devices (Toniebox-protocol cousins).
 *
 * Auth is by the `Device-Id` header (the device MAC), mapped to a user via the
 * `devices` table — the same path as `generate_auth_token`. The connection is
 * wrapped in a XiaozhiWebSocketAdapter that translates the XIAOZHI protocol to
 * the ELATO provider interface, then handed to the shared `handleConnection`.
 */
async function handleXiaozhiWebSocket(req: Request) {
    let user: IUser | null;
    let supabase: SupabaseClient;
    try {
        // Real devices send the MAC as a header; the `?device_id=` query param
        // is a fallback for clients that can't set headers (e.g. the simulator,
        // since Deno's WebSocket client has no header support).
        const deviceMac = req.headers.get('device-id') ??
            req.headers.get('x-device-mac') ??
            new URL(req.url).searchParams.get('device_id');
        if (!deviceMac) {
            return new Response('Device-Id header required', { status: 401 });
        }

        const skipDeviceRegistration =
            Deno.env.get('SKIP_DEVICE_REGISTRATION') === 'True' ||
            Deno.env.get('NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION') === 'True';

        supabase = createClient(supabaseUrl, supabaseKey);
        user = skipDeviceRegistration
            ? await getDevUser()
            : await getUserByMacAddress(deviceMac);

        if (!user) {
            return new Response('Device not linked to a user', { status: 401 });
        }
    } catch (error: any) {
        console.error('XIAOZHI authentication failed:', error?.message ?? error);
        return new Response('Unauthorized', { status: 401 });
    }

    const authedUser = user;

    // Each provider expects the uplink (mic) PCM at a specific rate. We resample
    // the device's 16kHz audio accordingly in the adapter.
    const provider = authedUser.personality?.provider ?? 'openai';
    const uplinkSampleRate = XIAOZHI_PROVIDER_UPLINK_RATE[provider];
    if (uplinkSampleRate === undefined) {
        console.warn(
            `XIAOZHI: provider '${provider}' is not verified for XIAOZHI (downlink/uplink audio may be wrong). Use 'openai' or 'gemini'.`,
        );
    }

    const visionUrl = getXiaozhiVisionUrl(req);
    console.log(
        `XIAOZHI WS connect: mac=${authedUser.device?.mac_address ?? '?'} provider=${provider} visionUrl=${visionUrl}`,
    );

    const { socket, response } = Deno.upgradeWebSocket(req);
    const ws = new XiaozhiWebSocketAdapter(socket, {
        uplinkSampleRate: uplinkSampleRate ?? 24000,
        visionUrl,
        visionToken: XIAOZHI_VISION_TOKEN,
    });

    socket.onopen = () => {
        void handleConnection(ws, {
            user: authedUser,
            supabase,
            timestamp: new Date().toISOString(),
        }, {
            sendAuthMessage: false,
            emitTextEvents: true,
            requestPhoto: (question) => ws.requestPhoto(question),
            callDeviceTool: (name, callArgs) => ws.callDeviceTool(name, callArgs),
            // Fire-and-forget: generate the image in the background, then push
            // it to the device screen — never blocks the audio response.
            showImage: (description) => {
                console.log(`XIAOZHI show_image: "${description.slice(0, 80)}"`);
                const durationMs = Number(Deno.env.get('XIAOZHI_IMAGE_DURATION_MS') ?? '5000');
                generateSceneImage(description)
                    .then((img) => {
                        ws.sendImage(img.jpegBase64, img.width, img.height, durationMs);
                        console.log(`XIAOZHI image pushed (${Math.round(img.jpegBase64.length / 1024)}KB b64, ${durationMs}ms)`);
                    })
                    .catch((e) => console.error('XIAOZHI image gen failed:', e?.message ?? e));
            },
            // XIAOZHI decoder expects 60ms frames; downlink stays at 24kHz
            // (both OpenAI and Gemini output 24kHz audio).
            opusFactory: (sendPacket) =>
                createOpusPacketizer(sendPacket, {
                    sampleRate: 24000,
                    frameDurationMs: 60,
                }),
        }).catch((error: any) => {
            console.error(
                'XIAOZHI connection setup failed:',
                error?.message ?? error,
            );
            ws.close(1011, 'Connection setup failed');
        });
    };

    return response;
}

/**
 * The wss:// URL the XIAOZHI device should connect to. Overridable via
 * XIAOZHI_WS_URL; otherwise derived from the request host.
 */
function getXiaozhiWsUrl(req: Request): string {
    const override = Deno.env.get('XIAOZHI_WS_URL');
    if (override) return override;
    const url = new URL(req.url);
    const host = req.headers.get('host') ?? url.host;
    // wss:// in production (https), ws:// for local http dev.
    const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
    const scheme = proto === 'https' ? 'wss' : 'ws';
    return `${scheme}://${host}/xiaozhi/v1/`;
}

/**
 * XIAOZHI OTA / server-discovery endpoint (the device's CONFIG_OTA_URL).
 *
 * The device POSTs its system info with a `Device-Id` (MAC) header. We return
 * the WebSocket config so it knows where to connect, plus server_time and a
 * non-newer firmware section (so no spurious OTA update is triggered).
 *
 * Field contract per the firmware's Ota::CheckVersion parser:
 *   websocket{url, token, version}, firmware{version, url}, server_time{...}.
 *
 * The MAC is only logged here; the WebSocket handler remains the real auth
 * gate (getUserByMacAddress).
 */
async function handleXiaozhiOta(req: Request) {
    const deviceMac = req.headers.get('device-id') ??
        req.headers.get('x-device-mac') ?? '';

    // Echo the device's current firmware version back so it never sees a newer
    // one. Fall back to 0.0.0, which is never newer than any real build.
    let firmwareVersion = '0.0.0';
    if (req.method === 'POST') {
        try {
            const body = await req.json();
            const reported = body?.application?.version;
            if (typeof reported === 'string' && reported.length > 0) {
                firmwareVersion = reported;
            }
        } catch {
            // Non-JSON / empty body — keep the safe default.
        }
    }

    if (deviceMac) {
        try {
            const user = await getUserByMacAddress(deviceMac);
            console.log(
                `XIAOZHI OTA: ${deviceMac} -> ${user ? 'known device' : 'UNREGISTERED (will be rejected at WS connect)'}`,
            );
        } catch (error: any) {
            console.warn('XIAOZHI OTA device lookup failed:', error?.message ?? error);
        }
    }

    return jsonResponse(200, {
        server_time: {
            timestamp: Date.now(),
            timezone_offset: Number(Deno.env.get('XIAOZHI_TZ_OFFSET_MIN') ?? '0'),
        },
        firmware: {
            version: firmwareVersion,
            url: '',
        },
        websocket: {
            url: getXiaozhiWsUrl(req),
            token: Deno.env.get('XIAOZHI_WS_TOKEN') ?? 'elato',
            version: 1,
        },
    });
}

/** HTTP(S) URL of our vision-explain endpoint (handed to the device via MCP). */
function getXiaozhiVisionUrl(req: Request): string {
    const override = Deno.env.get('XIAOZHI_VISION_URL');
    if (override) return override;
    const url = new URL(req.url);
    const host = req.headers.get('host') ?? url.host;
    const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
    const scheme = proto === 'https' ? 'https' : 'http';
    return `${scheme}://${host}/xiaozhi/vision/explain`;
}

/**
 * XIAOZHI camera vision endpoint. The device POSTs a multipart form with a
 * `question` text field and a `file` JPEG, plus an `Authorization: Bearer`
 * token (the one we issued in the MCP initialize). We run a vision model and
 * return `{ success, result }`, which the device hands back to the realtime
 * model as the take_photo tool result.
 *
 * This is fully decoupled from the audio session, so it works regardless of
 * the personality's audio provider (incl. OpenAI Realtime, which has no vision).
 */
async function handleXiaozhiVision(req: Request) {
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (XIAOZHI_VISION_TOKEN && token !== XIAOZHI_VISION_TOKEN) {
        return jsonResponse(401, { success: false, result: 'unauthorized' });
    }
    const deviceMac = req.headers.get('device-id') ?? '';

    let question = '';
    let jpeg: Uint8Array | null = null;
    try {
        const form = await req.formData();
        question = String(form.get('question') ?? '');
        const file = form.get('file');
        if (file instanceof File) jpeg = new Uint8Array(await file.arrayBuffer());
    } catch {
        return jsonResponse(400, { success: false, result: 'invalid multipart form' });
    }
    if (!jpeg || jpeg.length === 0) {
        return jsonResponse(400, { success: false, result: 'no image provided' });
    }

    try {
        console.log(`XIAOZHI vision: ${deviceMac} q="${question}" jpeg=${jpeg.length}B`);
        const description = await describeImage(jpeg, question);
        return jsonResponse(200, { success: true, result: description });
    } catch (error: any) {
        console.error('XIAOZHI vision failed:', error?.message ?? error);
        // 200 with a spoken-friendly message so the model degrades gracefully.
        return jsonResponse(200, {
            success: false,
            result: "I couldn't make out the image just now.",
        });
    }
}

async function handleRequest(req: Request) {
    const url = new URL(req.url);

    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        if (url.pathname.startsWith('/xiaozhi/')) {
            return await handleXiaozhiWebSocket(req);
        }
        return await handleWebSocket(req);
    }

    if (url.pathname === '/xiaozhi/vision/explain') {
        if (req.method !== 'POST') {
            return jsonResponse(405, { success: false, result: 'method not allowed' });
        }
        try {
            return await handleXiaozhiVision(req);
        } catch (error) {
            return jsonResponse(500, {
                success: false,
                result: error instanceof Error ? error.message : 'internal error',
            });
        }
    }

    if (url.pathname === '/xiaozhi/ota' || url.pathname === '/xiaozhi/ota/') {
        if (req.method !== 'POST' && req.method !== 'GET') {
            return jsonResponse(405, { error: 'Method not allowed' });
        }
        try {
            return await handleXiaozhiOta(req);
        } catch (error) {
            return jsonResponse(500, {
                error: error instanceof Error ? error.message : 'Internal server error',
            });
        }
    }

    if (url.pathname === '/api/generate_auth_token') {
        if (req.method !== 'GET') {
            return jsonResponse(405, { error: 'Method not allowed' });
        }

        try {
            return await handleGenerateAuthToken(url);
        } catch (error) {
            return jsonResponse(500, {
                error: error instanceof Error ? error.message : 'Internal server error',
            });
        }
    }

    if (url.pathname === '/api/device_content') {
        if (req.method !== 'GET') {
            return jsonResponse(405, { error: 'Method not allowed' });
        }

        try {
            return await handleDeviceContent(url);
        } catch (error) {
            return jsonResponse(500, {
                error: error instanceof Error ? error.message : 'Internal server error',
            });
        }
    }

    if (url.pathname.startsWith('/personality/')) {
        return await handlePersonalityImage(req, url.pathname);
    }

    if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        (url.pathname === '/' || url.pathname === '/health' ||
            url.pathname === '/healthz')
    ) {
        return healthResponse(req.method);
    }

    return jsonResponse(404, {
        ok: false,
        error: 'Not found. Use /health for HTTP checks or WebSocket upgrade for realtime.',
    });
}

if (isDev) { // RUN WITH: deno run -A --env-file=.env main.ts
    const HOST = Deno.env.get('HOST') || '0.0.0.0';
    const PORT = Deno.env.get('PORT') || '8000';
    Deno.serve({ hostname: HOST, port: Number(PORT) }, (req) => {
        return handleRequest(req);
    });
    console.log(`Audio capture server running on ws://${HOST}:${PORT}`);
} else {
    Deno.serve((req) => handleRequest(req));
}
