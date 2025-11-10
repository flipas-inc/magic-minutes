import { REST, Routes } from 'discord.js';
import { config } from 'dotenv';

config();

const commands = [
  {
    name: 'record',
    description: 'Start or stop recording voice chat',
    options: [
      {
        name: 'action',
        type: 3, // STRING type
        description: 'Action to perform',
        required: true,
        choices: [
          {
            name: 'start',
            value: 'start',
          },
          {
            name: 'stop',
            value: 'stop',
          },
        ],
      },
    ],
  },
];

export async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('Started refreshing application (/) commands.');

    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );

    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
}
