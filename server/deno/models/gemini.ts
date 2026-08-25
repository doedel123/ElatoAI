import { Buffer } from 'node:buffer';
import type { WebSocketServer as _WebSocketServer } from 'npm:@types/ws';
import {
    EndSensitivity,
    GoogleGenAI,
    LiveConnectConfig,
    LiveServerMessage,
    Modality,
    Session,
    Type,
} from 'npm:@google/genai';
import { createOpusPacketizer, defaultGeminiVoice, extractSentences, geminiApiKey, isDev } from '../utils.ts';
import { XIAOZHI_DEVICE_TOOL_BY_NAME, XIAOZHI_DEVICE_TOOLS } from '../device_tools.ts';
import { classifyEmotion, heuristicEmotion } from '../emotion.ts';
import { addConversation, createFirstMessage, createSystemPrompt, getChatHistory } from '../supabase.ts';
import { listPersonalities, resolvePersonality, setUserPersonality } from '../concierge.ts';
import { pushGreetingImage } from '../image_gen.ts';
import { loadMemoryContext, rememberFact, saveSessionTranscript, searchMemories } from '../memory.ts';
import type { TranscriptTurn } from '../memory.ts';

export const connectToGemini = async ({
    ws,
    payload,
    connectionPcmFile,
    firstMessage,
    systemPrompt,
    closeHandler,
    opusFactory,
    emitTextEvents,
    requestPhoto,
    callDeviceTool,
    showImage,
    stylizePhoto,
    capturePhoto,
    pushImage,
    conciergeMode,
}: ProviderArgs) => {
    const { user, supabase } = payload;
    const voiceName = user.personality?.oai_voice ?? defaultGeminiVoice;
    // Computed per session (not once at connect): after a concierge
    // personality switch the active personality changes, and the nudge must
    // follow it — otherwise story personas never learn they have a screen.
    const imageNudge = () => {
        if (!showImage) return '';
        if (payload.user.personality?.is_story) {
            return '\n\nYou can show pictures on the child\'s screen. Whenever you introduce or move to a new scene, call the show_image tool with a vivid visual description of that scene, then keep narrating.';
        }
        return '\n\nYou can show pictures on the device\'s screen: when the user asks to see something, call the show_image tool with a vivid visual description instead of only describing it in words.';
    };

    const opus = (opusFactory ?? createOpusPacketizer)((packet) => ws.send(packet));

    // Screen-text events for XIAOZHI devices (no-op for ELATO).
    const emitStt = (text: string) => {
        if (emitTextEvents && text) {
            ws.send(JSON.stringify({ type: 'server', msg: 'STT', text }));
        }
    };
    const emitSentences = (text: string) => {
        if (!emitTextEvents || !text.trim()) return;
        const { sentences, rest } = extractSentences(text);
        for (const sentence of sentences) {
            ws.send(JSON.stringify({ type: 'server', msg: 'TTS_SENTENCE', text: sentence }));
        }
        if (rest.trim()) {
            ws.send(JSON.stringify({ type: 'server', msg: 'TTS_SENTENCE', text: rest.trim() }));
        }
    };
    const emitEmotion = (emotion: string) => {
        if (emitTextEvents) {
            ws.send(JSON.stringify({ type: 'server', msg: 'EMOTION', emotion }));
        }
    };

    console.log(`Connecting with Gemini key "${geminiApiKey?.slice(0, 3)}..."`);

    // Initialize Google GenAI
    const ai = new GoogleGenAI({ apiKey: geminiApiKey });
    // Concierge needs google_search grounding, which requires gemini-3.1+.
    // A concierge connection keeps this model for the whole session, including
    // after a switch into a personality (only prompt and voice change there).
    const model = Deno.env.get('GEMINI_LIVE_MODEL') ??
        (conciergeMode ? 'gemini-3.1-flash-live-preview' : 'gemini-2.5-flash-native-audio-preview-09-2025');
    console.log(`Gemini Live model: ${model}${conciergeMode ? ' (concierge)' : ''}`);

    // Build the tool list: camera (take_photo) + curated device-control tools.
    const functionDeclarations: any[] = [];
    if (requestPhoto) {
        functionDeclarations.push({
            name: 'take_photo',
            description:
                "Take a photo with the device's camera and get a description of what is currently visible. Use whenever the user asks what you can see, to look at something, or to read/identify something in front of the device.",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    question: { type: Type.STRING, description: 'What to look for or answer about the scene.' },
                },
                required: ['question'],
            },
        });
    }
    if (callDeviceTool) {
        for (const spec of XIAOZHI_DEVICE_TOOLS) {
            const properties: Record<string, any> = {};
            for (const p of spec.params) {
                properties[p.name] = {
                    type: p.type === 'integer' ? Type.INTEGER : Type.STRING,
                    description: p.description,
                };
            }
            functionDeclarations.push({
                name: spec.name,
                description: spec.description,
                parameters: { type: Type.OBJECT, properties, required: spec.params.map((p) => p.name) },
            });
        }
    }
    if (showImage) {
        functionDeclarations.push({
            name: 'show_image',
            description:
                "Generate and display a picture on the device's screen. Use when the user asks to see or show something, or to illustrate the current scene while telling a story. The image takes a few seconds to appear; keep talking meanwhile.",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    description: { type: Type.STRING, description: 'A vivid, concrete visual description of the scene to draw.' },
                },
                required: ['description'],
            },
        });
    }
    if (stylizePhoto) {
        functionDeclarations.push({
            name: 'stylize_photo',
            description:
                "Take a photo with the device's camera and transform it into a new AI-generated picture in a given artistic style (e.g. cartoon, watercolor, pixel art), shown on the device's screen. Use when the user asks to take a photo AND redraw or restyle it. This tool takes the photo itself — never call take_photo in the same turn. The result takes a few seconds; keep talking meanwhile.",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    style: { type: Type.STRING, description: "The artistic style or transformation to apply, e.g. 'cartoon style'." },
                },
                required: ['style'],
            },
        });
    }
    // Switching and memory stay available inside the personalities too, so the
    // user can go back to James and the characters share the Memory Bank.
    if (conciergeMode) {
        functionDeclarations.push({
            name: 'list_personalities',
            description:
                'List the available characters/personalities the user can switch this device into. Read the titles and one-line descriptions aloud.',
            parameters: { type: Type.OBJECT, properties: {} },
        }, {
            name: 'switch_personality',
            description:
                'Switch this device into one of the available personalities. Announce the switch in one short sentence before calling this; the new character then takes over the conversation.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    name: { type: Type.STRING, description: 'The key or title of the personality, as the user said it.' },
                },
                required: ['name'],
            },
        }, {
            name: 'remember',
            description:
                'Store one important fact about the user in long-term memory (preferences, names, events). Use sparingly for things worth keeping across sessions.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    fact: { type: Type.STRING, description: 'The fact to remember, phrased as a complete sentence.' },
                },
                required: ['fact'],
            },
        }, {
            name: 'recall',
            description:
                'Search long-term memory for facts about the user that are not already in the memory block of your instructions.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    query: { type: Type.STRING, description: 'What to look for.' },
                },
                required: ['query'],
            },
        });
    }

    // Pin the session language (ASR + TTS). Without this the transcription
    // guesses per utterance and skews English ("Geist" -> "guys"), and the
    // mis-heard text then pollutes chat history and Memory Bank.
    const LANG_TO_BCP47: Record<string, string> = {
        de: 'de-DE', en: 'en-US', es: 'es-ES', fr: 'fr-FR', it: 'it-IT',
        pt: 'pt-BR', nl: 'nl-NL', pl: 'pl-PL', tr: 'tr-TR', ru: 'ru-RU',
        ja: 'ja-JP', ko: 'ko-KR', zh: 'cmn-CN', hi: 'hi-IN', ar: 'ar-XA',
    };
    const rawLang = (user.language_code ?? user.language?.code ?? '').trim();
    const sessionLanguage = rawLang.includes('-')
        ? rawLang
        : LANG_TO_BCP47[rawLang.toLowerCase()] ?? '';
    if (sessionLanguage) console.log(`Gemini Live language: ${sessionLanguage}`);
    else console.warn(`Gemini Live language: none resolvable (language_code=${JSON.stringify(rawLang)}) — ASR will guess`);

    // Web search is a concierge ability. Inside a character it also competes
    // with the picture tools — with grounding on, the model answers instead of
    // calling show_image. Set GEMINI_PERSONALITY_SEARCH=on to keep it anyway.
    const searchInPersonalities = Deno.env.get('GEMINI_PERSONALITY_SEARCH') === 'on';

    /**
     * `grounding` refers to the session being built, not the connection: model,
     * voice-independent tools and memory stay identical after a switch, only
     * google_search is dropped for the characters.
     */
    const buildConfig = (
        prompt: string,
        voice: string,
        opts: { grounding: boolean },
    ): LiveConnectConfig => {
        const tools: any[] = [];
        // google_search grounding (needs gemini-3.1+).
        if (opts.grounding) tools.push({ googleSearch: {} });
        if (functionDeclarations.length) tools.push({ functionDeclarations });
        return {
            responseModalities: [Modality.AUDIO],
            systemInstruction: prompt + imageNudge(),
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: {
                        voiceName: voice,
                    },
                },
                ...(sessionLanguage ? { languageCode: sessionLanguage } : {}),
            },
            realtimeInputConfig: {
                automaticActivityDetection: {
                    disabled: false, // Keep VAD enabled
                    endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
                    silenceDurationMs: 100,
                },
            },
            outputAudioTranscription: {},
            inputAudioTranscription: {},
            ...(tools.length ? { tools } : {}),
        };
    };
    const config: LiveConnectConfig = buildConfig(systemPrompt, voiceName, {
        grounding: conciergeMode === true,
    });

    // Session transcript for Memory Bank ingestion (concierge only).
    const transcript: TranscriptTurn[] = [];
    let lastMemorySaveLength = 0;
    const maybeSaveMemories = (force = false) => {
        if (!conciergeMode) return;
        if (!force && transcript.length - lastMemorySaveLength < 20) return;
        lastMemorySaveLength = transcript.length;
        void saveSessionTranscript(user.user_id, [...transcript]);
    };

    // Set by switch_personality; consumed after the tool response is sent so
    // the model's announcement audio is not cut off mid-word.
    let pendingSwitch: IPersonality | null = null;
    // Once the switch is decided, the outgoing agent keeps generating and starts
    // acting as the new character ("James introduces himself as Elsa"). Drop its
    // audio and subtitles from there on; the announcement is already queued.
    let outgoingSessionMuted = false;
    // Grace period so the queued announcement finishes before the new session's
    // first frame starts a fresh utterance (which flushes the pacer queue).
    const switchDelayMs = Number(Deno.env.get('CONCIERGE_SWITCH_DELAY_MS') ?? '1200');

    async function handleFunctionCall(fc: { id?: string; name?: string; args?: any }) {
        let response: Record<string, unknown>;
        console.log(`Gemini tool call: ${fc.name}`);
        const deviceTool = XIAOZHI_DEVICE_TOOL_BY_NAME[fc.name ?? ''];
        if (fc.name === 'take_photo' && capturePhoto) {
            // Multimodal path: push the raw JPEG straight into the Live session
            // so the model looks at the picture itself (no separate VLM).
            try {
                const jpeg = await capturePhoto();
                geminiSession?.sendRealtimeInput({
                    video: { data: Buffer.from(jpeg).toString('base64'), mimeType: 'image/jpeg' },
                });
                console.log(`Gemini: pushed camera JPEG into session (${jpeg.length}B)`);
                response = {
                    success: true,
                    result: 'The photo has been attached to the conversation. Look at it and answer directly.',
                };
            } catch (e: unknown) {
                response = { success: false, error: (e as Error).message };
            }
        } else if (fc.name === 'take_photo' && requestPhoto) {
            try {
                const description = await requestPhoto(fc.args?.question ?? 'What do you see?');
                response = { success: true, description };
            } catch (e: unknown) {
                response = { success: false, error: (e as Error).message };
            }
        } else if (fc.name === 'list_personalities' && conciergeMode) {
            try {
                const items = await listPersonalities(supabase, user.user_id);
                response = {
                    success: true,
                    personalities: items.map((p) => ({
                        title: p.title,
                        description: p.short_description || p.subtitle || '',
                    })),
                };
            } catch (e: unknown) {
                response = { success: false, error: (e as Error).message };
            }
        } else if (fc.name === 'switch_personality' && conciergeMode) {
            try {
                const target = await resolvePersonality(supabase, user.user_id, String(fc.args?.name ?? ''));
                if (!target) {
                    response = {
                        success: false,
                        error: 'No personality with that name. Call list_personalities and offer the available ones.',
                    };
                } else {
                    await setUserPersonality(supabase, user.user_id, target.personality_id);
                    pendingSwitch = target;
                    outgoingSessionMuted = true;
                    response = {
                        success: true,
                        result:
                            `Handing over to ${target.title} now. Say nothing further and do not speak as ${target.title} — ` +
                            `the character greets the user themselves.`,
                    };
                }
            } catch (e: unknown) {
                response = { success: false, error: (e as Error).message };
            }
        } else if (fc.name === 'remember' && conciergeMode) {
            void rememberFact(user.user_id, String(fc.args?.fact ?? ''));
            response = { success: true, result: 'Stored.' };
        } else if (fc.name === 'recall' && conciergeMode) {
            try {
                const facts = await searchMemories(user.user_id, String(fc.args?.query ?? ''));
                response = { success: true, facts };
            } catch (e: unknown) {
                response = { success: false, error: (e as Error).message };
            }
        } else if (deviceTool && callDeviceTool) {
            try {
                const result = await callDeviceTool(deviceTool.mcpName, fc.args ?? {});
                response = { success: true, result };
            } catch (e: unknown) {
                response = { success: false, error: (e as Error).message };
            }
        } else if (fc.name === 'show_image' && showImage) {
            showImage(fc.args?.description ?? '');
            response = { success: true, message: 'The picture is being drawn and will appear shortly.' };
        } else if (fc.name === 'stylize_photo' && stylizePhoto) {
            try {
                const message = await stylizePhoto(fc.args?.style ?? 'cartoon style');
                response = { success: true, message };
            } catch (e: unknown) {
                response = { success: false, error: (e as Error).message };
            }
        } else {
            response = { success: false, error: `unknown tool ${fc.name}` };
        }
        geminiSession?.sendToolResponse({
            functionResponses: [{ id: fc.id, name: fc.name, response }],
        });
        if (pendingSwitch) {
            const target = pendingSwitch;
            pendingSwitch = null;
            // Let the queued announcement play out, then swap.
            setTimeout(() => {
                restartWithPersonality(target).catch((e) => {
                    console.error('Personality switch failed:', e?.message ?? e);
                    outgoingSessionMuted = false;
                });
            }, switchDelayMs);
        }
    }

    // Response queue for handling Google's callback-based responses
    const responseQueue: LiveServerMessage[] = [];
    let geminiSession: Session | null = null;

    async function waitMessage(): Promise<any> {
        let done = false;
        let message: LiveServerMessage | undefined = undefined;
        while (!done) {
            message = responseQueue.shift();
            if (message) {
                done = true;
            } else {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        }
        return message;
    }

    function pushGeminiPcm(data: string) {
        const pcm = Buffer.from(data, 'base64');
        if (pcm.length === 0) return false;
        opus.push(pcm);
        return true;
    }

    async function processGeminiTurns() {
        try {
            console.log('Processing Gemini turns');
            while (geminiSession) {
                let turnDone = false;
                let utteranceStarted = false;
                let outputTranscriptionText = '';
                let inputTranscriptionText = '';
                let sentenceBuffer = '';
                let emotionSent = false;

                while (!turnDone) {
                    const message: any = await waitMessage();

                    // Stream PCM as it arrives (Gemini Live already chunks;
                    // waiting for generationComplete was the Xiaozhi delay).
                    if (
                        !outgoingSessionMuted && typeof message.data === 'string' &&
                        message.data.length > 0
                    ) {
                        if (!utteranceStarted) {
                            utteranceStarted = true;
                            opus.reset();
                            ws.send(JSON.stringify({
                                type: 'server',
                                msg: 'RESPONSE.CREATED',
                            }));
                        }
                        pushGeminiPcm(message.data);
                    }

                    if (message.toolCall?.functionCalls?.length) {
                        for (const fc of message.toolCall.functionCalls) {
                            await handleFunctionCall(fc);
                        }
                    }

                    const content = message.serverContent;
                    if (content) {
                        if (content.outputTranscription?.text && !outgoingSessionMuted) {
                            const delta = content.outputTranscription.text;
                            outputTranscriptionText += delta;
                            sentenceBuffer += delta;
                            const { sentences, rest } = extractSentences(sentenceBuffer);
                            sentenceBuffer = rest;
                            for (const sentence of sentences) {
                                if (emitTextEvents && sentence.trim()) {
                                    ws.send(JSON.stringify({
                                        type: 'server',
                                        msg: 'TTS_SENTENCE',
                                        text: sentence.trim(),
                                    }));
                                }
                            }
                            if (!emotionSent && outputTranscriptionText.trim()) {
                                emotionSent = true;
                                const guess = heuristicEmotion(outputTranscriptionText);
                                if (guess) emitEmotion(guess);
                                classifyEmotion(outputTranscriptionText)
                                    .then((e) => emitEmotion(e))
                                    .catch(() => {});
                            }
                        }
                        if (content.inputTranscription?.text) {
                            inputTranscriptionText += content.inputTranscription.text;
                        }
                        if (content.interrupted) {
                            opus.reset();
                            utteranceStarted = false;
                        }
                        if (content.generationComplete) {
                            if (utteranceStarted) {
                                opus.flush(true);
                            }
                            turnDone = true;
                        }
                    }
                }

                emitStt(inputTranscriptionText);
                if (sentenceBuffer.trim()) {
                    emitSentences(sentenceBuffer);
                }

                ws.send(JSON.stringify({
                    type: 'server',
                    msg: 'RESPONSE.COMPLETE',
                }));

                if (inputTranscriptionText.trim()) {
                    transcript.push({ role: 'user', content: inputTranscriptionText.trim() });
                }
                if (outputTranscriptionText.trim()) {
                    transcript.push({ role: 'assistant', content: outputTranscriptionText.trim() });
                }
                maybeSaveMemories();

                // Add user transcription to supabase
                await addConversation(
                    supabase,
                    'user',
                    inputTranscriptionText,
                    user,
                );

                // Add assistant transcription to supabase
                await addConversation(
                    supabase,
                    'assistant',
                    outputTranscriptionText,
                    user,
                );
            }
        } catch (error) {
            console.error('Error processing Gemini turns:', error);
        }
    }

    async function startSession(sessionConfig: LiveConnectConfig, greeting: string) {
        const session = await ai.live.connect({
            model: model,
            callbacks: {
                onopen: function () {
                    console.log('Gemini session opened');
                },
                onmessage: function (message: LiveServerMessage) {
                    responseQueue.push(message);
                },
                onerror: function (e: any) {
                    console.error('Gemini error:', e.message);
                    ws.send(
                        JSON.stringify({
                            type: 'server',
                            msg: 'RESPONSE.ERROR',
                        }),
                    );
                },
                onclose: function (e: any) {
                    console.log('Gemini session closed:', e.reason);
                },
            },
            config: sessionConfig,
        });
        const previous = geminiSession;
        geminiSession = session;
        try {
            previous?.close();
        } catch { /* already closed */ }
        // Send first message if available
        geminiSession?.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: greeting }] }],
        });
    }

    /**
     * In-place personality switch (concierge): persist happened in the tool
     * handler; here we rebuild prompt+voice for the chosen personality and
     * swap the Live session under the still-open device connection.
     */
    async function restartWithPersonality(target: IPersonality) {
        console.log(
            `Concierge: switching personality -> ${target.key} (is_story=${!!target.is_story}, show_image=${!!showImage})`,
        );
        maybeSaveMemories(true);
        payload.user.personality = target;
        // Greeting image for the new character (time-of-day scene, cached) —
        // generation runs while the new Live session is being set up.
        if (pushImage) pushGreetingImage(target, pushImage);
        const [chatHistory, memoryContext] = await Promise.all([
            getChatHistory(supabase, user.user_id, target.key ?? null, false),
            // The characters share the concierge's Memory Bank, so they know
            // what the user told James (and each other) earlier.
            loadMemoryContext(user.user_id),
        ]);
        const prompt = createSystemPrompt(chatHistory, payload) +
            (memoryContext ? `\n\n${memoryContext}` : '');
        const greeting = createFirstMessage(payload);
        const voice = target.oai_voice ?? defaultGeminiVoice;
        await startSession(
            buildConfig(prompt, voice, { grounding: searchInPersonalities }),
            greeting,
        );
        outgoingSessionMuted = false;
    }

    // Connect to Google Gemini Live
    try {
        await startSession(config, firstMessage);
        console.log('Connected to Gemini successfully!');
        processGeminiTurns();
    } catch (e: unknown) {
        console.log(`Error connecting to Gemini: ${e}`);
        ws.close();
        return;
    }

    ws.on('message', (data: any, isBinary: boolean) => {
        try {
            if (isBinary) {
                // Handle binary audio data from ESP32
                const base64Data = data.toString('base64');

                if (isDev && connectionPcmFile) {
                    connectionPcmFile.write(data);
                }

                // Send audio to Gemini
                geminiSession?.sendRealtimeInput({
                    audio: {
                        data: base64Data,
                        mimeType: 'audio/pcm;rate=16000',
                    },
                });
            }
        } catch (e: unknown) {
            console.error('Error handling message:', (e as Error).message);
        }
    });

    ws.on('error', (error: any) => {
        console.error('WebSocket error:', error);
        geminiSession?.close();
    });

    ws.on('close', async (code: number, reason: string) => {
        console.log(`WebSocket closed with code ${code}, reason: ${reason}`);
        maybeSaveMemories(true);
        await closeHandler();
        opus.close();
        geminiSession?.close();
        if (isDev && connectionPcmFile) {
            connectionPcmFile.close();
            console.log('Closed debug audio file.');
        }
    });
};
