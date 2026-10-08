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

// --- Audio MIME Normalization: Compatibilidade Nativa Total com iOS Safari & AVPlayer ---
function normalizeAudioMime(mime, filename = '') {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'm4a') return 'audio/mp4';
  if (ext === 'aac') return 'audio/aac';
  if (ext === 'ogg') return 'audio/ogg';
  if (ext === 'flac') return 'audio/flac';

  const m = (mime || '').toLowerCase().trim();
  if (m === 'audio/mp3' || m === 'audio/x-mp3' || m === 'audio/mpg' || m === 'audio/mpeg3') return 'audio/mpeg';
  if (m === 'audio/x-wav' || m === 'audio/wave' || m === 'audio/vnd.wav') return 'audio/wav';
  if (m === 'audio/x-m4a' || m === 'audio/m4a') return 'audio/mp4';
  if (m.startsWith('audio/')) return m;

  return 'audio/mpeg';
}

// --- Helper: Converte arquivo para ArrayBuffer com detecção segura de MIME type ---
async function readFileData(file) {
  const mime = normalizeAudioMime(file.type, file.name);

  let buffer;
  if (file.arrayBuffer) {
    buffer = await file.arrayBuffer();
  } else {
    buffer = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }

  return {
    name: file.name,
    size: file.size || buffer.byteLength,
    type: mime,
    buffer: buffer,
    addedAt: Date.now()
  };
}

// Converte qualquer objeto de faixa (ArrayBuffer, Blob ou legado) em Blob reproduzível e validado
function getTrackBlob(track) {
  if (!track) return null;
  const mime = normalizeAudioMime(track.type, track.name);

  // 1. ArrayBuffer puro ou TypedArray (100% seguro em memória)
  if (track.buffer) {
    if (track.buffer instanceof ArrayBuffer && track.buffer.byteLength > 0) {
      return new Blob([track.buffer], { type: mime });
    }
    if (ArrayBuffer.isView(track.buffer) && track.buffer.byteLength > 0) {
      return new Blob([track.buffer.buffer], { type: mime });
    }
    if (track.buffer.length !== undefined && track.buffer.length > 0) {
      try {
        const u8 = new Uint8Array(track.buffer);
        return new Blob([u8], { type: mime });
      } catch (e) {}
    }
  }

  // 2. Blob / File legado com verificação de integridade
  if (track.blob instanceof Blob && track.blob.size > 0) {
    if (!track.blob.type || track.blob.type === '' || track.blob.type === 'audio/mp3') {
      return new Blob([track.blob], { type: mime });
    }
    return track.blob;
  }

  return null;
}

