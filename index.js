// index.js - Bot Discord type Streamcord (Twitch) avec 2 rôles ping

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
  ButtonStyle,
  ChannelType
} = require('discord.js');

// ======================= CONFIG DE BASE =======================

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// Fichier local pour stocker les suivis
const SUBS_PATH = path.join(__dirname, 'subscriptions.json');

// Si le fichier n’existe pas, on le crée
if (!fs.existsSync(SUBS_PATH)) {
  fs.writeFileSync(
    SUBS_PATH,
    JSON.stringify({ guilds: {} }, null, 2),
    'utf8'
  );
}

let subs = JSON.parse(fs.readFileSync(SUBS_PATH, 'utf8'));

function saveSubs() {
  fs.writeFileSync(SUBS_PATH, JSON.stringify(subs, null, 2), 'utf8');
}

// ======================= API TWITCH ==========================

let twitchToken = null;
let twitchTokenExpires = 0;

async function getTwitchToken() {
  const now = Date.now();
  if (twitchToken && now < twitchTokenExpires) return twitchToken;

  const body = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    client_secret: process.env.TWITCH_CLIENT_SECRET,
    grant_type: 'client_credentials',
  });

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    body,
  });

  if (!res.ok) {
    console.error('Erreur pour récupérer le token Twitch:', await res.text());
    throw new Error('TWITCH_TOKEN_ERROR');
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
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (!res.ok) {
    console.error('Erreur API Twitch:', await res.text());
    throw new Error('TWITCH_API_ERROR');
  }

  const data = await res.json();
  return data.data && data.data.length > 0 ? data.data[0] : null;
}

// ======================= COMMANDES SLASH =====================

const commands = [
  // /followlive
  new SlashCommandBuilder()
    .setName('followlive')
    .setDescription('Suivre un streamer Twitch et annoncer quand il passe en live')
    .addStringOption((o) =>
      o
        .setName('twitch_name')
        .setDescription('Nom de la chaîne Twitch')
        .setRequired(true)
    )
    .addChannelOption((o) =>
      o
        .setName('salon')
        .setDescription('Salon où envoyer les annonces')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .addRoleOption((o) =>
      o
        .setName('role1')
        .setDescription('Premier rôle à ping')
        .setRequired(true)
    )
    .addRoleOption((o) =>
      o
        .setName('role2')
        .setDescription('Deuxième rôle à ping (optionnel)')
        .setRequired(false)
    ),

  // /unfollowlive
  new SlashCommandBuilder()
    .setName('unfollowlive')
    .setDescription('Arrêter de suivre un streamer Twitch')
    .addStringOption((o) =>
      o
        .setName('twitch_name')
        .setDescription('Nom de la chaîne Twitch')
        .setRequired(true)
    ),

  // /listlive
  new SlashCommandBuilder()
    .setName('listlive')
    .setDescription('Liste les streamers suivis sur ce serveur'),
].map((c) => c.toJSON());

async function deployCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('Déploiement des commandes slash…');
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.DISCORD_CLIENT_ID,
        process.env.GUILD_ID
      ),
      { body: commands }
    );
    console.log('Commandes déployées !');
  } catch (err) {
    console.error('Erreur déploiement commandes:', err);
  }
}

// ======================= BOUCLE DE SURVEILLANCE ==============

const CHECK_INTERVAL = 60_000; // 60 secondes

