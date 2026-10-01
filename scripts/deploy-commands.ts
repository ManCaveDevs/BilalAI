/**
 * Registers the slash commands with Discord. Run after changing any command definition.
 * With DEV_GUILD_ID set, commands go to that one server and appear instantly;
 * otherwise they are registered globally.
 */
import { REST, Routes } from 'discord.js';
import { commands } from '../src/commands/index.js';
import { loadEnv } from '../src/config/env.js';

const env = loadEnv();
const rest = new REST().setToken(env.DISCORD_TOKEN);
const body = commands.map((c) => c.data.toJSON());

const route = env.DEV_GUILD_ID
  ? Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DEV_GUILD_ID)
  : Routes.applicationCommands(env.DISCORD_CLIENT_ID);

await rest.put(route, { body });
console.log(`Registered ${body.length} commands ${env.DEV_GUILD_ID ? `in server ${env.DEV_GUILD_ID}` : 'globally'}.`);
