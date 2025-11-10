# Magic Minutes 🎙️✨

A powerful Discord bot that records voice chats, transcribes them using Google Gemini AI, and generates intelligent summaries using GPT. Never miss important details from your Discord voice conversations!

## Features

- 🎤 **Voice Recording**: Record Discord voice channel conversations with high quality
- 📝 **AI Transcription**: Automatic transcription using Google Gemini AI
- 📊 **Smart Summaries**: Generate concise summaries of conversations using GPT
- 👥 **Per-User Recording**: Separate audio streams for each participant
- 📁 **Easy Access**: Receive recordings, transcriptions, and summaries directly in Discord

## Prerequisites

Before you begin, ensure you have:

- [Node.js](https://nodejs.org/) v18 or higher
- A [Discord Bot Token](https://discord.com/developers/applications)
- An [OpenAI API Key](https://platform.openai.com/api-keys)

> **Note:** FFmpeg is included via the `ffmpeg-static` package, so no separate installation is needed!

## Setup

### 1. Clone the Repository

```bash
git clone https://github.com/edufatouFlipas/magic-minutes.git
cd magic-minutes
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Create a `.env` file in the root directory:

```bash
cp .env.example .env
```

Edit `.env` and add your credentials:

```env
DISCORD_TOKEN=your_discord_bot_token_here
CLIENT_ID=your_discord_client_id_here
GUILD_ID=your_discord_server_id_here
OPENAI_API_KEY=your_openai_api_key_here
```

### 4. Create Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give it a name
3. Go to the "Bot" section and click "Add Bot"
4. Copy the bot token and add it to your `.env` file
5. Enable these Privileged Gateway Intents:
   - `PRESENCE INTENT`
   - `SERVER MEMBERS INTENT`
   - `MESSAGE CONTENT INTENT`
6. Go to "OAuth2" → "URL Generator"
7. Select scopes: `bot` and `applications.commands`
8. Select bot permissions:
   - `Send Messages`
   - `Connect`
   - `Speak`
   - `Use Voice Activity`
   - `Read Message History`
9. Copy the generated URL and use it to invite the bot to your server

### 5. Get Your IDs

**Client ID:**
- Found in your Discord application's "General Information" page

**Guild ID (Server ID):**
1. Enable Developer Mode in Discord (User Settings → Advanced → Developer Mode)
2. Right-click your server icon and select "Copy ID"

## Usage

### Start the Bot

```bash
npm start
```

For development with auto-reload:

```bash
npm run dev
```

**⚠️ Important:** When using `npm run dev`, the bot will restart when files change. This will interrupt any active recordings. Use `npm start` for stable recording sessions.

### Bot Commands

The bot uses Discord slash commands:

#### `/record start`
Start recording the voice channel you're currently in.

```
/record start
```

#### `/record stop`
Stop the current recording and receive:
- Individual audio files for each participant
- Complete transcription of the conversation
- AI-generated summary with key points

```
/record stop
```

## Project Structure

```
magic-minutes/
├── src/
│   ├── commands/
│   │   ├── register.js      # Command registration
│   │   └── voice.js          # Voice recording logic
│   ├── services/
│   │   ├── transcription.js  # OpenAI Whisper integration
│   │   └── summarization.js  # OpenAI GPT summarization
│   └── index.js              # Main bot entry point
├── recordings/               # Stored audio files (gitignored)
├── .env                      # Environment variables (gitignored)
├── .env.example              # Environment template
├── package.json
└── README.md
```

## How It Works

1. **Recording**: When you use `/record start`, the bot joins your voice channel and begins capturing audio streams from each participant separately using Discord.js voice capabilities.

2. **Storage**: Audio is saved as `.ogg` files in the `recordings/` directory, organized by server ID.

3. **Transcription**: After stopping the recording, each audio file is sent to Google Gemini AI for transcription.

4. **Summarization**: The combined transcriptions are sent to GPT-4 to generate a concise summary highlighting key points and action items.

5. **Delivery**: The bot sends the audio files, transcriptions, and summary directly to the Discord channel.

## API Costs

This bot uses OpenAI APIs which have associated costs:

- **Whisper API**: ~$0.006 per minute of audio
- **GPT-4o-mini API**: ~$0.15 per 1M input tokens, ~$0.60 per 1M output tokens

Monitor your usage in the [OpenAI Dashboard](https://platform.openai.com/usage).

## Troubleshooting

### "No compatible encryption modes" error
**Fixed in v0.19.0+** - This error occurred in older versions of @discordjs/voice that didn't support Discord's newer AEAD encryption modes. The project now uses @discordjs/voice v0.19.0+ which supports:
- `aead_aes256_gcm_rtpsize` (via Node.js native crypto)
- `aead_xchacha20_poly1305_rtpsize` (via libsodium-wrappers)

If you still encounter this error, ensure you're using the correct versions:
```bash
npm install
```

### Bot doesn't join voice channel
- Ensure the bot has "Connect" and "Speak" permissions
- Check that you're in a voice channel when using the command

### Transcription fails
- Verify your OpenAI API key is correct
- Ensure you have sufficient API credits
- Check that audio files are being created in the `recordings/` folder

### No audio captured
- Make sure participants are speaking during the recording
- Check bot permissions in the voice channel

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License.

## Disclaimer

This bot records voice conversations. Always inform participants that they are being recorded and obtain necessary consent. Comply with local laws and Discord's Terms of Service.

## Support

For issues and questions, please open an issue on [GitHub](https://github.com/edufatouFlipas/magic-minutes/issues).
