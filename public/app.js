(function() {
  const STORAGE_KEY = 'patience-theme';
  const html = document.documentElement;
  const themeBtn = document.getElementById('themeBtn');

  function setTheme(dark) {
    html.classList.toggle('light', !dark);
    themeBtn.textContent = dark ? '🌙' : '☀️';
    localStorage.setItem(STORAGE_KEY, dark ? 'dark' : 'light');
  }

  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'light') setTheme(false);
  else if (saved === 'dark') setTheme(true);
  else setTheme(window.matchMedia('(prefers-color-scheme:dark)').matches);

  themeBtn.addEventListener('click', () => {
    setTheme(html.classList.contains('light'));
  });
})();

const $ = id => document.getElementById(id);
const views = ['loginView', 'notPlayingView', 'errorView', 'trackView'];

function showView(id) {
  views.forEach(v => $(v).classList.add('view-hidden'));
  $(id).classList.remove('view-hidden');
}

function formatTime(ms) {
  if (!ms && ms !== 0) return '0:00';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function timeAgo(dateStr) {
  if (!dateStr) return 'never';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

async function fetchJSON(url) {
  try {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(id);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

let currentTrackId = null;
let trackDuration = 0;
let localProgress = 0;
let progressBase = 0;
let progressTime = 0;
let isPlayingLocally = false;
let rafId = null;

function startLocalProgress(progress_ms) {
  progressBase = progress_ms;
  progressTime = Date.now();
  isPlayingLocally = true;
  if (!rafId) rafId = requestAnimationFrame(tick);
}

function stopLocalProgress() {
  isPlayingLocally = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

function updateProgressDisplay(ms) {
  const pct = trackDuration ? Math.min((ms / trackDuration) * 100, 100) : 0;
  $('progressFill').style.width = pct + '%';
  $('currentTime').textContent = formatTime(ms);
}

function tick() {
  rafId = null;
  if (!isPlayingLocally) return;
  const now = Date.now();
  const elapsed = now - progressTime;
  localProgress = progressBase + elapsed;
  if (localProgress >= trackDuration) {
    localProgress = trackDuration;
    updateProgressDisplay(localProgress);
    stopLocalProgress();
    return;
  }
  updateProgressDisplay(localProgress);
  rafId = requestAnimationFrame(tick);
}

function setBackgroundImage(src) {
  const bg = $('bgBlur');
  if (src) {
    bg.style.backgroundImage = `url(${src})`;
    bg.style.opacity = '1';
  } else {
    bg.style.opacity = '0';
  }
}

function extractAlbumColor(src) {
  if (!src) return;
  const img = new Image();
  img.crossOrigin = 'Anonymous';
  img.onload = function() {
    try {
      const c = document.createElement('canvas');
      c.width = 8; c.height = 8;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, 8, 8);
      const d = ctx.getImageData(0, 0, 8, 8).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i]; g += d[i+1]; b += d[i+2];
      }
      const len = d.length / 4;
      document.documentElement.style.setProperty('--glow-rgb',
        `${Math.round(r/len)},${Math.round(g/len)},${Math.round(b/len)}`);
    } catch(e) {}
  };
  img.src = src;
}

function setupMarquee() {
  const el = $('trackName');
  const wrap = document.createElement('span');
  wrap.className = 'track-name-wrap';
  while (el.firstChild) wrap.appendChild(el.firstChild);
  el.appendChild(wrap);
  requestAnimationFrame(() => {
    if (wrap.scrollWidth > el.clientWidth) wrap.classList.add('scrolling');
  });
}

let vizRaf = null;
let eqBarTargets = [];
function startVisualizer() {
  if (vizRaf) return;
  const bars = $('trackEqualizer').querySelectorAll('.eq-bar');
  eqBarTargets = Array.from(bars).map(() => 3 + Math.random() * 14);
  function step() {
    if (!isPlayingLocally || localProgress >= trackDuration) {
      bars.forEach(b => { b.style.height = '3px'; });
      vizRaf = requestAnimationFrame(step);
      return;
    }
    bars.forEach((b, i) => {
      if (Math.random() < 0.08) eqBarTargets[i] = 3 + Math.random() * 14;
      const cur = parseFloat(b.style.height) || 3;
      b.style.height = (cur + (eqBarTargets[i] - cur) * 0.15) + 'px';
    });
    vizRaf = requestAnimationFrame(step);
  }
  step();
}
function stopVisualizer() {
  if (vizRaf) { cancelAnimationFrame(vizRaf); vizRaf = null; }
}

function renderLogin() {
  showView('loginView');
  stopLocalProgress(); stopVisualizer(); currentTrackId = null;
  setBackgroundImage(null);
  fetchJSON('/api/auth-url').then(r => { $('loginBtn').href = r?.url || '/login'; });
}

function renderNotPlaying() {
  showView('notPlayingView');
  stopLocalProgress(); stopVisualizer(); currentTrackId = null;
  setBackgroundImage(null);
}

function renderError(msg) {
  showView('errorView');
  $('errorText').textContent = msg;
  stopLocalProgress(); stopVisualizer(); currentTrackId = null;
}

function renderTrack(data) {
  if (!data || !data.track) return renderNotPlaying();
  const { track, progress_ms, is_playing } = data;
  const paused = is_playing === false;
  trackDuration = track.duration_ms;

  const center = $('vinylCenter');
  center.classList.toggle('dancing', !paused);
  center.classList.toggle('glowing', !paused);

  if (track.id !== currentTrackId) {
    currentTrackId = track.id;
    showView('trackView');
    stopVisualizer();

    $('artWrapper').classList.toggle('paused', paused);
    const art = $('albumArt');
    art.classList.toggle('paused', paused);

    if (track.album_image) {
      art.classList.add('fade-out');
      const prevBg = $('bgBlur').style.backgroundImage;
      setTimeout(() => {
        art.src = track.album_image;
        art.classList.remove('fade-out');
        art.classList.add('fade-in');
        setTimeout(() => art.classList.remove('fade-in'), 500);
      }, 400);
      setBackgroundImage(track.album_image);
      extractAlbumColor(track.album_image);
      art.onerror = function() {
        this.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='250' height='250'%3E%3Crect fill='%23222' width='250' height='250'/%3E%3C/svg%3E";
      };
    }
    $('trackName').textContent = track.name;
    setupMarquee();
    $('trackArtists').textContent = track.artists.join(', ');
    $('totalTime').textContent = formatTime(trackDuration);
    $('nowPlayingBadge').className = 'badge playing' + (paused ? ' paused' : '');
    $('nowPlayingBadge').textContent = paused ? '⏸ paused' : '♪ now playing';
    startVisualizer();
  } else {
    $('artWrapper').classList.toggle('paused', paused);
    $('albumArt').classList.toggle('paused', paused);
    $('nowPlayingBadge').className = 'badge playing' + (paused ? ' paused' : '');
    $('nowPlayingBadge').textContent = paused ? '⏸ paused' : '♪ now playing';
  }

  if (is_playing) {
    startLocalProgress(progress_ms);
    $('vinylCenter').textContent = '🧸';
  } else {
    stopLocalProgress();
    updateProgressDisplay(progress_ms);
    $('vinylCenter').textContent = '💤';
  }
}

function escapeHtml(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderHistory(items) {
  const list = $('historyList');
  const count = $('historyCount');

  if (!items || items.length === 0) {
    list.innerHTML = '<div class="no-history">No history yet</div>';
    count.textContent = '';
    return;
  }

  count.textContent = `${items.length} tracks`;

  list.innerHTML = items.map((item, i) => {
    const artists = Array.isArray(item.artists) ? item.artists.join(', ') : item.artists;
    return `
    <div class="history-item" style="animation-delay:${i * 0.04}s">
      <img class="history-thumb" src="${item.album_image || ''}" alt="" loading="lazy"
        onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'38\\' height=\\'38\\'%3E%3Crect fill=\\'%23222\\' width=\\'38\\' height=\\'38\\'/%3E%3C/svg%3E'" />
      <div class="history-info">
        <div class="history-track">${escapeHtml(item.track_name)}</div>
        <div class="history-artist">${escapeHtml(artists)}</div>
      </div>
      <span class="history-time">${timeAgo(item.played_at)}</span>
    </div>
  `}).join('');
}

async function fetchHistory() {
  const data = await fetchJSON('/api/history?limit=15');
  renderHistory(data);
}

async function fetchStats() {
  const data = await fetchJSON('/api/stats');
  if (!data) return;
  $('statToday').textContent = data.today;
  $('statTotal').textContent = data.total;
  if (data.last_seen) {
    $('statLastSeen').textContent = `last seen ${timeAgo(data.last_seen)}`;
  } else {
    $('statLastSeen').textContent = 'never seen';
  }
}

async function poll() {
  const data = await fetchJSON('/api/currently-playing');
  if (!data) return renderError('Could not reach the server');
  if (data.error === 'no_token') return renderLogin();
  if (data.track) return renderTrack(data);
  if (data.error && data.error !== 'no_track_204' && data.error !== 'no_track_data') {
    return renderError(data.detail || data.error);
  }
  renderNotPlaying();
}

const card = document.querySelector('.glass-card');
const parallaxEl = $('artWrapper');
if (card && parallaxEl) {
  card.addEventListener('mousemove', e => {
    const rect = card.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    parallaxEl.style.transform = `rotateY(${x * 6}deg) rotateX(${y * -4}deg)`;
    parallaxEl.classList.add('parallax');
  });
  card.addEventListener('mouseleave', () => {
    parallaxEl.style.transform = '';
  });
}

showView('loginView');
poll();
fetchHistory();
fetchStats();
setInterval(poll, 3000);
setInterval(fetchHistory, 10000);
setInterval(fetchStats, 15000);
