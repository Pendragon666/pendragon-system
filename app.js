/**
 * Biokinesis Loop Player - PWA para iPhone & Safari
 * Desenvolvido para reprodução contínua em loop com suporte a tela bloqueada.
 */

// --- IndexedDB Storage Helper ---
const DB_NAME = 'BiokinesisLoopDB';
const DB_VERSION = 1;
const STORE_NAME = 'tracks';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('order', 'order', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGetAllTracks() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      const items = request.result || [];
      items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      resolve(items);
    };
    request.onerror = () => reject(request.error);
  });
}

async function dbAddTracks(files) {
  const db = await openDatabase();
  const existing = await dbGetAllTracks();
  let maxOrder = existing.length > 0 ? Math.max(...existing.map(t => t.order || 0)) : 0;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    for (const file of files) {
      maxOrder++;
      store.add({
        name: file.name,
        size: file.size,
        type: file.type || 'audio/mp3',
        blob: file,
        order: maxOrder,
        addedAt: Date.now()
      });
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDeleteTrack(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbUpdateTrackOrder(items) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    items.forEach((item, index) => {
      item.order = index + 1;
      store.put(item);
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- Player State & DOM Elements ---
let playlist = [];
let currentIndex = -1;
let currentBlobUrl = null;
let isPlaying = false;
let loopMode = 'playlist'; // 'playlist' (loop all) | 'single' (loop one)
let sleepTimerMinutes = 0;
let sleepTimerInterval = null;
let sleepTargetTime = null;
let originalVolume = 1.0;

// Elements
const audioPlayer = document.getElementById('audioPlayer');
const btnPlayPause = document.getElementById('btnPlayPause');
const iconPlay = document.getElementById('iconPlay');
const iconPause = document.getElementById('iconPause');
const btnPrev = document.getElementById('btnPrev');
const btnNext = document.getElementById('btnNext');
const btnLoopMode = document.getElementById('btnLoopMode');
const loopIcon = document.getElementById('loopIcon');
const loopText = document.getElementById('loopText');
const btnSleepTimer = document.getElementById('btnSleepTimer');
const timerText = document.getElementById('timerText');
const trackTitle = document.getElementById('trackTitle');
const trackMeta = document.getElementById('trackMeta');
const trackIndexBadge = document.getElementById('trackIndexBadge');
const statusBadge = document.getElementById('statusBadge');
const tracksCount = document.getElementById('tracksCount');
const playlistContainer = document.getElementById('playlistContainer');
const emptyState = document.getElementById('emptyState');
const fileInput = document.getElementById('fileInput');
const progressBarContainer = document.getElementById('progressBarContainer');
const progressBarFill = document.getElementById('progressBarFill');
const progressThumb = document.getElementById('progressThumb');
const currentTimeDisplay = document.getElementById('currentTime');
const totalDurationDisplay = document.getElementById('totalDuration');
const visualizerDisc = document.getElementById('artworkDisc');
const timerModal = document.getElementById('timerModal');
const infoModal = document.getElementById('infoModal');
const btnCloseTimer = document.getElementById('btnCloseTimer');
const btnCloseInfo = document.getElementById('btnCloseInfo');
const btnInfo = document.getElementById('btnInfo');

// --- Helper Formatting ---
function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

function cleanFileName(filename) {
  return filename.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
}

// --- Load Track & Playback ---
function loadTrack(index, autoPlay = false) {
  if (index < 0 || index >= playlist.length) return;

  currentIndex = index;
  const track = playlist[currentIndex];

  // Clean old URL
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
  }

  currentBlobUrl = URL.createObjectURL(track.blob);
  audioPlayer.src = currentBlobUrl;
  audioPlayer.volume = 1.0;

  // UI Updates
  const cleanName = cleanFileName(track.name);
  trackTitle.textContent = cleanName;
  trackMeta.textContent = formatFileSize(track.size);
  trackIndexBadge.textContent = `Faixa ${currentIndex + 1} de ${playlist.length}`;
  statusBadge.textContent = isPlaying ? 'Reproduzindo em Loop' : 'Pronto para tocar';

  renderPlaylistUI();

  // Setup MediaSession for iOS Safari Lock Screen
  updateMediaSession(cleanName);

  if (autoPlay) {
    audioPlayer.play().then(() => {
      setPlayState(true);
    }).catch(err => {
      console.warn("Autoplay bloqueado pelo iOS:", err);
      setPlayState(false);
    });
  }
}

function setPlayState(playing) {
  isPlaying = playing;
  if (playing) {
    iconPlay.classList.add('hidden');
    iconPause.classList.remove('hidden');
    visualizerDisc.classList.add('playing');
    document.querySelector('.visualizer-wrapper').classList.add('playing');
    statusBadge.textContent = loopMode === 'playlist' ? 'Loop Playlist 🔁' : 'Loop Faixa 🔂';
  } else {
    iconPlay.classList.remove('hidden');
    iconPause.classList.add('hidden');
    visualizerDisc.classList.remove('playing');
    document.querySelector('.visualizer-wrapper').classList.remove('playing');
    statusBadge.textContent = 'Pausado';
  }

  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }
}

// --- MediaSession for iOS Lock Screen Controls ---
function updateMediaSession(title) {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title: title,
    artist: 'Pendragon Maximization System',
    album: 'Pendragon Maximization System',
    artwork: [
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png' }
    ]
  });

  navigator.mediaSession.setActionHandler('play', () => {
    audioPlayer.play();
    setPlayState(true);
  });

  navigator.mediaSession.setActionHandler('pause', () => {
    audioPlayer.pause();
    setPlayState(false);
  });

  navigator.mediaSession.setActionHandler('previoustrack', playPrevTrack);
  navigator.mediaSession.setActionHandler('nexttrack', playNextTrack);

  try {
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime && audioPlayer.duration) {
        audioPlayer.currentTime = details.seekTime;
      }
    });
    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
      audioPlayer.currentTime = Math.max(0, audioPlayer.currentTime - (details.seekOffset || 10));
    });
    navigator.mediaSession.setActionHandler('seekforward', (details) => {
      audioPlayer.currentTime = Math.min(audioPlayer.duration, audioPlayer.currentTime + (details.seekOffset || 10));
    });
  } catch (e) {
    // Alguns navegadores ignoram seek
  }
}

