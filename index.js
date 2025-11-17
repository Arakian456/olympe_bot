// index.js - Bot Discord type Streamcord avec 2 rôles possibles pour /followlive

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');

// ------------ CLIENT DISCORD ------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ------------ FICHIER DE SUBSCRIPTIONS ------------
const SUBS_PATH = path.join(__dirname, 'subscriptions.json');
if (!fs.existsSync(SUBS_PATH)) {
  fs.writeFileSync(SUBS_PATH, JSON.stringify({ guilds: {} }, null, 2));
}
let subs = JSON.parse(fs.readFileSync(SUBS_PATH, 'utf8'));

function saveSubs() {
  fs.writeFileSync(SUBS_PATH, JSON.stringify(subs, null, 2), 'utf8');
}

// ------------ API TWITCH ------------
let twitchToken = null;
let twitchTokenExpires = 0;

async function getTwitchToken() {
  const now = Date.now();
  if (twitchToken && now < twitchTokenExpires) return twitchToken;

  const body = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    client_secret: process.env.TWITCH_CLIENT_SECRET,
    grant_type: 'client_credentials'
  });

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    body
  });

  if (!res.ok) {
    console.error('[TWITCH] Erreur token :', await res.text());
    throw new Error('Impossible de récupérer le token Twitch');
  }

  const data = await res.json();
  twitchToken = data.access_token;
  twitchTokenExpires = now + data.expires_in * 1000 - 60_000;
  return twitchToken;
}

async function getStream(twitchName) {
  const token = await getTwitchToken();

  const res = await fetch(
    `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(
      twitchName
    )}`,
    {
      headers: {
        'Client-ID': process.env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${token}`
      }
    }
  );

  if (!res.ok) {
    console.error('[TWITCH] Erreur API :', await res.text());
    throw new Error("Impossible d'appeler l'API Twitch");
  }

  const data = await res.json();
  return data.data && data.data.length > 0 ? data.data[0] : null;
}

// ------------ COMMANDES SLASH ------------
const commands = [
  new SlashCommandBuilder()
    .setName('followlive')
    .setDescription(
      'Suivre un streamer Twitch et annoncer quand il passe en live'
    )
    .addStringOption(o =>
      o
        .setName('twitch_name')
        .setDescription('Nom de la chaîne Twitch')
        .setRequired(true)
    )
    .addChannelOption(o =>
      o
        .setName('salon')
        .setDescription('Salon où envoyer les annonces')
        .setRequired(true)
    )
    .addRoleOption(o =>
      o
        .setName('role1')
        .setDescription('Premier rôle à ping')
        .setRequired(true)
    )
    .addRoleOption(o =>
      o
        .setName('role2')
        .setDescription('Deuxième rôle à ping (optionnel)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('unfollowlive')
    .setDescription('Arrêter de suivre un streamer Twitch')
    .addStringOption(o =>
      o
        .setName('twitch_name')
        .setDescription('Nom de la chaîne Twitch')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('listlive')
    .setDescription('Liste des streamers suivis sur ce serveur')
].map(c => c.toJSON());

async function deployCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('[BOT] Déploiement des commandes slash…');
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.DISCORD_CLIENT_ID,
        process.env.GUILD_ID
      ),
      { body: commands }
    );
    console.log('[BOT] Commandes déployées !');
  } catch (err) {
    console.error('[BOT] Erreur déploiement commandes :', err);
  }
}

// ------------ BOUCLE QUI SURVEILLE LES LIVES ------------
const CHECK_INTERVAL = 60_000; // 60s

async function checkLives() {
  for (const [guildId, guildSubs] of Object.entries(subs.guilds)) {
    for (const sub of guildSubs) {
      try {
        const stream = await getStream(sub.twitchName);

        if (!stream) {
          // offline : on reset l’ID de live pour pouvoir réannoncer le prochain
          if (sub.lastStreamId) {
            sub.lastStreamId = null;
            saveSubs();
          }
          continue;
        }

        if (sub.lastStreamId === stream.id) continue; // déjà annoncé

        sub.lastStreamId = stream.id;
        saveSubs();

        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) continue;

        const channel = await guild.channels
          .fetch(sub.channelId)
          .catch(() => null);
        if (!channel || !channel.isTextBased()) continue;

        // ----- Mentions des rôles -----
        let mentions = '';
        if (sub.roleId) mentions += `<@&${sub.roleId}>`;
        if (sub.roleId2) mentions += ` <@&${sub.roleId2}>`;

        const twitchUrl = `https://twitch.tv/${sub.twitchName}`;
        const thumb = stream.thumbnail_url
          .replace('{width}', '1280')
          .replace('{height}', '720');

        const embed = new EmbedBuilder()
          .setTitle(stream.title || `${sub.twitchName} est en live !`)
          .setColor(0x9146ff)
          .setURL(twitchUrl)
          .setDescription(
            `Le streamer **${sub.twitchName}** vient de commencer son live !`
          )
          .setImage(thumb)
          .addFields(
            {
              name: 'Jeu',
              value: stream.game_name || 'Non spécifié',
              inline: true
            },
            {
              name: 'Viewers',
              value: String(stream.viewer_count || 'N/A'),
              inline: true
            }
          )
          .setTimestamp(new Date(stream.started_at));

        const buttonRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel('Regarder le live')
            .setStyle(ButtonStyle.Link)
            .setURL(twitchUrl)
        );

        await channel.send({
          content: `${mentions} **${sub.twitchName}** est en live maintenant !`,
          embeds: [embed],
          components: [buttonRow]
        });
      } catch (err) {
        console.error(
          `[BOT] Erreur pendant le check de ${sub.twitchName} (guild ${guildId}) :`,
          err
        );
      }
    }
  }
}

