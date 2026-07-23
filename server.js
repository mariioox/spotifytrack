require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  console.log('Supabase connected');
} else {
  console.log('Supabase not configured — history/stats disabled');
}

let tokens = {};
try {
  if (fs.existsSync(TOKEN_FILE)) {
    tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
  }
} catch (e) {
  console.error('Failed to load tokens:', e.message);
}

function saveTokens(data) {
  tokens = data;
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save tokens:', e.message);
  }
  saveTokensToSupabase(data);
}

function saveTokensToSupabase(data) {
  if (!supabase) return;
  supabase.from('tokens').upsert({
    id: 1,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    updated_at: new Date().toISOString(),
  }).then(({ error }) => {
    if (error) console.error('Failed to save tokens to Supabase:', error.message);
  });
}

async function loadTokensFromSupabase() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase
      .from('tokens')
      .select('access_token, refresh_token')
      .eq('id', 1)
      .single();
    if (!error && data && data.access_token) {
      tokens.access_token = data.access_token;
      tokens.refresh_token = data.refresh_token;
      console.log('Loaded tokens from Supabase');
    }
  } catch (e) {
    console.error('Failed to load tokens from Supabase:', e.message);
  }
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

let lastLoggedTrackId = null;

async function logTrackToSupabase(track, isPlaying) {
  if (!supabase) return;
  try {
    const { error } = await supabase.from('tracks').insert({
      track_id: track.id,
      track_name: track.name,
      artists: track.artists,
      album: track.album,
      album_image: track.album_image,
      duration_ms: track.duration_ms,
      played_at: new Date().toISOString(),
      is_playing: isPlaying,
    });
    if (error) console.error('Supabase insert error:', error.message);
  } catch (e) {
    console.error('Supabase error:', e.message);
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
  if (!token) return { error: 'no_token' };

  try {
    const res = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 5000,
    });

    if (res.status === 204) return { error: 'no_track_204' };
    if (!res.data || !res.data.item) return { error: 'no_track_data', detail: !res.data ? 'no_data' : 'no_item' };

    const item = res.data.item;
    const trackData = {
      id: item.id,
      name: item.name,
      artists: item.artists.map(a => a.name),
      album: item.album.name,
      album_image: item.album.images?.[0]?.url || null,
      duration_ms: item.duration_ms,
      url: item.external_urls?.spotify || null,
    };

    if (trackData.id !== lastLoggedTrackId) {
      lastLoggedTrackId = trackData.id;
      logTrackToSupabase(trackData, res.data.is_playing);
    }

    return {
      is_playing: res.data.is_playing,
      progress_ms: res.data.progress_ms,
      track: trackData,
    };
  } catch (err) {
    if (err.response?.status === 401) {
      console.log('Token expired, refreshing...');
      const newToken = await refreshAccessToken();
      if (newToken) return getCurrentlyPlaying();
      return { error: 'refresh_failed' };
    }
    const msg = err.response?.data || err.message;
    console.error('getCurrentlyPlaying error:', msg);
    return { error: 'api_error', detail: String(msg).slice(0, 200) };
  }
}

app.get('/api/status', (req, res) => {
  res.json({ authenticated: !!tokens.access_token, supabase: !!supabase });
});

app.get('/api/auth-url', (req, res) => {
  if (!ADMIN_SECRET) return res.status(500).json({ error: 'ADMIN_SECRET not configured' });
  const host = process.env.RENDER ? process.env.RENDER_EXTERNAL_URL : `http://localhost:${PORT}`;
  res.json({ url: `${host}/login?admin=${ADMIN_SECRET}` });
});

app.get('/api/currently-playing', async (req, res) => {
  const data = await getCurrentlyPlaying();
  res.json(data);
});

app.get('/api/history', async (req, res) => {
  if (!supabase) return res.json([]);
  const limit = Math.min(parseInt(req.query.limit) || 15, 50);
  const { data, error } = await supabase
    .from('tracks')
    .select('*')
    .order('played_at', { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  const rows = (data || []).map(r => ({
    ...r,
    artists: typeof r.artists === 'string' ? JSON.parse(r.artists) : r.artists,
  }));
  res.json(rows);
});

app.get('/api/stats', async (req, res) => {
  if (!supabase) return res.json({ today: 0, total: 0 });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { count: todayCount, error: err1 } = await supabase
    .from('tracks')
    .select('*', { count: 'exact', head: true })
    .gte('played_at', today.toISOString());

  const { count: totalCount, error: err2 } = await supabase
    .from('tracks')
    .select('*', { count: 'exact', head: true });

  if (err1 || err2) return res.status(500).json({ error: 'stats error' });

  const { data: lastSeen } = await supabase
    .from('tracks')
    .select('played_at')
    .order('played_at', { ascending: false })
    .limit(1);

  res.json({
    today: todayCount || 0,
    total: totalCount || 0,
    last_seen: lastSeen?.[0]?.played_at || null,
  });
});

app.listen(PORT, () => {
  const host = process.env.RENDER ? process.env.RENDER_EXTERNAL_URL : `http://localhost:${PORT}`;
  console.log(`Server running at ${host}`);
  console.log(`Login at ${host}/login`);
  loadTokensFromSupabase().then(() => {
    console.log(`Authenticated: ${!!tokens.access_token}`);
    if (tokens.access_token) {
      setInterval(() => getCurrentlyPlaying().catch(() => {}), 15000);
    }
  });
});
