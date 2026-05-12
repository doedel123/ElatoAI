/// <reference path="./types.d.ts" />

import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { WebSocketServer } from 'npm:ws@8.18.0';
import type {
    WebSocket as WSWebSocket,
    WebSocketServer as _WebSocketServer,
} from 'npm:@types/ws@8.5.14';
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

function sendJson(
    res: ServerResponse,
    status: number,
    payload: unknown,
) {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(JSON.stringify(payload));
}

async function getUserByMacAddress(macAddress: string): Promise<IUser | null> {
    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data, error } = await supabase.from('devices').select(
        '*, user:user_id(*)',
    ).eq('mac_address', macAddress).single();
    if (error) {
        throw new Error(error.message);
    }
    return data?.user as IUser | null;
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
    res: ServerResponse,
) {
    const macAddress = url.searchParams.get('macAddress');
    if (!macAddress) {
        sendJson(res, 400, { error: 'MAC address is required' });
        return;
    }

    const skipDeviceRegistration = Deno.env.get('SKIP_DEVICE_REGISTRATION') === 'True' ||
        Deno.env.get('NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION') === 'True';

    const user = skipDeviceRegistration
        ? await getDevUser()
        : await getUserByMacAddress(macAddress);
    if (!user) {
        sendJson(res, 400, { error: 'User not found' });
        return;
    }

    const token = await createSupabaseToken(user);
    sendJson(res, 200, { token });
}

const server = createServer(async (req, res) => {
    const url = new URL(
        req.url ?? '/',
        `http://${req.headers.host ?? 'localhost'}`,
    );

    if (url.pathname === '/api/generate_auth_token') {
        if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'Method not allowed' });
            return;
        }

        try {
            await handleGenerateAuthToken(url, res);
        } catch (error) {
            sendJson(res, 500, {
                error: error instanceof Error ? error.message : 'Internal server error',
            });
        }
        return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
        if (
            url.pathname === '/' || url.pathname === '/health' ||
            url.pathname === '/healthz'
        ) {
            const body = JSON.stringify({
                ok: true,
                service: 'elato-deno-realtime',
                websocket: true,
                timestamp: new Date().toISOString(),
            });
            res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
            });
            if (req.method !== 'HEAD') {
                res.end(body);
            } else {
                res.end();
            }
            return;
        }
    }

    res.writeHead(404, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(JSON.stringify({
        ok: false,
        error: 'Not found. Use /health for HTTP checks or WebSocket upgrade for realtime.',
    }));
});

const wss: _WebSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });

wss.on('headers', (headers, _req) => {
    // You should NOT see any "Sec-WebSocket-Extensions" here
    console.log('WS response headers :', headers);
});

wss.on('connection', async (ws: WSWebSocket, payload: IPayload) => {
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
});

server.on('upgrade', async (req, socket, head) => {
    console.log('foobar upgrade', req.headers);
    let user: IUser;
    let supabase: SupabaseClient;
    let authToken: string;
    try {
        const {
            authorization: authHeader,
            'x-wifi-rssi': rssi,
            'x-device-mac': deviceMac,
        } = req.headers;
        authToken = authHeader?.replace('Bearer ', '') ?? '';
        const wifiStrength = parseInt(rssi as string); // Convert to number

        // You can now use wifiStrength in your code
        console.log('WiFi RSSI:', wifiStrength); // Will log something like -50

        // Remove debug logging
        if (!authToken) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        supabase = getSupabaseClient(authToken as string);
        user = await authenticateUser(supabase, authToken as string);

        // allow any mac address for dev
        const expectedMac = user.device?.mac_address;
        if (!isDev && deviceMac && deviceMac !== expectedMac) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
    } catch (_e: any) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, {
            user,
            supabase,
            timestamp: new Date().toISOString(),
        });
    });
});

if (isDev) { // RUN WITH: deno run -A --env-file=.env main.ts
    const HOST = Deno.env.get('HOST') || '0.0.0.0';
    const PORT = Deno.env.get('PORT') || '8000';
    server.listen(Number(PORT), HOST, () => {
        console.log(`Audio capture server running on ws://${HOST}:${PORT}`);
    });
} else {
    server.listen(8080);
}