// --- iOS Continuous Seamless Loop ---
audioPlayer.addEventListener('ended', () => {
  if (playlist.length === 0) return;

  if (loopMode === 'single') {
    // Loop only this track
    audioPlayer.currentTime = 0;
    audioPlayer.play().catch(e => console.error("Erro no loop single:", e));
  } else {
    // Loop whole playlist (Track 1 -> 2 -> 3 -> 1...)
    const nextIdx = (currentIndex + 1) % playlist.length;
    loadTrack(nextIdx, true);
  }
});

// Audio progress events
audioPlayer.addEventListener('timeupdate', () => {
  if (!audioPlayer.duration) return;
  const current = audioPlayer.currentTime;
  const total = audioPlayer.duration;
  const pct = (current / total) * 100;

  progressBarFill.style.width = `${pct}%`;
  progressThumb.style.left = `${pct}%`;
  currentTimeDisplay.textContent = formatTime(current);
});

audioPlayer.addEventListener('loadedmetadata', () => {
  totalDurationDisplay.textContent = formatTime(audioPlayer.duration);
});

// Click / Scrub on progress bar
function seek(e) {
  if (!audioPlayer.duration) return;
  const rect = progressBarContainer.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clickX = Math.max(0, Math.min(clientX - rect.left, rect.width));
  const pct = clickX / rect.width;
  audioPlayer.currentTime = pct * audioPlayer.duration;
}

let isScrubbing = false;
progressBarContainer.addEventListener('mousedown', (e) => {
  isScrubbing = true;
  seek(e);
});
window.addEventListener('mousemove', (e) => {
  if (isScrubbing) seek(e);
});
window.addEventListener('mouseup', () => { isScrubbing = false; });