async function dbAddTracks(trackDataList) {
  const db = await openDatabase();
  const existing = await dbGetAllTracks();
  let maxOrder = existing.length > 0 ? Math.max(...existing.map(t => t.order || 0)) : 0;

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      for (const item of trackDataList) {
        maxOrder++;
        store.add({
          name: item.name,
          size: item.size,
          type: item.type || 'audio/mpeg',
          buffer: item.buffer, // ArrayBuffer puro: 100% serializável no iOS WebKit sem DataCloneError
          order: maxOrder,
          addedAt: item.addedAt || Date.now()
        });
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Transação cancelada"));
    } catch (err) {
      reject(err);
    }
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
let memorySessionTracks = []; // Fallback em memória para iPhone/Safari Private Mode ou falha de quota
let currentIndex = -1;
let currentBlobUrl = null;
let isPlaying = false;
let loopMode = 'single'; // 'single' (infinite loop per track) | 'playlist' (loop all)
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

// --- Load Track & Playback: Sem audioPlayer.load() para evitar AbortError no Safari iOS ---
function loadTrack(index, autoPlay = false) {
  if (index < 0 || index >= playlist.length) return false;

  const track = playlist[index];
  const trackBlob = getTrackBlob(track);

  if (!trackBlob || trackBlob.size === 0) {
    console.warn("Faixa inacessível ou corrompida no dispositivo:", track);
    playlist.splice(index, 1);
    if (track.id && !track.isMemoryOnly) {
      dbDeleteTrack(track.id).catch(() => {});
    }
    renderPlaylistUI();
    if (playlist.length > 0) {
      return loadTrack(Math.min(index, playlist.length - 1), autoPlay);
    } else {
      currentIndex = -1;
      emptyState.classList.remove('hidden');
      trackTitle.textContent = 'NENHUM RITUAL CARREGADO';
      trackMeta.textContent = '// SELECIONE SEUS ÁUDIOS ABAIXO';
      trackIndexBadge.textContent = 'FAIXA [ 0 / 0 ]';
      statusBadge.textContent = '// PRONTO PARA INICIAR 🩸';
      return false;
    }
  }

  currentIndex = index;

  // Clean old URL safely
  if (currentBlobUrl) {
    try { URL.revokeObjectURL(currentBlobUrl); } catch (e) {}
  }

  currentBlobUrl = URL.createObjectURL(trackBlob);
  audioPlayer.src = currentBlobUrl;
  audioPlayer.volume = 1.0;

  // Crucial iOS hardware loop: AVPlayer handles single track repetition in CoreAudio without JS
  audioPlayer.loop = (loopMode === 'single' || playlist.length === 1);

  // UI Updates
  const cleanName = cleanFileName(track.name);
  trackTitle.textContent = cleanName;
  trackMeta.textContent = formatFileSize(track.size || trackBlob.size);
  trackIndexBadge.textContent = `Faixa ${currentIndex + 1} de ${playlist.length}`;
  statusBadge.textContent = isPlaying ? 
    (audioPlayer.loop ? 'Loop Faixa 🔂' : 'Loop Playlist 🔁') : 
    'Pronto para tocar ⏵';

  renderPlaylistUI();

  // Setup MediaSession for iOS Safari Lock Screen
  updateMediaSession(cleanName);

  if (autoPlay) {
    const playPromise = audioPlayer.play();
    if (playPromise !== undefined) {
      playPromise.then(() => {
        setPlayState(true);
      }).catch(err => {
        console.warn("Autoplay bloqueado pelo iOS/Navegador:", err);
        setPlayState(false);
        statusBadge.textContent = 'Toque no Play para iniciar ⏵';
      });
    }
  }

  return true;
}

function setPlayState(playing) {
  isPlaying = playing;
  if (playing) {
    iconPlay.classList.add('hidden');
    iconPause.classList.remove('hidden');
    visualizerDisc.classList.add('playing');
    document.querySelector('.visualizer-wrapper').classList.add('playing');
    statusBadge.textContent = (loopMode === 'single' || playlist.length === 1) ? 'Loop Faixa 🔂' : 'Loop Playlist 🔁';
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

  const baseHref = window.location.href.split('?')[0].split('#')[0].replace(/\/[^\/]*$/, '/');
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title || 'Pendragon Maximization System',
      artist: 'Pendragon Maximization System',
      album: 'Pendragon Biokinesis Loop',
      artwork: [
        { src: baseHref + 'icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: baseHref + 'icon-192.png', sizes: '192x192', type: 'image/png' }
      ]
    });
  } catch (e) {
    console.warn("MediaSession metadata warning:", e);
  }

  navigator.mediaSession.setActionHandler('play', () => {
    audioPlayer.play().then(() => setPlayState(true)).catch(() => {});
  });

  navigator.mediaSession.setActionHandler('pause', () => {
    audioPlayer.pause();
    setPlayState(false);
  });

  navigator.mediaSession.setActionHandler('stop', () => {
    audioPlayer.pause();
    audioPlayer.currentTime = 0;
    setPlayState(false);
  });

  navigator.mediaSession.setActionHandler('previoustrack', playPrevTrack);
  navigator.mediaSession.setActionHandler('nexttrack', playNextTrack);

  try {
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime !== undefined && details.seekTime !== null && audioPlayer.duration) {
        audioPlayer.currentTime = details.seekTime;
        updateMediaSessionPosition();
      }
    });
    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
      audioPlayer.currentTime = Math.max(0, audioPlayer.currentTime - (details.seekOffset || 10));
      updateMediaSessionPosition();
    });
    navigator.mediaSession.setActionHandler('seekforward', (details) => {
      audioPlayer.currentTime = Math.min(audioPlayer.duration, audioPlayer.currentTime + (details.seekOffset || 10));
      updateMediaSessionPosition();
    });
  } catch (e) {
    // Alguns navegadores ignoram seek
  }
}

