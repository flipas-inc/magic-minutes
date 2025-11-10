import { Client, GatewayIntentBits } from 'discord.js';
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

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log('🔧 Registering commands...');
  await registerCommands();
  console.log('✅ Commands registered successfully!');
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    switch (commandName) {
      case 'record':
        await handleVoiceCommand(interaction);
        break;
      default:
        await interaction.reply('Unknown command!');
    }
  } catch (error) {
    console.error('Error handling command:', error);
    const reply = { content: 'There was an error executing this command!', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
