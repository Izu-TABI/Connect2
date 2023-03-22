'use strict'

const fetch = require('node-fetch');
const https = require('https');
const result = require('dotenv').config()
const http = require('http');
const fs = require('fs')
const { join } = require('path');
const path = require('path');
const Discord = require('discord.js');
const { createReadStream } = require('fs')

const {
  Client,
  Collection, 
  Events, 
  GatewayIntentBits,
  IntentsBitField, 
  ActivityType, 
  Partials,
} = require('discord.js');
const { 
  getVoiceConnection, 
  createAudioPlayer, 
  createAudioResource, 
} = require('@discordjs/voice');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.GuildMembers,
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.GuildVoiceStates,
  ],
  'partials': [Partials.Channel]
});

const TOKEN = process.env.TOKEN
const GUILD_ID = process.env.GUILD_ID


client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);
  
  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
  } else {
    console.log(`[WARNING] The command at ${filePath} is missing a requred "data" or "execute" propaty.`); 
  }
  
}

http.createServer(function(req, res) {
  res.write("online");
  res.end();
}).listen(8080);

client.once('ready', async () => {
  client.user.setStatus('online')
  console.log('Ready!');
});



client.on('ready', () => {
  client.user.setPresence({
    activities: [{ name: `logの管理`, type: 	ActivityType.Playing}],
  });
});

client.on("messageCreate", (message)=> {
  if (message.content === '!ping') {
    message.reply('hello');
  }
})




// -------------------------------commands -------------------------------
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  
  const command = interaction.client.commands.get(interaction.commandName);

  if (!command) {
    console.error(`No command matching ${interaction.comanndName} was found`);
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(err);
    await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
  }

})


// -------------------------------------------------------------------------

async function callApi(contents) {
  try {
      const res = await fetch("https://api.tts.quest/v1/voicevox/?text="+contents+"&speaker=2");
      const res_json = await res.json();
      const url = await res_json.mp3DownloadUrl;
      return url;
  } catch (err) {
    console.log(err);
  }

}


function downloadAudio(voiceUrl2) { //リンク先からmp3ファイルをダウンロードしてくる
  try {
    return new Promise((resolve, reject) => {
      https.get(voiceUrl2, (res) => {
        const datatest = [];

        res.on('data', function (chunk) {
          datatest.push(chunk);
        });

        res.on('end', (res) => {
          let dest = "audio.mp3";
          let stream = fs.createWriteStream(dest);
          let buffer = Buffer.concat(datatest);
          stream.write(buffer);
          stream.end();
        });

      });
    });
  } catch (err) {
    console.log(err);
  }
}

// mp3ファイルを再生
  
function playAudio() {
  const connection = getVoiceConnection(GUILD_ID);
  const player = createAudioPlayer();
  const resource = createAudioResource(createReadStream(join(__dirname, './audio.mp3')), {
   inlineVolume : true 
  })
  resource.volume = 2;
  player.play(resource);
  connection.subscribe(player);
  player.on('error', (e) =>  {
    console.error('エラー', e);
  });
}

function audioPlayMain(contents, joinUser) {
  new Promise((resolve, reject) => {
    resolve(callApi(contents));
  }).then((url) => {
    downloadAudio(url, joinUser);
  }).then(() => {
    setTimeout(() => {
      playAudio();
    }, intervalTime);
  })
}

//APIを連続で叩かないようにする
let timer = 0;

setInterval(() => {
  timer++;
}, 1000)  
const intervalTime = 1000;


//log
client.on("voiceStateUpdate", async (oldState, newState) => {
  const oldVoice = oldState.channelId;
  const newVoice = newState.channelId;


  const joinUser = oldState.member.user.username; //チャンネルに入ったユーザーの名前を取得
  const connection = getVoiceConnection(GUILD_ID);


  if (oldVoice != newVoice) {
    if (oldVoice == null) { 
      if (connection && oldState.member.user.bot === true && timer > 5) {//botの場合
        timer = 0;
        const contents = '私はログツーです。音声で入退出状況をお伝えします。';
        new Promise((resolve, reject) => {
          resolve(callApi(contents));
        }).then((url) => {
          downloadAudio(url, joinUser);
        }).then(() => {
          setTimeout(() => {
            playAudio();
          }, intervalTime);
        })
      } else if (connection && timer > 4) {

        timer = 0;
        const contents = joinUser+"さんが入室しました。"
        audioPlayMain(contents, joinUser);
      }
      
      
      const voiceChannel = client.guilds.cache.get(GUILD_ID).channels.cache.get(newVoice);
      const membersInChannel = voiceChannel.members.size;
      const activeUser = oldState.member.user;
      
      
    } else if (newVoice == null) {
        if (connection && timer > 4) {
          timer = 0
          if (oldState.member.user.bot != true) {
            const contents = joinUser+"さんが退出しました。";
            audioPlayMain(contents, joinUser);
          }
      }
      
    } else {
      if (connection && timer > 4) {
          const oldVoiceChannel = oldState.guild.channels.cache.get(oldVoice).name;
          const newVoiceChannel = newState.guild.channels.cache.get(newVoice).name;

        timer = 0;
        const contents = joinUser+"が"+oldVoiceChannel+"から"+newVoiceChannel+"へ移動しました。";
        audioPlayMain(contents, joinUser);
      }
    }
  }

});



client.login(TOKEN);