async function checkLives() {
  for (const [guildId, guildSubs] of Object.entries(subs.guilds)) {
    for (const sub of guildSubs) {
      try {
        const stream = await getStream(sub.twitchName);

        // Si offline → on reset le lastStreamId
        if (!stream) {
          if (sub.lastStreamId) {
            sub.lastStreamId = null;
            saveSubs();
          }
          continue;
        }

        // Si c'est le même live que celui déjà annoncé, on ignore
        if (sub.lastStreamId === stream.id) continue;

        // Nouveau live détecté
        sub.lastStreamId = stream.id;
        saveSubs();

        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) continue;

        const channel = await guild.channels.fetch(sub.channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) continue;

        const twitchUrl = `https://twitch.tv/${sub.twitchName}`;
        const thumb = stream.thumbnail_url
          .replace('{width}', '1280')
          .replace('{height}', '720');

        const embed = new EmbedBuilder()
          .setTitle(stream.title || `${sub.twitchName} est en live !`)
          .setColor(0x9146ff)
          .setURL(twitchUrl)
          .setDescription(
            `Le streamer **${sub.twitchName}** vient de lancer un live !`
          )
          .setImage(thumb)
          .addFields(
            {
              name: 'Jeu',
              value: stream.game_name || 'Non spécifié',
              inline: true,
            },
            {
              name: 'Viewers',
              value: String(stream.viewer_count || 'N/A'),
              inline: true,
            }
          )
          .setTimestamp(new Date(stream.started_at));

        const buttonRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel('Regarder le live')
            .setStyle(ButtonStyle.Link)
            .setURL(twitchUrl)
        );

        // Gestion des rôles (1 ou 2)
        const roleIds = sub.roleIds || [];
        const roleMentions = roleIds.map((id) => `<@&${id}>`).join(' ');

        await channel.send({
          content: `${roleMentions} **${sub.twitchName}** est en live !`,
          embeds: [embed],
          components: [buttonRow],
        });
      } catch (err) {
        console.error(`Erreur check live pour ${sub.twitchName}:`, err);
      }
    }
  }
}

// ======================= EVENTS DISCORD =======================

client.once('ready', () => {
  console.log(`Connecté en tant que ${client.user.tag}`);
  deployCommands();
  setInterval(checkLives, CHECK_INTERVAL);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const guildId = interaction.guildId;
  if (!subs.guilds[guildId]) {
    subs.guilds[guildId] = [];
  }

  // ========== /followlive ==========
  if (interaction.commandName === 'followlive') {
    const twitchName = interaction.options
      .getString('twitch_name')
      .toLowerCase();
    const channel = interaction.options.getChannel('salon');
    const role1 = interaction.options.getRole('role1');
    const role2 = interaction.options.getRole('role2');

    const roleIds = [role1.id];
    if (role2) roleIds.push(role2.id);

    const exists = subs.guilds[guildId].find(
      (s) => s.twitchName === twitchName && s.channelId === channel.id
    );
    if (exists) {
      await interaction.reply({
        content:
          'Ce streamer est déjà suivi dans ce salon. Tu peux le supprimer avec `/unfollowlive`.',
        ephemeral: true,
      });
      return;
    }

    subs.guilds[guildId].push({
      twitchName,
      channelId: channel.id,
      roleIds,
      lastStreamId: null,
    });
    saveSubs();

    const rolesText = roleIds.map((id) => `<@&${id}>`).join(' ');
    await interaction.reply(
      `✅ Le streamer **${twitchName}** sera annoncé dans ${channel} avec les pings ${rolesText}.`
    );
  }

  // ========== /unfollowlive ==========
  if (interaction.commandName === 'unfollowlive') {
    const twitchName = interaction.options
      .getString('twitch_name')
      .toLowerCase();

    const before = subs.guilds[guildId].length;
    subs.guilds[guildId] = subs.guilds[guildId].filter(
      (s) => s.twitchName !== twitchName
    );
    saveSubs();

    if (subs.guilds[guildId].length === before) {
      await interaction.reply(
        `❌ Aucun suivi trouvé pour **${twitchName}** sur ce serveur.`
      );
    } else {
      await interaction.reply(
        `🗑️ Tous les suivis pour **${twitchName}** ont été supprimés sur ce serveur.`
      );
    }
  }

  // ========== /listlive ==========
  if (interaction.commandName === 'listlive') {
    const list = subs.guilds[guildId];

    if (!list || list.length === 0) {
      await interaction.reply("Aucun streamer n'est suivi sur ce serveur.");
      return;
    }

    const lines = list.map((s) => {
      const roles = (s.roleIds || []).map((id) => `<@&${id}>`).join(', ');
      return `• **${s.twitchName}** → <#${s.channelId}> (roles: ${roles})`;
    });

    await interaction.reply(`📡 Streamers suivis :\n${lines.join('\n')}`);
  }
});

// ======================= LOGIN BOT ============================

client.login(process.env.DISCORD_TOKEN);
