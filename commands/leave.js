const { SlashCommandBuilder, ChannelType } = require('discord.js');
const { 
    joinVoiceChannel,
    getVoiceConnection, 
    VoiceConnection,
    VoiceConnectionStatus, 
    entersState
} = require('@discordjs/voice');
const result = require('dotenv').config()

const GUILD_ID = process.env.GUILD_ID

async function tryConnection(interaction) {
    return getVoiceConnection(interaction.guildId)
}


module.exports = {
    data: new SlashCommandBuilder()
    .setName('leave')
    .setDescription("The channel to leave"),
    async execute(interaction) {
        try {
            const connection = await tryConnection(interaction);
            connection.destroy()
            await interaction.reply("Successfully left the channel.")
        } catch (err) {
            interaction.reply("An error has occurred");
            console.log(err);
        }
        
    }
}