// CRITICAL: Initialize crypto library BEFORE importing @discordjs/voice
import './utils/init-crypto.js';

import { Client, GatewayIntentBits } from 'discord.js';
import { getVoiceConnections } from '@discordjs/voice';
import http from 'http';
import { config } from 'dotenv';
import { registerCommands } from './commands/register.js';
import { handleVoiceCommand } from './commands/voice.js';

config();

// Minimal HTTP server for Render health checks (and other minimal probes).
// Render free web services expect the process to bind to $PORT. This server
// responds 200 on /health to indicate the process is alive. It is intentionally
// tiny and does not expose any sensitive information.
const port = process.env.PORT ? Number(process.env.PORT) : 3000;
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('OK');
  }
  // Return 404 for anything else to avoid exposing endpoints unintentionally
  res.statusCode = 404;
  res.end();
});

server.listen(port, () => {
  console.log(`🌐 Health server listening on port ${port}`);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  
  // Clean up any existing voice connections from previous sessions
  const connections = getVoiceConnections();
  if (connections && connections.size > 0) {
    console.log(`🧹 Cleaning up ${connections.size} stale voice connection(s)...`);
    connections.forEach(conn => conn.destroy());
  }
  
  console.log('🔧 Registering commands...');
  await registerCommands();
  console.log('✅ Commands registered successfully!');
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    // Always acknowledge quickly to avoid 10062 Unknown interaction
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }

    switch (commandName) {
      case 'record':
        await handleVoiceCommand(interaction);
        break;
      default:
        await interaction.editReply('Unknown command!');
    }
  } catch (error) {
    console.error('Error handling command:', error);
    const reply = { content: 'There was an error executing this command!' };
    // Prefer editReply since we defer at the top
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply(reply).catch(console.error);
    } else if (interaction.replied) {
      await interaction.followUp(reply).catch(console.error);
    } else {
      await interaction.reply({ ...reply, ephemeral: true }).catch(console.error);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