function updateMediaSessionPosition() {
  if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
    if (audioPlayer.duration && !isNaN(audioPlayer.duration) && isFinite(audioPlayer.duration)) {
      try {
        navigator.mediaSession.setPositionState({
          duration: Math.max(0.1, audioPlayer.duration),
          playbackRate: audioPlayer.playbackRate || 1,
          position: Math.min(Math.max(0, audioPlayer.currentTime), audioPlayer.duration)
        });
      } catch (e) {}
    }
  }
}

// Native audio listeners for 100% lockscreen / headphones hardware button sync
audioPlayer.addEventListener('play', () => {
  setPlayState(true);
  updateMediaSessionPosition();
});

audioPlayer.addEventListener('pause', () => {
  if (isPlaying && !audioPlayer.seeking) {
    setPlayState(false);
  }
  updateMediaSessionPosition();
});

// Recuperação automática de erro do elemento de áudio no iOS Safari
audioPlayer.addEventListener('error', (e) => {
  const err = audioPlayer.error;
  console.warn("Audio element error detectado:", err);
  if (err && currentIndex >= 0 && currentIndex < playlist.length) {
    statusBadge.textContent = 'Reconectando áudio ⏵';
    setTimeout(() => {
      loadTrack(currentIndex, isPlaying);
    }, 400);
  }
});

// Screen lock & background sync
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (isPlaying && audioPlayer.paused) {
      audioPlayer.play().catch(() => {});
    }
    setPlayState(!audioPlayer.paused);
  }
});

