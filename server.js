require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN_FILE = path.join(__dirname, '.spotify-tokens.json');

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET in .env');
  process.exit(1);
}
const REDIRECT_URI = process.env.REDIRECT_URI ||
  (process.env.RENDER ? `${process.env.RENDER_EXTERNAL_URL}/callback` : `http://localhost:${PORT}/callback`);
const BASE_URL = REDIRECT_URI.split('?')[0];

const ADMIN_SECRET = process.env.ADMIN_SECRET;

let tokens = {};
if (fs.existsSync(TOKEN_FILE)) {
  tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
}

function saveTokens(data) {
  tokens = data;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
}

async function refreshAccessToken() {
  if (!tokens.refresh_token) return null;

  try {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });

    const res = await axios.post('https://accounts.spotify.com/api/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 5000,
    });

    tokens.access_token = res.data.access_token;
    if (res.data.refresh_token) tokens.refresh_token = res.data.refresh_token;
    saveTokens(tokens);
    return tokens.access_token;
  } catch (err) {
    console.error('Failed to refresh token:', err.response?.data || err.message);
    return null;
  }
}

app.use(express.static('public'));

app.get('/login', (req, res) => {
  if (req.query.admin !== ADMIN_SECRET) return res.status(404).send('Not found');
  const state = crypto.randomBytes(16).toString('hex');
  const scope = 'user-read-currently-playing user-read-playback-state';

  const authUrl = 'https://accounts.spotify.com/authorize?' +
    new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      scope,
      redirect_uri: BASE_URL,
      state,
    });

  res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');

  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: BASE_URL,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });

    const tokenRes = await axios.post('https://accounts.spotify.com/api/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 5000,
    });

    saveTokens({
      access_token: tokenRes.data.access_token,
      refresh_token: tokenRes.data.refresh_token,
    });

    res.send('<h1>Authenticated! You can close this tab.</h1>');
  } catch (err) {
    console.error('Auth error:', err.response?.data || err.message);
    res.status(500).send('Authentication failed');
  }
});

async function getCurrentlyPlaying() {
  const token = tokens.access_token;
  if (!token) return null;

  try {
    const res = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 5000,
    });

    if (res.status === 204 || !res.data || !res.data.item) return null;

    const item = res.data.item;
    return {
      is_playing: res.data.is_playing,
      progress_ms: res.data.progress_ms,
      track: {
        id: item.id,
        name: item.name,
        artists: item.artists.map(a => a.name),
        album: item.album.name,
        album_image: item.album.images?.[0]?.url || null,
        duration_ms: item.duration_ms,
        url: item.external_urls?.spotify || null,
      },
    };
  } catch (err) {
    if (err.response?.status === 401) {
      console.log('Token expired, refreshing...');
      const newToken = await refreshAccessToken();
      if (newToken) return getCurrentlyPlaying();
      console.log('Token refresh failed');
    } else {
      console.error('getCurrentlyPlaying error:', err.response?.data || err.message);
    }
    return null;
  }
}

app.get('/api/currently-playing', async (req, res) => {
  const data = await getCurrentlyPlaying();
  res.json(data);
});

app.listen(PORT, () => {
  const host = process.env.RENDER ? process.env.RENDER_EXTERNAL_URL : `http://localhost:${PORT}`;
  console.log(`Server running at ${host}`);
  console.log(`Login at ${host}/login`);
});
