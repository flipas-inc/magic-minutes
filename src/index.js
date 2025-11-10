// CRITICAL: Initialize crypto library BEFORE importing @discordjs/voice
import './utils/init-crypto.js';

import { Client, GatewayIntentBits } from 'discord.js';
import { getVoiceConnections } from '@discordjs/voice';
import { config } from 'dotenv';
import { registerCommands } from './commands/register.js';
import { handleVoiceCommand } from './commands/voice.js';

config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

client.once('clientReady', async () => {
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
