const { SlashCommandBuilder, ChannelType } = require('discord.js');
const { 
    joinVoiceChannel,
    getVoiceConnection, 
    VoiceConnection,
    VoiceConnectionStatus, 
    entersState
} = require('@discordjs/voice');

module.exports = {
    data: new SlashCommandBuilder()
      .setName('join')
      .setDescription("The channel to join")
      .addChannelOption(option =>
		option.setName('channel')
			.setDescription('The channel to echo into')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildVoice)
      ),
    async execute(interaction) {
        if (interaction.commandName === 'join') {
        await interaction.reply('Successfully!!\n')
    try {
      const voiceChannel = await interaction.options.getChannel('channel')
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false,
      })
      connection.on(VoiceConnectionStatus.Ready, () => {
        console.log('The connection has entered the Ready state - ready to play audio!');
      })

    } catch (err) {
        await client.channels.cache.get(LOG_CHANNEL_ID).send("An error has occurred", err);
        console.error(err);
        connection.destroy();
    }
  }
    },
}