progressBarContainer.addEventListener('touchstart', (e) => {
  isScrubbing = true;
  seek(e);
}, { passive: true });
window.addEventListener('touchmove', (e) => {
  if (isScrubbing) seek(e);
}, { passive: true });
window.addEventListener('touchend', () => { isScrubbing = false; });

// --- Play / Pause Controls ---
btnPlayPause.addEventListener('click', () => {
  ensureAudioContext();

  if (playlist.length === 0) {
    fileInput.click();
    return;
  }

  if (currentIndex === -1) {
    loadTrack(0, true);
    return;
  }

  if (audioPlayer.paused) {
    audioPlayer.play().then(() => {
      setPlayState(true);
    }).catch(err => {
      console.error("Erro ao dar play:", err);
    });
  } else {
    audioPlayer.pause();
    setPlayState(false);
  }
});

function playNextTrack() {
  if (playlist.length === 0) return;
  const nextIdx = (currentIndex + 1) % playlist.length;
  loadTrack(nextIdx, true);
}

function playPrevTrack() {
  if (playlist.length === 0) return;
  // If track played > 3 seconds, restart current track
  if (audioPlayer.currentTime > 3) {
    audioPlayer.currentTime = 0;
    return;
  }
  const prevIdx = (currentIndex - 1 + playlist.length) % playlist.length;
  loadTrack(prevIdx, true);
}

btnNext.addEventListener('click', playNextTrack);
btnPrev.addEventListener('click', playPrevTrack);

// --- Loop Mode Toggle ---
btnLoopMode.addEventListener('click', () => {
  if (loopMode === 'playlist') {
    loopMode = 'single';
    loopIcon.textContent = '🔂';
    loopText.textContent = 'Loop 1 Música';
  } else {
    loopMode = 'playlist';
    loopIcon.textContent = '🔁';
    loopText.textContent = 'Loop Playlist';
  }
  if (isPlaying) {
    statusBadge.textContent = loopMode === 'playlist' ? 'Loop Playlist 🔁' : 'Loop Faixa 🔂';
  }
});

// --- Sleep Timer Logic ---
function setSleepTimer(minutes) {
  sleepTimerMinutes = minutes;
  if (sleepTimerInterval) clearInterval(sleepTimerInterval);

  if (minutes <= 0) {
    timerText.textContent = 'Timer: Off';
    btnSleepTimer.classList.remove('active');
    audioPlayer.volume = 1.0;
    return;
  }

  btnSleepTimer.classList.add('active');
  sleepTargetTime = Date.now() + minutes * 60 * 1000;
  originalVolume = audioPlayer.volume || 1.0;

  function updateTimer() {
    const remainingMs = sleepTargetTime - Date.now();
    if (remainingMs <= 0) {
      clearInterval(sleepTimerInterval);
      audioPlayer.pause();
      audioPlayer.volume = originalVolume;
      setPlayState(false);
      timerText.textContent = 'Timer: Off';
      btnSleepTimer.classList.remove('active');
      statusBadge.textContent = 'Timer finalizado (Pausado)';
      return;
    }

    const totalSecs = Math.ceil(remainingMs / 1000);
    const m = Math.floor(totalSecs / 60);
    const s = totalSecs % 60;
    timerText.textContent = `${m}:${String(s).padStart(2, '0')}`;

    // Soft fade-out in the last 30 seconds
    if (totalSecs <= 30 && totalSecs > 0) {
      const fadeFraction = totalSecs / 30;
      audioPlayer.volume = Math.max(0, originalVolume * fadeFraction);
    }
  }

  updateTimer();
  sleepTimerInterval = setInterval(updateTimer, 1000);
}

// Timer Modal Handlers
btnSleepTimer.addEventListener('click', () => {
  timerModal.classList.add('active');
});

btnCloseTimer.addEventListener('click', () => {
  timerModal.classList.remove('active');
});

timerModal.addEventListener('click', (e) => {
  if (e.target === timerModal) timerModal.classList.remove('active');
});

document.querySelectorAll('.timer-option-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.timer-option-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const mins = parseInt(btn.dataset.minutes, 10);
    setSleepTimer(mins);
    setTimeout(() => timerModal.classList.remove('active'), 200);
  });
});

