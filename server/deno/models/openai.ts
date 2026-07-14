import { Buffer } from "node:buffer";
import type { RawData } from "npm:@types/ws";
import { RealtimeClient } from "../realtime/client.js";
import { RealtimeUtils } from "../realtime/utils.js";
import { addConversation, getDeviceInfo } from "../supabase.ts";
import { createOpusPacketizer, extractSentences, isDev, openaiApiKey, defaultOpenAIVoice } from "../utils.ts";
import { XIAOZHI_DEVICE_TOOLS } from "../device_tools.ts";
import { classifyEmotion, heuristicEmotion } from "../emotion.ts";

const sendFirstMessage = (client: RealtimeClient, firstMessage: string) => {
    const event = {
        event_id: RealtimeUtils.generateId("evt_"), // Generate unique ID
        type: "conversation.item.create",
        previous_item_id: "root",
        item: {
            type: "message",
            role: "system",
            content: [{
                type: "input_text",
                text: firstMessage,
            }],
        },
    };

    client.realtime.send(event.type, event);
    client.realtime.send("response.create", {
        event_id: RealtimeUtils.generateId("evt_"), // Generate unique ID
        type: "response.create",
    });
};

export const connectToOpenAI = async ({
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
}: ProviderArgs) => {
    const { user, supabase } = payload;

    const opus = (opusFactory ?? createOpusPacketizer)((packet) => ws.send(packet));

    let currentItemId: string | null = null;
    let currentCallId: string | null = null;

    // Screen-text events for XIAOZHI devices (no-op for ELATO). The adapter
    // turns these into stt / tts:sentence_start / llm messages.
    let assistantTranscript = "";
    const emitStt = (text: string) => {
        if (emitTextEvents && text) {
            ws.send(JSON.stringify({ type: "server", msg: "STT", text }));
        }
    };
    const emitSentence = (text: string) => {
        if (emitTextEvents && text.trim()) {
            ws.send(JSON.stringify({ type: "server", msg: "TTS_SENTENCE", text: text.trim() }));
        }
    };
    const emitEmotion = (emotion: string) => {
        if (emitTextEvents) {
            ws.send(JSON.stringify({ type: "server", msg: "EMOTION", emotion }));
        }
    };
    // Hybrid emotion: instant language-agnostic heuristic, then refine with the
    // multilingual classifier. Fired once per assistant response.
    let emotionSent = false;
    const triggerEmotion = (text: string) => {
        if (!emitTextEvents || emotionSent || !text.trim()) return;
        emotionSent = true;
        const guess = heuristicEmotion(text);
        if (guess) emitEmotion(guess);
        classifyEmotion(text).then((e) => emitEmotion(e)).catch(() => {});
    };

    // Instantiate new client
    console.log(`Connecting with key "${openaiApiKey?.slice(0, 3)}..."`);
    const client = new RealtimeClient({ apiKey: openaiApiKey });

    // ADD TOOL CALLS HERE
    client.addTool(
        {
            type: "function",
            name: "end_session",
            description:
                'Call this if the user says bye or needs to leave or suggests they want to end the session. (e.g. "I gotta to go", "I have to work", "I have to sleep", "I have to do something else")',
            parameters: {
                type: "object",
                strict: true,
                properties: {
                    reason: {
                        type: "string",
                        description: "Short reason for ending the session.",
                    },
                },
                required: ["reason"],
            },
        },
        (args: any) => {
            console.log("end session", args);

            // Send your custom message to the client
            ws.send(JSON.stringify({ type: "server", msg: "SESSION.END" }));

            // Return the result for the callback
            return { success: true, message: `Session ended: ${args.reason}` };
        },
    );

    console.log(
        `OpenAI tools: take_photo=${!!requestPhoto} device_tools=${!!callDeviceTool}`,
    );

    // Camera (XIAOZHI devices only): the model can take a photo and get a
    // description from a vision model — independent of this audio session.
    if (requestPhoto) {
        client.addTool(
            {
                type: "function",
                name: "take_photo",
                description:
                    "Take a photo with the device's camera and get a description of what is currently visible. Use this whenever the user asks what you can see, to look at something, or to identify/read something in front of the device.",
                parameters: {
                    type: "object",
                    strict: true,
                    properties: {
                        question: {
                            type: "string",
                            description: "What to look for or answer about the scene.",
                        },
                    },
                    required: ["question"],
                },
            },
            async (args: any) => {
                try {
                    const description = await requestPhoto(args.question ?? "What do you see?");
                    return { success: true, description };
                } catch (e: unknown) {
                    return { success: false, error: (e as Error).message };
                }
            },
        );
    }

    // Device-control tools (XIAOZHI only): volume, brightness, theme, status.
    if (callDeviceTool) {
        for (const spec of XIAOZHI_DEVICE_TOOLS) {
            const properties: Record<string, any> = {};
            for (const p of spec.params) {
                properties[p.name] = {
                    type: p.type,
                    description: p.description,
                    ...(p.minimum != null ? { minimum: p.minimum } : {}),
                    ...(p.maximum != null ? { maximum: p.maximum } : {}),
                };
            }
            client.addTool(
                {
                    type: "function",
                    name: spec.name,
                    description: spec.description,
                    parameters: {
                        type: "object",
                        strict: true,
                        properties,
                        required: spec.params.map((p) => p.name),
                    },
                },
                async (args: any) => {
                    try {
                        const result = await callDeviceTool(spec.mcpName, args ?? {});
                        return { success: true, result };
                    } catch (e: unknown) {
                        return { success: false, error: (e as Error).message };
                    }
                },
            );
        }
    }

    // Screen image (XIAOZHI with a screen): generate + display a picture. The
    // handler returns instantly; generation/push happens in the background.
    if (showImage) {
        client.addTool(
            {
                type: "function",
                name: "show_image",
                description:
                    "Generate and display a picture on the device's screen. Use when the user asks to see or show something, or to illustrate the current scene while telling a story. The image takes a few seconds to appear; keep talking meanwhile.",
                parameters: {
                    type: "object",
                    strict: true,
                    properties: {
                        description: {
                            type: "string",
                            description: "A vivid, concrete visual description of the scene to draw.",
                        },
                    },
                    required: ["description"],
                },
            },
            (args: any) => {
                showImage(args.description ?? "");
                return { success: true, message: "The picture is being drawn and will appear shortly. Continue naturally." };
            },
        );
    }

    // Photo restyling (XIAOZHI with camera + screen): take a photo and turn it
    // into a new AI-generated picture in the requested style.
    if (stylizePhoto) {
        client.addTool(
            {
                type: "function",
                name: "stylize_photo",
                description:
                    "Take a photo with the device's camera and transform it into a new AI-generated picture in a given artistic style (e.g. cartoon, watercolor, pixel art), shown on the device's screen. Use when the user asks to take a photo AND redraw or restyle it. The result takes a few seconds; keep talking meanwhile.",
                parameters: {
                    type: "object",
                    strict: true,
                    properties: {
                        style: {
                            type: "string",
                            description: "The artistic style or transformation to apply, e.g. 'cartoon style'.",
                        },
                    },
                    required: ["style"],
                },
            },
            async (args: any) => {
                try {
                    const message = await stylizePhoto(args.style ?? "cartoon style");
                    return { success: true, message };
                } catch (e: unknown) {
                    return { success: false, error: (e as Error).message };
                }
            },
        );
    }

    // Relay: OpenAI Realtime API Event -> Browser Event
    client.realtime.on("server.*", async (event: any) => {
        // Check if the event is session.created
        if (event.type === "session.created") {
            console.log("session created", event);
            sendFirstMessage(client, firstMessage);
        } else if (event.type === "session.updated") {
            console.log("session updated", event);
        } else if (event.type === "error") {
            console.log("error", event);
        } else if (event.type === "response.done") {
            console.log("response.done", event);
            const hasNoAudio = event.response?.usage?.output_token_details?.audio_tokens === 0;
            opus.flush(true);
            if (!hasNoAudio) {
                ws.send(
                    JSON.stringify({
                        type: "server",
                        msg: "RESPONSE.COMPLETE",
                    }),
                );
            }
        } else if (event.type === "response.audio_transcript.delta" || event.type === "response.output_audio_transcript.delta") {
            // Stream assistant subtitles to the device, one sentence at a time.
            if (emitTextEvents && typeof event.delta === "string") {
                assistantTranscript += event.delta;
                const { sentences, rest } = extractSentences(assistantTranscript);
                assistantTranscript = rest;
                for (const sentence of sentences) emitSentence(sentence);
                if (sentences.length) triggerEmotion(sentences[0]);
            }
        } else if (event.type === "response.audio_transcript.done" || event.type === "response.output_audio_transcript.done") {
            console.log(`${event.type}`, event);
            // Flush any trailing words that never hit a sentence boundary.
            emitSentence(assistantTranscript);
            // Short replies without a sentence break still get an emotion.
            triggerEmotion(event.transcript ?? assistantTranscript);
            assistantTranscript = "";
            await addConversation(
                supabase,
                "assistant",
                event.transcript,
                user,
            );
        } else if (event.type === "input_audio_buffer.committed") {
            ws.send(JSON.stringify({ type: "server", msg: "AUDIO.COMMITTED" }));
        }

        if (event.type in client.conversation.EventProcessors) {
            try {
                switch (event.type) {
                    case "response.created":
                        console.log("response.created", event);
                        opus.reset();
                        assistantTranscript = "";
                        emotionSent = false;
                        try {
                            const device = await getDeviceInfo(supabase, user.user_id);

                            if (device) {
                                // Send the updated volume data along with the response complete message
                                ws.send(JSON.stringify({
                                    type: "server",
                                    msg: "RESPONSE.CREATED",
                                    volume_control: device.volume ?? 100,
                                }));
                            } else {
                                // Fall back to just sending the complete message if there's an error
                                ws.send(
                                    JSON.stringify({
                                        type: "server",
                                        msg: "RESPONSE.CREATED",
                                    }),
                                );
                            }
                        } catch (error) {
                            console.error("Error fetching updated device info:", error);
                            ws.send(
                                JSON.stringify({
                                    type: "server",
                                    msg: "RESPONSE.CREATED",
                                }),
                            );
                        }
                        break;
                    case "response.output_item.added":
                        console.log("response.output_item.added", event);
                        if (event.item.id) {
                            console.log("foobar", event.item.id);
                            currentItemId = event.item.id;
                            currentCallId = event.item.call_id;
                        }
                        break;
                    case "response.audio.delta":
                    case "response.output_audio.delta":
                        {
                            const { delta } = client.conversation.processEvent(
                                event,
                            );
                            try {
                                if (delta?.audio?.buffer) {
                                    const pcmBuffer = Buffer.from(
                                        delta.audio.buffer,
                                    );
                                    opus.push(pcmBuffer);
                                }
                            } catch (audioError) {
                                console.error(
                                    "Error processing audio delta:",
                                    audioError,
                                );
                                // Don't send any audio data if there's an error at this level
                            }
                        }
                        break;
                    case "conversation.item.created":
                        console.log("user said: ", event.item);
                        break;
                    case "conversation.item.input_audio_transcription.completed":
                        console.log("user transcription:", event);
                        emitStt(event.transcript);
                        await addConversation(
                            supabase,
                            "user",
                            event.transcript,
                            user,
                        );
                        break;
                }
            } catch (error) {
                console.error("Error processing event:", error);
                console.error("Event that caused the error:", event);
                ws.send(
                    JSON.stringify({ type: "server", msg: "RESPONSE.ERROR" }),
                );
            }
        }
    });

    client.realtime.on("close", () => ws.close());

    // Relay: Browser Event -> OpenAI Realtime API Event
    // We need to queue data waiting for the OpenAI connection
    const messageQueue: Array<{ data: RawData; isBinary: boolean }> = [];

    const messageHandler = async (data: any, isBinary: boolean) => {
        try {
            let event;

            // for esp32
            if (isBinary) {
                const base64Data = data.toString("base64");

                // Convert binary PCM16 data to base64 for OpenAI Realtime API
                event = {
                    event_id: RealtimeUtils.generateId("evt_"), // Generate unique ID
                    type: "input_audio_buffer.append",
                    audio: base64Data,
                };
                // Write the raw PCM data to file for debugging if enabled.
                // Also write the base64 data to a separate file
                if (isDev) {
                    if (connectionPcmFile) {
                        await connectionPcmFile.write(data);
                    }
                }
                client.realtime.send(event.type, event);
            } else { // Manual VAD
                const message = JSON.parse(data.toString("utf-8"));

                // commit user audio and create response
                if (
                    message.type === "instruction" &&
                    message.msg === "end_of_speech"
                ) {
                    console.log("end_of_speech detected");

                    client.realtime.send("input_audio_buffer.commit", {
                        event_id: RealtimeUtils.generateId("evt_"), // Generate unique ID
                        type: "input_audio_buffer.commit",
                    });

                    client.realtime.send("response.create", {
                        event_id: RealtimeUtils.generateId("evt_"), // Generate unique ID
                        type: "response.create",
                    });

                    client.realtime.send("input_audio_buffer.clear", {
                        event_id: RealtimeUtils.generateId("evt_"), // Generate unique ID
                        type: "input_audio_buffer.clear",
                    });
                } else if (
                    message.type === "instruction" &&
                    message.msg === "INTERRUPT"
                ) {
                    console.log("interrupt detected", message);
                    const audioEndMs = message.audio_end_ms;

                    client.realtime.send("conversation.item.truncate", {
                        event_id: RealtimeUtils.generateId("evt_"), // Generate unique ID
                        type: "conversation.item.truncate",
                        item_id: currentItemId,
                        content_index: 0,
                        audio_end_ms: audioEndMs,
                    });

                    client.realtime.send("input_audio_buffer.clear", {
                        event_id: RealtimeUtils.generateId("evt_"), // Generate unique ID
                        type: "input_audio_buffer.clear",
                    });
                }
            }
        } catch (e: unknown) {
            console.error((e as Error).message);
            console.log(`Error parsing event from client: ${data}`);
        }
    };

    ws.on("message", (data: any, isBinary: boolean) => {
        if (!client.isConnected()) {
            // Keep the binary flag — audio queued before the OpenAI connection
            // completes must not be replayed as JSON (and vice versa).
            messageQueue.push({ data, isBinary });
        } else {
            messageHandler(data, isBinary);
        }
    });

    // Add error handler
    ws.on("error", (error: any) => {
        console.error("WebSocket error:", error);
        client.disconnect();
    });

    // Add more detailed close handling
    ws.on("close", async (code: number, reason: string) => {
        console.log(`WebSocket closed with code ${code}, reason: ${reason}`);
        await closeHandler();
        opus.close();
        client.disconnect();
        if (isDev) {
            if (connectionPcmFile) {
                connectionPcmFile.close();
                console.log(`Closed debug audio file.`);
            }
        }
    });

    // Connect to the OpenAI Realtime API
    try {
        console.log(`Connecting to OpenAI...`);
        const sessionOptions = {
            model: "gpt-realtime-2",
            turn_detection: {
                type: "server_vad",
                threshold: 0.4,
                prefix_padding_ms: 400,
                silence_duration_ms: 1000,
            },
            voice: user.personality?.oai_voice ?? defaultOpenAIVoice,
            instructions: showImage && user.personality?.is_story
                ? systemPrompt +
                    "\n\nYou can show pictures on the child's screen. Whenever you introduce or move to a new scene, call the show_image tool with a vivid visual description of that scene, then keep narrating."
                : systemPrompt,
            input_audio_transcription: { model: "whisper-1" },
        };
        await client.connect(sessionOptions as any);
    } catch (e: unknown) {
        console.log(`Error connecting to OpenAI: ${e as Error}`);
        ws.close();
        return;
    }
    console.log(`Connected to OpenAI successfully!`);
    while (messageQueue.length) {
        const queued = messageQueue.shift()!;
        messageHandler(queued.data, queued.isBinary);
    }
};
