/// <reference path="../types.d.ts" />
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
// Use the same SDK module as gemini.ts so the transport stub intercepts it.
// deno-lint-ignore no-unversioned-import
import { GoogleGenAI, type LiveConnectParameters } from 'npm:@google/genai';
import { FACE_TOOLS, type FaceSession } from '../faces.ts';

// Exercise the provider and the real SDK serializer without a live Gemini connection.
Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:54321');
Deno.env.set('SUPABASE_KEY', 'test-key');
Deno.env.set('GEMINI_API_KEY', 'test-key');
Deno.env.delete('SUPABASE_SERVICE_ROLE_KEY');
const { connectToGemini } = await import('./gemini.ts');

async function captureLiveMessages(conciergeMode: boolean, model?: string) {
    const previousModel = Deno.env.get('GEMINI_LIVE_MODEL');
    if (model === undefined) Deno.env.delete('GEMINI_LIVE_MODEL');
    else Deno.env.set('GEMINI_LIVE_MODEL', model);

    const livePrototype = Object.getPrototypeOf(new GoogleGenAI({ apiKey: 'test-key' }).live);
    const originalConnect = livePrototype.connect;
    const messages: Record<string, any>[] = [];
    let closed = false;
    // Replace only transport creation; the SDK still builds and serializes the
    // setup and greeting. Stop at the greeting before the receive loop starts.
    livePrototype.connect = async function (params: LiveConnectParameters) {
        const originalFactory = this.webSocketFactory;
        this.webSocketFactory = {
            create: (_url: string, _headers: unknown, callbacks: { onopen: () => void }) => ({
                connect: () => callbacks.onopen(),
                send: (data: string) => {
                    const message = JSON.parse(data);
                    messages.push(message);
                    if (message.clientContent) throw new Error('test transport finished');
                },
                close: () => {},
            }),
        };
        try {
            return await originalConnect.call(this, params);
        } finally {
            this.webSocketFactory = originalFactory;
        }
    };
    try {
        await connectToGemini({
            ws: {
                close: () => {
                    closed = true;
                },
            } as unknown as ClientWebSocket,
            payload: {
                user: {
                    user_id: 'test-account',
                    language_code: 'de',
                    language: { name: 'German' },
                    personality: { oai_voice: 'Kore' },
                } as IUser,
                supabase: {} as IPayload['supabase'],
                timestamp: '2026-09-20T12:00:00Z',
            },
            firstMessage: 'Greet the current speaker.',
            systemPrompt: 'The default language is German.',
            closeHandler: async () => {},
            opusFactory: () => ({
                push: () => {},
                flush: () => {},
                reset: () => {},
                close: () => {},
                bufferedBytes: () => 0,
            }),
            requestPhoto: () => Promise.resolve('test photo'),
            callDeviceTool: () => Promise.resolve('ok'),
            showImage: () => {},
            stylizePhoto: () => Promise.resolve('ok'),
            faces: {} as FaceSession,
            conciergeMode,
        });
        strictEqual(closed, true);
        strictEqual(messages.length, 2, 'setup and greeting must reach the SDK transport');
        return { setup: messages[0].setup, greeting: messages[1].clientContent };
    } finally {
        livePrototype.connect = originalConnect;
        if (previousModel === undefined) Deno.env.delete('GEMINI_LIVE_MODEL');
        else Deno.env.set('GEMINI_LIVE_MODEL', previousModel);
    }
}

Deno.test('Gemini 3.8 is the default for concierge and direct personalities', async () => {
    for (const concierge of [false, true]) {
        const { setup } = await captureLiveMessages(concierge);
        strictEqual(setup.model, 'models/gemini-3.8-live');
        strictEqual(setup.tools.some((tool: any) => 'googleSearch' in tool), concierge);
    }
});

Deno.test('Gemini Live setup preserves audio and makes identity and other tools blocking', async () => {
    const { setup } = await captureLiveMessages(true);
    deepStrictEqual(setup.generationConfig.responseModalities, ['AUDIO']);
    deepStrictEqual(setup.generationConfig.speechConfig, {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
    });
    ok(setup.systemInstruction.parts.some((part: any) => part.text.includes('German')));
    deepStrictEqual(setup.inputAudioTranscription, {});
    deepStrictEqual(setup.outputAudioTranscription, {});
    strictEqual('thinkingConfig' in setup.generationConfig, false);
    strictEqual('enableAffectiveDialog' in setup.generationConfig, false);
    strictEqual('proactivity' in setup, false);

    const declarations = setup.tools.flatMap((tool: any) => tool.functionDeclarations ?? []);
    for (
        const name of [...FACE_TOOLS.map((tool) => tool.name), 'take_photo', 'switch_personality']
    ) {
        ok(declarations.some((tool: any) => tool.name === name), `missing tool ${name}`);
    }
    for (const tool of declarations) strictEqual(tool.behavior, 'BLOCKING', tool.name);
});

Deno.test('Gemini Live honors explicit model overrides and ignores blank values', async () => {
    const overridden = await captureLiveMessages(true, ' gemini-3.1-flash-live-preview ');
    strictEqual(overridden.setup.model, 'models/gemini-3.1-flash-live-preview');
    const blank = await captureLiveMessages(false, '  ');
    strictEqual(blank.setup.model, 'models/gemini-3.8-live');
});

Deno.test('Gemini Live greeting completes the user turn to request a spoken response', async () => {
    const { greeting } = await captureLiveMessages(false);
    strictEqual(greeting.turnComplete, true);
    deepStrictEqual(greeting.turns, [{
        role: 'user',
        parts: [{ text: 'Greet the current speaker.' }],
    }]);
});
