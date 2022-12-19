const { REST, Routes } = require('discord.js')
const result = require('dotenv').config()
const fs = require('fs')

const TOKEN = process.env.TOKEN
const GUILD_ID = process.env.GUILD_ID
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID
const CALL_CHANNEL_ID = process.env.CALL_CHANNEL_ID
const CLIENT_ID = process.env.CLIENT_ID

const commands = [];

const commandFiles = fs.readdirSync('./commands').filter(files => files.endsWith('.js'));

for (const files of commandFiles) {
    const command = require(`./commands/${files}`);
    commands.push(command.data.toJSON());
}

const rest = new REST({version: '10' }).setToken(TOKEN);


(async () => {
    try {
        console.log(`Start refreshing ${commands.length} application (/) commands.`);

        const data = await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            {body: commands},
        );
        
        console.log(`Successfully reloaded ${data.length} application (/) commands.`);

    } catch (err) {
        console.error(err);
    }
})();