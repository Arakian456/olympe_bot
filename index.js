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
    .setDescriptio