// --- Continuous Seamless Loop (Hardware + Software) ---
audioPlayer.addEventListener('ended', () => {
  if (playlist.length === 0) return;

  if (loopMode === 'single' || playlist.length === 1) {
    // Loop only this track (fallback if native loop did not catch)
    audioPlayer.currentTime = 0;
    audioPlayer.play().catch(e => console.warn("Fallback loop single:", e));
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

  if (!isScrubbing) {
    progressBarFill.style.width = `${pct}%`;
    progressThumb.style.left = `${pct}%`;
    currentTimeDisplay.textContent = formatTime(current);
  }
  updateMediaSessionPosition();
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

// --- Play / Pause & Hardware Gesture Audio Triggers ---
function togglePlayPause() {
  ensureAudioContext();

  if (playlist.length === 0) {
    fileInput.click();
    return;
  }

  // Se nenhuma faixa selecionada ou índice fora dos limites, posiciona na primeira
  if (currentIndex < 0 || currentIndex >= playlist.length) {
    currentIndex = 0;
  }

  // Se audioPlayer não tiver src ou src estiver vazio ou com erro, recarrega a faixa
  if (!audioPlayer.src || audioPlayer.src === '' || audioPlayer.error) {
    loadTrack(currentIndex, false);
  }

  if (audioPlayer.paused) {
    audioPlayer.volume = 1.0;
    audioPlayer.loop = (loopMode === 'single' || playlist.length === 1);

    const playPromise = audioPlayer.play();
    if (playPromise !== undefined) {
      playPromise.then(() => {
        setPlayState(true);
      }).catch(err => {
        console.warn("Falha inicial ao reproduzir áudio:", err);

        // Recuperação inteligente para iOS Safari:
        // Se a URL do Blob expirou ou o player desincronizou, recria a URL imediatamente e tenta de novo
        const track = playlist[currentIndex];
        const freshBlob = getTrackBlob(track);
        if (freshBlob && freshBlob.size > 0) {
          if (currentBlobUrl) {
            try { URL.revokeObjectURL(currentBlobUrl); } catch (e) {}
          }
          currentBlobUrl = URL.createObjectURL(freshBlob);
          audioPlayer.src = currentBlobUrl;
          audioPlayer.play().then(() => {
            setPlayState(true);
          }).catch(retryErr => {
            console.error("Tentativa secundária falhou:", retryErr);
            statusBadge.textContent = 'Toque no Play novamente ⏵';
            setPlayState(false);
          });
        } else {
          statusBadge.textContent = 'Toque no Play para iniciar ⏵';
          setPlayState(false);
        }
      });
    }
  } else {
    audioPlayer.pause();
    setPlayState(false);
  }
}

function handlePlayTrigger(e) {
  if (e) {
    e.preventDefault();
  }
  togglePlayPause();
}

// Botão Play/Pause principal (Click + Touch)
btnPlayPause.addEventListener('click', handlePlayTrigger);
btnPlayPause.addEventListener('touchend', handlePlayTrigger);

// Toque direto no Disco Central (Animação Vampírica)
if (visualizerDisc) {
  visualizerDisc.addEventListener('click', handlePlayTrigger);
  visualizerDisc.addEventListener('touchend', handlePlayTrigger);
}

// Toque na área do Vórtice / Turbilhão
const turbilhaoRotatorEl = document.getElementById('turbilhaoRotator');
if (turbilhaoRotatorEl) {
  turbilhaoRotatorEl.addEventListener('click', handlePlayTrigger);
  turbilhaoRotatorEl.addEventListener('touchend', handlePlayTrigger);
}

function playNextTrack(e) {
  if (e) e.preventDefault();
  if (playlist.length === 0) return;
  const nextIdx = (currentIndex + 1) % playlist.length;
  loadTrack(nextIdx, true);
}

function playPrevTrack(e) {
  if (e) e.preventDefault();
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
btnNext.addEventListener('touchend', playNextTrack);
btnPrev.addEventListener('click', playPrevTrack);
btnPrev.addEventListener('touchend', playPrevTrack);

// --- Loop Mode Toggle ---
btnLoopMode.addEventListener('click', () => {
  if (loopMode === 'single') {
    loopMode = 'playlist';
    loopIcon.textContent = '🔁';
    loopText.textContent = 'LOOP PLAYLIST';
  } else {
    loopMode = 'single';
    loopIcon.textContent = '🔂';
    loopText.textContent = 'LOOP FAIXA';
  }
  audioPlayer.loop = (loopMode === 'single' || playlist.length === 1);
  if (isPlaying) {
    statusBadge.textContent = (loopMode === 'single' || playlist.length === 1) ? 'Loop Faixa 🔂' : 'Loop Playlist 🔁';
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

// --- Higienização e Migração de Faixas: Elimina Registros Corrompidos do Safari WebKit ---
async function migrateAndCleanTracks(dbTracks) {
  const validTracks = [];
  for (const track of dbTracks) {
    // 1. Já possui ArrayBuffer válido com bytes
    if (track.buffer && (track.buffer instanceof ArrayBuffer || track.buffer.byteLength > 0)) {
      validTracks.push(track);
      continue;
    }

    // 2. Faixa legada com Blob: resgata bytes se ainda válidos
    if (track.blob instanceof Blob && track.blob.size > 0) {
      try {
        const buf = await track.blob.arrayBuffer();
        if (buf && buf.byteLength > 0) {
          track.buffer = buf;
          const db = await openDatabase();
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).put({
            id: track.id,
            name: track.name,
            size: track.size || buf.byteLength,
            type: normalizeAudioMime(track.type, track.name),
            buffer: buf,
            order: track.order || 1,
            addedAt: track.addedAt || Date.now()
          });
          validTracks.push(track);
          continue;
        }
      } catch (err) {
        console.warn("Falha ao recuperar faixa antiga do IndexedDB:", track.name, err);
      }
    }

    // 3. Faixa corrompida (0 bytes ou handle destruído pelo WebKit IDB bug): purga do IndexedDB
    console.warn("Removendo registro corrompido do IndexedDB:", track.name);
    try {
      await dbDeleteTrack(track.id);
    } catch (e) {}
  }
  return validTracks;
}

// --- Playlist Management & UI ---
async function refreshPlaylist() {
  let dbTracks = [];
  try {
    const rawTracks = await dbGetAllTracks();
    dbTracks = await migrateAndCleanTracks(rawTracks);
  } catch (e) {
    console.warn("IndexedDB indisponível ou restrito:", e);
  }

  // Combina faixas persistidas no IndexedDB com faixas da memória da sessão
  playlist = [...dbTracks, ...memorySessionTracks];
  tracksCount.textContent = `${playlist.length} ${playlist.length === 1 ? 'áudio' : 'áudios'}`;

  if (playlist.length === 0) {
    emptyState.classList.remove('hidden');
    trackTitle.textContent = 'NENHUM RITUAL CARREGADO';
    trackMeta.textContent = '// SELECIONE SEUS ÁUDIOS ABAIXO';
    trackIndexBadge.textContent = 'FAIXA [ 0 / 0 ]';
    statusBadge.textContent = '// PRONTO PARA INICIAR 🩸';
    currentIndex = -1;
  } else {
    emptyState.classList.add('hidden');
    if (currentIndex === -1 || currentIndex >= playlist.length) {
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
          <div class="item-sub">${formatFileSize(track.size)} ${track.isMemoryOnly ? '• Sessão' : ''}</div>
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
      if (track.isMemoryOnly || typeof trackId === 'string') {
        memorySessionTracks = memorySessionTracks.filter(t => t.id !== trackId);
      } else {
        await dbDeleteTrack(trackId).catch(() => {});
      }
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

// File input selection: Processamento de áudio com suporte total ao iOS Safari & Fallback em Memória
fileInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  if (files.length === 0) return;

  statusBadge.textContent = 'Carregando áudio...';
  const initialPlaylistLength = playlist.length;

  try {
    // 1. Converte arquivos em ArrayBuffers limpos (evita DataCloneError no iOS WebKit)
    const processedTracks = [];
    for (const file of files) {
      try {
        const item = await readFileData(file);
        processedTracks.push(item);
      } catch (readErr) {
        console.warn("Leitura em ArrayBuffer falhou, mantendo arquivo bruto:", readErr);
        processedTracks.push({
          name: file.name,
          size: file.size,
          type: file.type || 'audio/mpeg',
          blob: file,
          addedAt: Date.now()
        });
      }
    }

    // 2. Tenta salvar no IndexedDB de forma segura
    let idbSuccess = false;
    try {
      await dbAddTracks(processedTracks);
      idbSuccess = true;
    } catch (idbErr) {
      console.warn("IndexedDB indisponível ou com restrição no Safari (Modo Anônimo/Quota), ativando modo memória:", idbErr);
      // Fallback em memória para iPhone/Safari Private Mode ou restrição de quota
      for (const trackItem of processedTracks) {
        const trackBlob = trackItem.buffer ? 
          new Blob([trackItem.buffer], { type: trackItem.type || 'audio/mpeg' }) : 
          trackItem.blob;
        memorySessionTracks.push({
          id: 'mem_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
          name: trackItem.name,
          size: trackItem.size,
          type: trackItem.type || 'audio/mpeg',
          blob: trackBlob,
          isMemoryOnly: true,
          addedAt: Date.now()
        });
      }
    }

    await refreshPlaylist();
    if (playlist.length > 0) {
      loadTrack(initialPlaylistLength, false);
      statusBadge.textContent = 'Toque no Play para iniciar ⏵';
      // Tenta iniciar a reprodução imediatamente
      audioPlayer.play().then(() => setPlayState(true)).catch(() => {
        statusBadge.textContent = 'Toque no Play para iniciar ⏵';
      });
    }
  } catch (err) {
    console.error("Erro ao processar áudios:", err);
    // Fallback de emergência absoluto: insere arquivos diretamente na memória
    for (const file of files) {
      memorySessionTracks.push({
        id: 'mem_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        name: file.name,
        size: file.size,
        type: normalizeAudioMime(file.type, file.name),
        blob: file,
        isMemoryOnly: true,
        addedAt: Date.now()
      });
    }
    await refreshPlaylist();
    if (playlist.length > 0) {
      loadTrack(initialPlaylistLength, false);
      statusBadge.textContent = 'Toque no Play para iniciar ⏵';
      audioPlayer.play().then(() => setPlayState(true)).catch(() => {
        statusBadge.textContent = 'Toque no Play para iniciar ⏵';
      });
    }
  } finally {
    fileInput.value = '';
  }
});

// --- PWA Service Worker Registration & Live Cloud Sync ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      console.log('Service Worker registrado:', reg.scope);
      reg.update();
    }).catch(err => {
      console.log('Falha ao registrar Service Worker:', err);
    });
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Nova versão do PWA ativa na nuvem: atualiza a página para sincronia total
    window.location.reload();
  });
}

// Botão de carregar Frequência Instantânea 528Hz (1.4MB, ultrarrápido)
const btnLoadFreq528 = document.getElementById('btnLoadFreq528');
if (btnLoadFreq528) {
  btnLoadFreq528.addEventListener('click', async () => {
    btnLoadFreq528.disabled = true;
    btnLoadFreq528.textContent = 'Sintonizando 528Hz...';
    try {
      const res = await fetch('Frequencia_528Hz_Regeneracao.wav');
      if (!res.ok) throw new Error('Falha ao carregar áudio 528Hz');
      const arrayBuf = await res.arrayBuffer();
      const item = {
        name: 'Frequência 528Hz Regeneração Celular.wav',
        size: arrayBuf.byteLength,
        type: 'audio/wav',
        buffer: arrayBuf,
        addedAt: Date.now()
      };
      try {
        await dbAddTracks([item]);
      } catch (err) {
        memorySessionTracks.push({
          id: 'mem_' + Date.now(),
          name: item.name,
          size: item.size,
          type: item.type,
          blob: new Blob([item.buffer], { type: item.type }),
          isMemoryOnly: true,
          addedAt: Date.now()
        });
      }
      await refreshPlaylist();
      if (playlist.length > 0) {
        loadTrack(0, false);
        togglePlayPause();
      }
    } catch (e) {
      console.error('Erro ao carregar 528Hz:', e);
      statusBadge.textContent = 'Erro ao carregar frequência';
    } finally {
      btnLoadFreq528.disabled = false;
      btnLoadFreq528.textContent = '⚡ ATIVAR FREQUÊNCIA 528Hz: REGENERAÇÃO SUPREMA [INSTANTÂNEO]';
    }
  });
}

// Botão de carregar áudios de demonstração (Trilogia Vampírica com Carregamento Progressivo)
const btnLoadDemo = document.getElementById('btnLoadDemo');
if (btnLoadDemo) {
  btnLoadDemo.addEventListener('click', async () => {
    btnLoadDemo.disabled = true;
    btnLoadDemo.textContent = 'Invocando Vlad [Faixa 1/3]...';
    try {
      const demoFiles = [
        { url: 'playlist/VLAD%20THE%20IMPALER%20100X.wav', name: 'VLAD THE IMPALER 100X.wav' },
        { url: 'playlist/VAMPYRiC%20G%C3%98D%20V2%201000X%20~%20CALM.wav', name: 'VAMPYRiC GØD V2 1000X ~ CALM.wav' },
        { url: 'playlist/VAMPYRiC%20PUNK%20V2%201000X%20~%20CALM.wav', name: 'VAMPYRiC PUNK V2 1000X ~ CALM.wav' }
      ];

      // 1. Carrega e ativa a primeira faixa imediatamente!
      const first = demoFiles[0];
      const res1 = await fetch(first.url);
      if (!res1.ok) throw new Error(`Falha ao buscar ${first.url}`);
      const buf1 = await res1.arrayBuffer();
      const item1 = {
        name: first.name,
        size: buf1.byteLength,
        type: 'audio/wav',
        buffer: buf1,
        addedAt: Date.now()
      };

      try {
        await dbAddTracks([item1]);
      } catch (err) {
        memorySessionTracks.push({
          id: 'mem_' + Date.now(),
          name: item1.name,
          size: item1.size,
          type: item1.type,
          blob: new Blob([item1.buffer], { type: item1.type }),
          isMemoryOnly: true,
          addedAt: Date.now()
        });
      }

      await refreshPlaylist();
      if (playlist.length > 0) {
        loadTrack(0, false);
        togglePlayPause();
      }

      // 2. Baixa as faixas 2 e 3 em segundo plano sem travar a reprodução
      btnLoadDemo.textContent = 'Baixando faixas restantes...';
      for (let i = 1; i < demoFiles.length; i++) {
        const item = demoFiles[i];
        try {
          const res = await fetch(item.url);
          if (res.ok) {
            const buf = await res.arrayBuffer();
            const trackItem = {
              name: item.name,
              size: buf.byteLength,
              type: 'audio/wav',
              buffer: buf,
              addedAt: Date.now()
            };
            try {
              await dbAddTracks([trackItem]);
            } catch (e) {
              memorySessionTracks.push({
                id: 'mem_' + Date.now() + '_' + i,
                name: trackItem.name,
                size: trackItem.size,
                type: trackItem.type,
                blob: new Blob([trackItem.buffer], { type: trackItem.type }),
                isMemoryOnly: true,
                addedAt: Date.now()
              });
            }
            await refreshPlaylist();
          }
        } catch (e) {
          console.warn("Erro ao carregar faixa adicional:", item.name, e);
        }
      }
    } catch (e) {
      console.error('Erro ao carregar rituais:', e);
      alert('Não foi possível carregar a trilogia completa no momento. Você pode adicionar seus próprios áudios pelo botão "INJETAR"!');
    } finally {
      btnLoadDemo.disabled = false;
      btnLoadDemo.textContent = '🩸 ATIVAR TRILOGIA: VLAD / GØD / PUNK [1000X]';
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

// --- Web Audio API: Sincronização Cimática & Proteção de Áudio em Segundo Plano ---
const isMobileOrIOS = /iPad|iPhone|iPod|Android/i.test(navigator.userAgent) || 
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let audioCtx = null;
let analyser = null;
let audioSource = null;
let dataArray = null;
let isAudioContextReady = false;

function ensureAudioContext() {
  // ARQUITETURA CRÍTICA PARA IOS SAFARI / BLOQUEIO DE TELA:
  // No iOS Safari, chamar createMediaElementSource(audioPlayer) desconecta o áudio do hardware nativo
  // e o envia para o grafo do Web Audio. Quando o celular bloqueia a tela, o iOS suspende o Web Audio
  // e silencia completamente qualquer saída de áudio!
  // Deixando o audioPlayer como elemento nativo HTML5 puro no celular, o AVPlayer do iOS assume
  // diretamente o hardware CoreAudio, tocando 100% contínuo, ininterrupto e sem falhas com a tela bloqueada 24h!
  if (isMobileOrIOS) {
    isAudioContextReady = true;
    return;
  }

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

// Universal iOS Audio Pipeline Unlocker: Acorda o subsistema AVPlayer no primeiro toque do usuário
let isAudioPipelineUnlocked = false;
function unlockCoreAudioPipeline() {
  if (isAudioPipelineUnlocked) return;
  isAudioPipelineUnlocked = true;

  try {
    const silentAudio = new Audio();
    // 48-byte RIFF/WAV de silêncio para aquecer o canal CoreAudio no iOS Safari
    silentAudio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFRm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
    silentAudio.volume = 0.01;
    const p = silentAudio.play();
    if (p !== undefined) {
      p.then(() => {
        silentAudio.pause();
        silentAudio.removeAttribute('src');
      }).catch(() => {});
    }
  } catch (e) {}

  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
}

['touchstart', 'touchend', 'click'].forEach(evt => {
  document.addEventListener(evt, unlockCoreAudioPipeline, { passive: true, once: true });
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