// Info Modal Handlers
btnInfo.addEventListener('click', () => infoModal.classList.add('active'));
btnCloseInfo.addEventListener('click', () => infoModal.classList.remove('active'));
infoModal.addEventListener('click', (e) => {
  if (e.target === infoModal) infoModal.classList.remove('active');
});

// --- Playlist Management & UI ---
async function refreshPlaylist() {
  playlist = await dbGetAllTracks();
  tracksCount.textContent = `${playlist.length} ${playlist.length === 1 ? 'áudio' : 'áudios'}`;

  if (playlist.length === 0) {
    emptyState.classList.remove('hidden');
    trackTitle.textContent = 'Nenhum áudio carregado';
    trackMeta.textContent = 'Adicione suas músicas abaixo';
    trackIndexBadge.textContent = 'Faixa 0 de 0';
    currentIndex = -1;
  } else {
    emptyState.classList.add('hidden');
    if (currentIndex === -1) {
      loadTrack(0, false);
    } else if (currentIndex >= playlist.length) {
      loadTrack(0, false);
    }
  }

  renderPlaylistUI();
}

function renderPlaylistUI() {
  // Keep empty state in DOM, remove old items
  const items = playlistContainer.querySelectorAll('.playlist-item');
  items.forEach(it => it.remove());

  playlist.forEach((track, index) => {
    const isCurrent = index === currentIndex;
    const itemEl = document.createElement('div');
    itemEl.className = `playlist-item ${isCurrent ? 'active' : ''}`;

    itemEl.innerHTML = `
      <div class="item-left">
        <div class="item-index-badge">${index + 1}</div>
        <div class="item-info">
          <div class="item-title">${cleanFileName(track.name)}</div>
          <div class="item-sub">${formatFileSize(track.size)}</div>
        </div>
      </div>
      <div class="item-actions">
        ${index > 0 ? `
          <button class="action-btn btn-up" title="Mover para cima" data-idx="${index}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="18 15 12 9 6 15"></polyline>
            </svg>
          </button>
        ` : ''}
        ${index < playlist.length - 1 ? `
          <button class="action-btn btn-down" title="Mover para baixo" data-idx="${index}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
        ` : ''}
        <button class="action-btn btn-delete" title="Remover áudio" data-id="${track.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    `;

    // Click item to play
    itemEl.querySelector('.item-left').addEventListener('click', () => {
      loadTrack(index, true);
    });

    // Delete
    itemEl.querySelector('.btn-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      const trackId = track.id;
      await dbDeleteTrack(trackId);
      if (currentIndex === index) {
        audioPlayer.pause();
        setPlayState(false);
        currentIndex = -1;
      }
      await refreshPlaylist();
    });

    // Move Up
    const btnUp = itemEl.querySelector('.btn-up');
    if (btnUp) {
      btnUp.addEventListener('click', async (e) => {
        e.stopPropagation();
        const temp = playlist[index];
        playlist[index] = playlist[index - 1];
        playlist[index - 1] = temp;
        if (currentIndex === index) currentIndex = index - 1;
        else if (currentIndex === index - 1) currentIndex = index;
        await dbUpdateTrackOrder(playlist);
        await refreshPlaylist();
      });
    }

    // Move Down
    const btnDown = itemEl.querySelector('.btn-down');
    if (btnDown) {
      btnDown.addEventListener('click', async (e) => {
        e.stopPropagation();
        const temp = playlist[index];
        playlist[index] = playlist[index + 1];
        playlist[index + 1] = temp;
        if (currentIndex === index) currentIndex = index + 1;
        else if (currentIndex === index + 1) currentIndex = index;
        await dbUpdateTrackOrder(playlist);
        await refreshPlaylist();
      });
    }

    playlistContainer.appendChild(itemEl);
  });
}