// ------------ EVENTS DISCORD ------------
client.once('ready', () => {
  console.log(`[BOT] Connecté en tant que ${client.user.tag}`);
  deployCommands();
  setInterval(checkLives, CHECK_INTERVAL);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const guildId = interaction.guildId;
  if (!subs.guilds[guildId]) subs.guilds[guildId] = [];

  // ----- /followlive -----
  if (interaction.commandName === 'followlive') {
    const name = interaction.options.getString('twitch_name').toLowerCase();
    const channel = interaction.options.getChannel('salon');
    const role1 = interaction.options.getRole('role1');
    const role2 = interaction.options.getRole('role2');

    const exists = subs.guilds[guildId].find(
      s => s.twitchName === name && s.channelId === channel.id
    );
    if (exists) {
      return interaction.reply({
        content:
          'Ce streamer est déjà suivi dans ce salon. Utilise `/unfollowlive` puis refais `/followlive` pour changer les rôles.',
        ephemeral: true
      });
    }

    subs.guilds[guildId].push({
      twitchName: name,
      channelId: channel.id,
      roleId: role1.id,
      roleId2: role2 ? role2.id : null,
      lastStreamId: null
    });
    saveSubs();

    let rolesText = `<@&${role1.id}>`;
    if (role2) rolesText += `, <@&${role2.id}>`;

    return interaction.reply(
      `✅ Le streamer **${name}** sera annoncé dans ${channel} (rôles ping : ${rolesText}).`
    );
  }

  // ----- /unfollowlive -----
  if (interaction.commandName === 'unfollowlive') {
    const name = interaction.options.getString('twitch_name').toLowerCase();
    const before = subs.guilds[guildId].length;
    subs.guilds[guildId] = subs.guilds[guildId].filter(
      s => s.twitchName !== name
    );
    saveSubs();

    if (subs.guilds[guildId].length === before) {
      return interaction.reply(
        `❌ Aucun suivi trouvé pour **${name}** sur ce serveur.`
      );
    }

    return interaction.reply(`🗑️ Suivi supprimé pour **${name}**.`);
  }

  // ----- /listlive -----
  if (interaction.commandName === 'listlive') {
    const list = subs.guilds[guildId];
    if (!list || !list.length) {
      return interaction.reply('Aucun streamer suivi sur ce serveur.');
    }

    const msg = list
      .map(s => {
        let roles = `<@&${s.roleId}>`;
        if (s.roleId2) roles += `, <@&${s.roleId2}>`;
        return `• **${s.twitchName}** → <#${s.channelId}> (rôles : ${roles})`;
      })
      .join('\n');

    return interaction.reply(`📡 Streamers suivis :\n${msg}`);
  }
});

// ------------ LANCEMENT DU BOT ------------
client.login(process.env.DISCORD_TOKEN);
