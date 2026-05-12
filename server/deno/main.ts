/// <reference path="./types.d.ts" />

import { Buffer } from 'node:buffer';
import * as jose from 'https://deno.land/x/jose@v5.9.6/index.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { authenticateUser } from './utils.ts';
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

async function createSupabaseToken(user: IUser): Promise<string> {
    const jwtSecretKey = Deno.env.get('JWT_SECRET_KEY');
    if (!jwtSecretKey) {
        throw new Error('JWT_SECRET_KEY not configured');
    }

    const payload = {
        email: user.email,
        user_id: user.user_id,
        created_time: new Date().toISOString(),
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

    const token = await createSupabaseToken(user);
    return jsonResponse(200, { token });
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

async function handleConnection(ws: ClientWebSocketAdapter, payload: IPayload) {
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

    const provider = user.personality?.provider;

    // send user details to client
    // when DEV_MODE is true, we send the default values 100, false, false
    ws.send(
        JSON.stringify({
            type: 'auth',
            volume_control: user.device?.volume ?? 50,
            is_ota: user.device?.is_ota ?? false,
            is_reset: user.device?.is_reset ?? false,
            pitch_factor: user.personality?.pitch_factor ?? 1,
        }),
    );

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

async function handleRequest(req: Request) {
    const url = new URL(req.url);

    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        return await handleWebSocket(req);
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