// File input selection
fileInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  if (files.length === 0) return;

  statusBadge.textContent = 'Salvando áudios...';
  try {
    await dbAddTracks(files);
    await refreshPlaylist();
    statusBadge.textContent = 'Áudios prontos!';
    // If player was idle, start playing track 0
    if (!isPlaying && playlist.length > 0) {
      loadTrack(0, false);
    }
  } catch (err) {
    console.error("Erro ao salvar áudios:", err);
    alert("Ocorreu um erro ao salvar o arquivo no dispositivo.");
  } finally {
    fileInput.value = '';
  }
});

// --- PWA Service Worker Registration ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      console.log('Service Worker registrado com sucesso:', reg.scope);
    }).catch(err => {
      console.log('Falha ao registrar Service Worker:', err);
    });
  });
}

// Botão de carregar áudios de demonstração (Trilogia Vampírica)
const btnLoadDemo = document.getElementById('btnLoadDemo');
if (btnLoadDemo) {
  btnLoadDemo.addEventListener('click', async () => {
    btnLoadDemo.disabled = true;
    btnLoadDemo.textContent = 'Invocando rituais de áudio...';
    try {
      const demoFiles = [
        { url: 'playlist/VLAD%20THE%20IMPALER%20100X.wav', name: 'VLAD THE IMPALER 100X.wav' },
        { url: 'playlist/VAMPYRiC%20G%C3%98D%20V2%201000X%20~%20CALM.wav', name: 'VAMPYRiC GØD V2 1000X ~ CALM.wav' },
        { url: 'playlist/VAMPYRiC%20PUNK%20V2%201000X%20~%20CALM.wav', name: 'VAMPYRiC PUNK V2 1000X ~ CALM.wav' }
      ];
      const blobs = [];
      for (const item of demoFiles) {
        const res = await fetch(item.url);
        if (!res.ok) throw new Error(`Falha ao buscar ${item.url}`);
        const blob = await res.blob();
        blobs.push(new File([blob], item.name, { type: 'audio/wav' }));
      }
      await dbAddTracks(blobs);
      await refreshPlaylist();
      if (playlist.length > 0) {
        loadTrack(0, true);
      }
    } catch (e) {
      console.error('Erro ao carregar rituais:', e);
      alert('Não foi possível carregar a trilogia automaticamente. Você pode adicioná-los pelo botão "+ Adicionar"!');
    } finally {
      btnLoadDemo.disabled = false;
      btnLoadDemo.textContent = '🩸 Inserir Trilogia: Vlad, Vampyric God & Punk';
    }
  });
}

