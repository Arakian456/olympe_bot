// FULL DISCORD STREAMCORD-LIKE BOT IN ONE FILE
// index.js — bot complet : commandes + suivi live Twitch + annonces
// ---------------------------------------------------------------
// AVERTISSEMENT :
// 1. Mets tes identifiants dans un fichier .env à côté de ce fichier.
// 2. Lance ce bot avec : node index.js
// 3. Si tu modifies les commandes slash, relance ce bot — il redéploie tout automatiquement.

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

// ------------------- INITIALISATION DU BOT -------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Fichier de stockage des streamers suivis
const SUBS_PATH = path.join(__dirname, 'subscriptions.json');
if (!fs.existsSync(SUBS_PATH)) {
  fs.writeFileSync(SUBS_PATH, JSON.stringify({ guilds: {} }, null, 2));
}
let subs = JSON.parse(fs.readFileSync(SUBS_PATH, 'utf8'));

function saveSubs() {
  fs.writeFileSync(SUBS_PATH, JSON.stringify(subs, null, 2), 'utf8');
}

// ------------------------- API TWITCH --------------------------
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

  const data = await res.json();
  twitchToken = data.access_token;
  twitchTokenExpires = now + data.expires_in * 1000 - 60000;
  return twitchToken;
}

async function getStream(twitchName) {
  const token = await getTwitchToken();

  const res = await fetch(
    `https://api.twitch.tv/helix/streams?user_login=${twitchName}`,
    {
      headers: {
        'Client-ID': process.env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${token}`
      }
    }
  );

  const data = await res.json();
  return data.data && data.data.length > 0 ? data.data[0] : null;
}

// ------------------- COMMANDES SLASH (DANS CE FICHIER) -------------------
const commands = [
  new SlashCommandBuilder()
    .setName('followlive')
    .setDescription(
      'Suivre un streamer Twitch et annoncer quand il passe en live'
    )
    .addStringOption(o =>
      o
        .setName('twitch_name')
        .setDescription('Nom Twitch')
        .setRequired(true)
    )
    .addChannelOption(o =>
      o
        .setName('salon')
        .setDescription('Salon pour annoncer')
        .setRequired(true)
    )
    .addRoleOption(o =>
      o
        .setName('role')
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
        .setDescription('Nom Twitch')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('listlive')
    .setDescription('Liste les suivis live du serveur')
].map(c => c.toJSON());

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
  } catch (e) {
    console.error('Erreur déploiement commandes', e);
  }
}

// ---------------------- BOUCLE DE SURVEILLANCE ----------------------
const CHECK_INTERVAL = 60000;

async function checkLives() {
  for (const [guildId, guildSubs] of Object.entries(subs.guilds)) {
    for (const sub of guildSubs) {
      try {
        const stream = await getStream(sub.twitchName);

        // Pas en live
        if (!stream) {
          if (sub.lastStreamId) {
            sub.lastStreamId = null;
            saveSubs();
          }
          continue;
        }

        // Live déjà annoncé
        if (sub.lastStreamId === stream.id) continue;

        // Nouveau live 🎉
        sub.lastStreamId = stream.id;
        saveSubs();

        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) continue;

        const channel = await guild.channels
          .fetch(sub.channelId)
          .catch(() => null);
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
            `Le streamer **${sub.twitchName}** vient de commencer son live !`
          )
          .setImage(thumb)
          .addFields(
            {
              name: 'Jeu',
              value: stream.game_name || 'Non spécifié',
              inline: true
            },
