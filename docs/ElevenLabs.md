## Setup

1. **Environment Variables**
   Add your ElevenLabs API key to your `.env` file:
   ```
   ELEVENLABS_API_KEY=your_elevenlabs_api_key_here
   ```

2. **Agent Configuration**
   - Create an agent in the Eleven Labs dashboard
   - Copy the agent ID
   - On the Elato UI, Click `+ Create new` and create an Eleven Labs character with a `title` and the `agentId` 

## How it Works

1. **Connection Flow**:
   - ESP32 connects to your Deno server via WebSocket
   - Server authenticates the user and gets their personality configuration
   - If provider is "elevenlabs", server requests a signed URL from Eleven Labs API
   - Server establishes WebSocket connection to Eleven Labs using the signed URL
   - Server acts as a relay between ESP32 and Eleven Labs

2. **Audio Processing**:
   - IMPORTANT: In your Eleven Labs Agent Settings > Voice > TTS Output Format > Set this to PCM 24kHz.
   - Currently the AI Agent must speak first. You can change this behaviour in `Audio.cpp`.
   - ESP32 sends PCM16 audio data (binary) to server (If you change this, you will also want to change your Eleven Labs Audio input settings)
   - Server converts to base64 and forwards to Eleven Labs
   - Eleven Labs sends back base64 audio data
   - Server converts to PCM16, encodes with Opus, and sends to ESP32

3. **Message Types**:
   - **From ElevenLabs**: `audio`, `user_transcript`, `agent_response`, `ping`, `conversation_end`
   - **To ElevenLabs**: `audio`, `pong`, `interrupt`
   - **To ESP32**: Various server messages like `RESPONSE.CREATED`, `RESPONSE.COMPLETE`

## Usage

Once configured, the Eleven Labs provider works exactly like OpenAI and Gemini. The server will automatically route to the Eleven Labs implementation when the provider is set to "elevenlabs".

## Differences from OpenAI/Gemini

- **No system prompts**: Eleven Labs agents are configured in their dashboard through your account (and api key via a signedUrl)
- **Agent-based**: More advanced with workflow handling and tool calling with MCP through the Eleven Labs dashboard

## Troubleshooting

1. **Connection Issues**: Ensure your Eleven Labs API key is valid and has access to Conversational AI
2. **Agent Not Found**: Verify the agent ID is correct and the agent exists in your Eleven Labs account
3. **Audio Issues**: Check that the AI is speaking first. And that TTS Output is 24kHz pcm not 16kHz pcm (which is default)
4. **Transcription Missing**: Ensure your Eleven Labs agent has transcription enabled in the dashboard