// --- Ambient Canvas: Blood Rain Engine (Chuva de Sangue no Fundo Preto) ---
function initAmbientCanvas() {
  const canvas = document.getElementById('ambientCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let width, height;

  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  // Create 100 vertical blood rain streaks
  const rainDrops = Array.from({ length: 110 }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    length: Math.random() * 28 + 16,
    speed: Math.random() * 14 + 10,
    width: Math.random() * 1.6 + 0.8,
    alpha: Math.random() * 0.7 + 0.25,
    bright: Math.random() > 0.4
  }));

  // Blood Splash Particles
  const splashes = [];

  function createSplash(x, y) {
    const count = Math.floor(Math.random() * 3) + 2;
    for (let i = 0; i < count; i++) {
      splashes.push({
        x: x,
        y: y,
        vx: (Math.random() - 0.5) * 4,
        vy: -(Math.random() * 3 + 1.5),
        radius: Math.random() * 1.5 + 0.8,
        alpha: 0.85,
        decay: Math.random() * 0.05 + 0.04
      });
    }
  }

  function animate() {
    if (document.hidden) {
      requestAnimationFrame(animate);
      return;
    }

    // Pure pitch-black OLED background with soft rain trails
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    // Draw and update blood rain drops
    for (const drop of rainDrops) {
      drop.y += drop.speed;

      // Reset when reaches bottom & trigger splash
      if (drop.y > height) {
        createSplash(drop.x, height - 2);
        drop.y = -drop.length;
        drop.x = Math.random() * width;
      }

      const grad = ctx.createLinearGradient(drop.x, drop.y - drop.length, drop.x, drop.y);
      grad.addColorStop(0, 'rgba(120, 0, 15, 0)');
      if (drop.bright) {
        grad.addColorStop(0.7, `rgba(220, 0, 35, ${drop.alpha * 0.7})`);
        grad.addColorStop(1, `rgba(255, 17, 60, ${drop.alpha})`);
      } else {
        grad.addColorStop(0.7, `rgba(140, 0, 20, ${drop.alpha * 0.6})`);
        grad.addColorStop(1, `rgba(180, 0, 25, ${drop.alpha * 0.8})`);
      }

      ctx.strokeStyle = grad;
      ctx.lineWidth = drop.width;
      ctx.beginPath();
      ctx.moveTo(drop.x, drop.y - drop.length);
      ctx.lineTo(drop.x, drop.y);
      ctx.stroke();

      // Glowing tip
      if (drop.bright) {
        ctx.fillStyle = `rgba(255, 40, 80, ${drop.alpha * 0.9})`;
        ctx.shadowColor = '#ff003c';
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.arc(drop.x, drop.y, drop.width * 0.9, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    // Update and draw splashes
    for (let i = splashes.length - 1; i >= 0; i--) {
      const sp = splashes[i];
      sp.x += sp.vx;
      sp.y += sp.vy;
      sp.vy += 0.25; // gravity
      sp.alpha -= sp.decay;

      if (sp.alpha <= 0) {
        splashes.splice(i, 1);
        continue;
      }

      ctx.fillStyle = `rgba(255, 20, 60, ${sp.alpha})`;
      ctx.shadowColor = '#ff003c';
      ctx.shadowBlur = 4;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, sp.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Real-time Cymatic Reactivity
    updateAudioReactivity();

    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);
}

// --- Web Audio API: Sincronização Cimática em Tempo Real ---
let audioCtx = null;
let analyser = null;
let audioSource = null;
let dataArray = null;
let isAudioContextReady = false;

function ensureAudioContext() {
  if (isAudioContextReady) {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return;
  }
  try {
    const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtxClass) return;
    audioCtx = new AudioCtxClass();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.85;

    audioSource = audioCtx.createMediaElementSource(audioPlayer);
    audioSource.connect(analyser);
    analyser.connect(audioCtx.destination);

    dataArray = new Uint8Array(analyser.frequencyBinCount);
    isAudioContextReady = true;

    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
  } catch (err) {
    console.warn("Web Audio API inicializado com fallback:", err);
  }
}

// User interaction unlock for iOS Safari
['touchstart', 'touchend', 'click'].forEach(evt => {
  document.addEventListener(evt, () => {
    if (!isAudioContextReady && isPlaying) {
      ensureAudioContext();
    } else if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
  }, { passive: true, once: false });
});

// Dynamic Audio Reactive Modulation
// Dynamic Audio Reactive Modulation: Pulso Físico em Tamanho e Luz
const turbilhaoImgEl = document.getElementById('turbilhaoImg');
const decagonoSvgEl = document.getElementById('decagonoSvg');
const frequencyBarSpans = document.querySelectorAll('#frequencyBars span');
const visualizerWrapperEl = document.querySelector('.visualizer-wrapper');
let beatPulse = 0;
let prevBassEnergy = 0;

function updateAudioReactivity() {
  if (!isPlaying) {
    beatPulse = 0;
    if (visualizerWrapperEl) {
      visualizerWrapperEl.style.removeProperty('--turbilhao-scale');
      visualizerWrapperEl.style.removeProperty('--turbilhao-glow');
      visualizerWrapperEl.style.removeProperty('--turbilhao-brightness');
      visualizerWrapperEl.style.removeProperty('--turbilhao-glow-alpha');
    }
    return;
  }

  let liveBassEnergy = 0;
  let hasLiveData = false;

  if (analyser && dataArray) {
    analyser.getByteFrequencyData(dataArray);

    // Read low-frequency bass & theta bins (bins 1 to 6)
    let sum = 0;
    for (let i = 1; i <= 6; i++) {
      sum += dataArray[i] || 0;
    }
    liveBassEnergy = (sum / 6) / 255;

    if (liveBassEnergy > 0.03) {
      hasLiveData = true;
    }

    // Animate equalizer bars inside center disc
    if (frequencyBarSpans && frequencyBarSpans.length > 0) {
      const step = Math.floor(dataArray.length / frequencyBarSpans.length) || 1;
      frequencyBarSpans.forEach((bar, idx) => {
        const binVal = dataArray[idx * step] || 0;
        const barHeight = Math.max(3, (binVal / 255) * 28);
        bar.style.height = `${barHeight}px`;
      });
    }
  }

  if (hasLiveData) {
    // Dynamic transient kick / frequency attack
    const attack = liveBassEnergy - prevBassEnergy;
    if (attack > 0.04) {
      beatPulse = Math.min(1.0, beatPulse + attack * 3.5);
    }
    beatPulse = Math.max(liveBassEnergy * 0.95, beatPulse * 0.82);
    prevBassEnergy = liveBassEnergy;
  } else {
    // Pulso biocinético imediato e visível no milissegundo em que dá Play (~130 BPM / 4.2Hz)
    const now = performance.now() / 1000;
    const rhythm = Math.pow(Math.max(0, Math.sin(now * Math.PI * 4.3)), 3.2);
    beatPulse = Math.max(beatPulse * 0.84, rhythm * 0.92);

    if (frequencyBarSpans && frequencyBarSpans.length > 0) {
      frequencyBarSpans.forEach((bar, idx) => {
        const wave = Math.sin(now * 8 + idx * 0.6) * 0.5 + 0.5;
        bar.style.height = `${4 + wave * beatPulse * 22}px`;
      });
    }
  }

  // Pulso físico em tamanho (scale de 1.0 até 1.22x) e luz (glow até 55px)
  const currentScale = 1.0 + beatPulse * 0.22;
  const currentGlow = 10 + beatPulse * 45;
  const currentBrightness = 1.0 + beatPulse * 0.5;
  const currentAlpha = 0.75 + beatPulse * 0.25;

  if (visualizerWrapperEl) {
    visualizerWrapperEl.style.setProperty('--turbilhao-scale', currentScale.toFixed(3));
    visualizerWrapperEl.style.setProperty('--turbilhao-glow', `${currentGlow.toFixed(1)}px`);
    visualizerWrapperEl.style.setProperty('--turbilhao-brightness', currentBrightness.toFixed(2));
    visualizerWrapperEl.style.setProperty('--turbilhao-glow-alpha', currentAlpha.toFixed(2));
  }

  if (decagonoSvgEl) {
    decagonoSvgEl.style.filter = `drop-shadow(0 0 ${4 + beatPulse * 18}px rgba(255, 0, 60, ${0.5 + beatPulse * 0.5}))`;
    decagonoSvgEl.style.transform = `scale(${1 + beatPulse * 0.05})`;
    decagonoSvgEl.style.opacity = `${0.7 + beatPulse * 0.3}`;
  }

  const artworkDiscEl = document.getElementById('artworkDisc');
  if (artworkDiscEl) {
    artworkDiscEl.style.boxShadow = `0 0 ${20 + beatPulse * 40}px rgba(255, 0, 60, ${0.6 + beatPulse * 0.4}), inset 0 0 ${15 + beatPulse * 25}px rgba(255, 0, 60, 0.4)`;
    artworkDiscEl.style.transform = `scale(${1 + beatPulse * 0.06})`;
  }
}

// --- Testemunho & Intenção Radiônica (Gravação no Anel do Turbilhão) ---
const WITNESS_STORAGE_KEY = 'vampyric_radionic_witness';

function loadWitness() {
  const saved = localStorage.getItem(WITNESS_STORAGE_KEY);
  // Se for o texto padrão antigo ou se não tiver nada escrito, fica 100% LIMPO e VAZIO
  if (saved && saved.trim() && !saved.includes('ATIVAÇÃO CELULAR 1000X')) {
    applyWitness(saved.trim(), false);
  } else {
    localStorage.removeItem(WITNESS_STORAGE_KEY);
    applyWitness('', false);
  }
}

function applyWitness(text, save = true) {
  const witnessTextPath = document.getElementById('witnessTextPath');
  const inputWitnessText = document.getElementById('inputWitnessText');
  const witnessBtnLabel = document.getElementById('witnessBtnLabel');

  const clean = (text || '').trim().toUpperCase();

  if (witnessTextPath) {
    // SÓ APARECE SE TIVER TEXTO ESCRITO! Se vazio, fica totalmente invisível!
    if (clean) {
      witnessTextPath.textContent = clean.startsWith('⚡') ? clean : `⚡ ${clean} ⚡`;
    } else {
      witnessTextPath.textContent = '';
    }
  }

  if (save) {
    if (clean) {
      localStorage.setItem(WITNESS_STORAGE_KEY, clean);
    } else {
      localStorage.removeItem(WITNESS_STORAGE_KEY);
    }
  }

  if (inputWitnessText) {
    inputWitnessText.value = clean ? clean.replace(/⚡/g, '').trim() : '';
  }

  if (witnessBtnLabel) {
    witnessBtnLabel.textContent = clean ? 'INTENÇÃO ATIVA' : 'TESTEMUNHO';
  }
}

function setupWitnessEvents() {
  loadWitness();

  const btnTestemunho = document.getElementById('btnTestemunho');
  const testemunhoModal = document.getElementById('testemunhoModal');
  const inputWitnessText = document.getElementById('inputWitnessText');
  const btnSaveWitness = document.getElementById('btnSaveWitness');
  const btnClearWitness = document.getElementById('btnClearWitness');

  if (btnTestemunho && testemunhoModal) {
    btnTestemunho.addEventListener('click', () => {
      testemunhoModal.classList.add('active');
      if (inputWitnessText) inputWitnessText.focus();
    });
  }

  if (btnSaveWitness && testemunhoModal) {
    btnSaveWitness.addEventListener('click', () => {
      const val = inputWitnessText ? inputWitnessText.value : '';
      applyWitness(val.trim(), true);
      if (val.trim()) {
        statusBadge.textContent = '// TESTEMUNHO VIBRACIONAL GRAVADO 🔯';
        setTimeout(() => {
          statusBadge.textContent = isPlaying ? 'Loop Playlist 🔁' : '// RESSONÂNCIA: LOOP_INFINITO 🩸';
        }, 2500);
      }
      testemunhoModal.classList.remove('active');
    });
  }

  if (btnClearWitness && testemunhoModal) {
    btnClearWitness.addEventListener('click', () => {
      localStorage.removeItem(WITNESS_STORAGE_KEY);
      applyWitness('', false);
      if (inputWitnessText) inputWitnessText.value = '';
      testemunhoModal.classList.remove('active');
    });
  }

  if (testemunhoModal) {
    testemunhoModal.addEventListener('click', (e) => {
      if (e.target === testemunhoModal) {
        testemunhoModal.classList.remove('active');
      }
    });
  }

  document.querySelectorAll('.preset-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const preset = chip.getAttribute('data-text');
      if (preset && inputWitnessText) {
        inputWitnessText.value = preset;
      }
    });
  });
}

// --- Playlist Collapse / Expand Toggle ---
function setupPlaylistToggle() {
  const btnTogglePlaylist = document.getElementById('btnTogglePlaylist');
  const playlistContainerEl = document.getElementById('playlistContainer');
  const togglePlaylistText = document.getElementById('togglePlaylistText');
  const togglePlaylistIcon = document.getElementById('togglePlaylistIcon');

  if (btnTogglePlaylist && playlistContainerEl) {
    btnTogglePlaylist.addEventListener('click', () => {
      const isCollapsed = playlistContainerEl.classList.toggle('collapsed');
      if (togglePlaylistText) {
        togglePlaylistText.textContent = isCollapsed ? 'EXPANDIR' : 'RECOLHER';
      }
      if (togglePlaylistIcon) {
        togglePlaylistIcon.textContent = isCollapsed ? '▼' : '▲';
      }
    });
  }
}

// --- Initialize App ---
document.addEventListener('DOMContentLoaded', () => {
  initAmbientCanvas();
  setupPlaylistToggle();
  setupWitnessEvents();
  refreshPlaylist();
});


