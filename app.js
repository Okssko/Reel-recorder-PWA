'use strict';

/* =========================================================
   Reel — a small studio recorder PWA
   Sections:
   0. Lock screen
   1. Service worker + install prompt
   2. Cloud API (the tape library — Postgres + Blob via /api/takes)
   3. VU meters (SVG dial + needle)
   4. Recording engine (getUserMedia + MediaRecorder + AnalyserNode)
   5. Live waveform + tape counter
   6. Save / discard flow
   7. Library rendering + playback engine
   ========================================================= */

// ---------- 0. Lock screen ----------
// A local passcode gate, not real security (this is a static app with no
// server-side session) — it just keeps the app from being casually opened
// by anyone who picks up the device. Anyone reading the source could bypass it.

const LOCK_PASSCODE_HASH = '1af4e3e00aebf31f373d63327170a073aaa07ecaacb540826dabdce1aacce849'; // default passcode: oksana2026
const LOCK_STORAGE_KEY = 'reel_unlocked_until';

const lockOverlay = document.getElementById('lock-overlay');
const lockForm = document.getElementById('lock-form');
const lockInput = document.getElementById('lock-input');
const lockError = document.getElementById('lock-error');
const lockRememberCheck = document.getElementById('lock-remember-check');
const lockBtn = document.getElementById('lock-btn');

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isUnlocked() {
  const until = Number(localStorage.getItem(LOCK_STORAGE_KEY) || 0);
  return Date.now() < until;
}

function showLock() {
  lockOverlay.classList.remove('hidden');
  lockInput.value = '';
  lockError.textContent = '';
  setTimeout(() => lockInput.focus(), 50);
}

function hideLock() {
  lockOverlay.classList.add('hidden');
}

if (isUnlocked()) {
  hideLock();
} else {
  showLock();
}

lockForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const entered = lockInput.value.trim();
  const hash = await sha256Hex(entered);
  if (hash === LOCK_PASSCODE_HASH) {
    const days = lockRememberCheck.checked ? 7 : 0;
    const until = Date.now() + days * 24 * 60 * 60 * 1000;
    localStorage.setItem(LOCK_STORAGE_KEY, String(until));
    sessionStorage.setItem('reel_api_passcode', entered);
    hideLock();
    renderLibrary();
  } else {
    lockError.textContent = 'Wrong passcode — try again.';
    lockInput.value = '';
    lockInput.focus();
  }
});

lockBtn.addEventListener('click', () => {
  localStorage.removeItem(LOCK_STORAGE_KEY);
  sessionStorage.removeItem('reel_api_passcode');
  showLock();
});

// ---------- 1. Service worker + install prompt ----------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

let deferredInstallPrompt = null;
const installBtn = document.getElementById('install-btn');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  installBtn.classList.add('show');
});

installBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installBtn.classList.remove('show');
});

window.addEventListener('appinstalled', () => {
  installBtn.classList.remove('show');
});

// ---------- 2. Cloud API (the tape library) ----------

const API_BASE = '/api/takes';

function getApiPasscode() {
  return sessionStorage.getItem('reel_api_passcode') || '';
}

async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-reel-passcode': getApiPasscode(),
      ...(options.headers || {})
    }
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.status === 204 ? null : res.json();
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function dbAdd(record) {
  const audioBase64 = await blobToBase64(record.blob);
  const saved = await apiFetch(API_BASE, {
    method: 'POST',
    body: JSON.stringify({
      name: record.name,
      mimeType: record.mimeType,
      duration: record.duration,
      peaks: record.peaks,
      audioBase64
    })
  });
  return saved.id;
}

async function dbGetAll() {
  const rows = await apiFetch(API_BASE);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    duration: r.duration,
    mimeType: r.mime_type,
    blobUrl: r.blob_url,
    peaks: r.peaks,
    createdAt: Number(r.created_at)
  }));
}

async function dbUpdate(record) {
  await apiFetch(`${API_BASE}/${record.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: record.name })
  });
}

async function dbDelete(id) {
  await apiFetch(`${API_BASE}/${id}`, { method: 'DELETE' });
}

// ---------- 3. VU meters ----------

function buildVUDial(svg) {
  const ns = 'http://www.w3.org/2000/svg';
  const cx = 64, cy = 74, r = 58;
  const startDeg = -130, endDeg = -50; // sweep above pivot

  function pt(deg, rad) {
    const a = (deg * Math.PI) / 180;
    return [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  }

  const face = document.createElementNS(ns, 'path');
  const [fx1, fy1] = pt(startDeg, r);
  const [fx2, fy2] = pt(endDeg, r);
  face.setAttribute('d', `M ${fx1} ${fy1} A ${r} ${r} 0 0 1 ${fx2} ${fy2}`);
  face.setAttribute('fill', 'none');
  face.setAttribute('stroke', 'rgba(231,224,211,0.14)');
  face.setAttribute('stroke-width', '2');
  svg.appendChild(face);

  const zoneStart = startDeg + (endDeg - startDeg) * 0.78;
  const [zx1, zy1] = pt(zoneStart, r);
  const zone = document.createElementNS(ns, 'path');
  zone.setAttribute('d', `M ${zx1} ${zy1} A ${r} ${r} 0 0 1 ${fx2} ${fy2}`);
  zone.setAttribute('fill', 'none');
  zone.setAttribute('stroke', '#b23b2e');
  zone.setAttribute('stroke-width', '2');
  svg.appendChild(zone);

  for (let i = 0; i <= 10; i++) {
    const deg = startDeg + ((endDeg - startDeg) * i) / 10;
    const [x1, y1] = pt(deg, r + 3);
    const [x2, y2] = pt(deg, r + (i % 5 === 0 ? 10 : 6));
    const tick = document.createElementNS(ns, 'line');
    tick.setAttribute('x1', x1); tick.setAttribute('y1', y1);
    tick.setAttribute('x2', x2); tick.setAttribute('y2', y2);
    tick.setAttribute('stroke', i >= 8 ? '#b23b2e' : 'rgba(231,224,211,0.4)');
    tick.setAttribute('stroke-width', i % 5 === 0 ? '1.6' : '1');
    svg.appendChild(tick);
  }

  const pivot = document.createElementNS(ns, 'circle');
  pivot.setAttribute('cx', cx); pivot.setAttribute('cy', cy);
  pivot.setAttribute('r', 4);
  pivot.setAttribute('fill', '#c9a227');
  svg.appendChild(pivot);

  const needle = document.createElementNS(ns, 'line');
  needle.setAttribute('class', 'needle');
  needle.setAttribute('x1', cx); needle.setAttribute('y1', cy);
  const [nx, ny] = pt(startDeg, r - 6);
  needle.setAttribute('x2', nx); needle.setAttribute('y2', ny);
  needle.setAttribute('stroke', '#e6c355');
  needle.setAttribute('stroke-width', '2');
  needle.setAttribute('stroke-linecap', 'round');
  svg.appendChild(needle);

  return { needle, startDeg, endDeg, cx, cy };
}

const vuL = buildVUDial(document.getElementById('vu-svg-l'));
const vuR = buildVUDial(document.getElementById('vu-svg-r'));

function setNeedle(vu, level01) {
  const clamped = Math.max(0, Math.min(1, level01));
  const deg = vu.startDeg + (vu.endDeg - vu.startDeg) * clamped;
  vu.needle.style.transform = `rotate(${deg - vu.startDeg}deg)`;
  vu.needle.setAttribute('transform', `rotate(${deg} ${vu.cx} ${vu.cy})`);
}

function decayNeedles() {
  setNeedle(vuL, 0);
  setNeedle(vuR, 0);
}
decayNeedles();

// ---------- 4. Recording engine ----------

let audioCtx = null;
let micStream = null;
let sourceNode = null;
let analyserNode = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordingState = 'idle'; // idle | recording | preview
let recordStartTime = 0;
let recordElapsedBeforePause = 0;
let liveMeterRAF = null;
let counterRAF = null;
let currentTakeBlob = null;
let currentTakeDuration = 0;
let currentTakeMimeType = '';

let recordSource = 'mic'; // 'mic' | 'display'
const sourceToggle = document.getElementById('source-toggle');
const sourceHint = document.getElementById('source-hint');
const SOURCE_HINTS = {
  mic: 'Records whatever your microphone picks up.',
  display: 'Records audio straight from a tab, window, or your whole screen — no mic, no room noise.'
};

sourceToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.src-btn');
  if (!btn || recordingState !== 'idle') return;
  recordSource = btn.dataset.src;
  sourceToggle.querySelectorAll('.src-btn').forEach((b) => b.classList.toggle('active', b === btn));
  sourceHint.textContent = SOURCE_HINTS[recordSource];
});

const btnRecord = document.getElementById('btn-record');
const btnSave = document.getElementById('btn-save');
const btnDiscard = document.getElementById('btn-discard');
const statusDot = document.getElementById('status-dot');
const counterEl = document.getElementById('counter');
const saveHint = document.getElementById('save-hint');
const nameRow = document.getElementById('name-row');
const nameInput = document.getElementById('take-name-input');
const liveWaveCanvas = document.getElementById('live-wave');
const liveWaveCtx = liveWaveCanvas.getContext('2d');

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, rect.width * dpr);
  canvas.height = Math.max(1, rect.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function pickMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus'
  ];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) {
      return c;
    }
  }
  return '';
}

async function startMicCapture() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true, noiseSuppression: false, autoGainControl: false
    }});
    return true;
  } catch (err) {
    saveHint.textContent = 'Microphone access was blocked — allow it in your browser settings to record.';
    return false;
  }
}

async function startDisplayCapture() {
  if (!navigator.mediaDevices.getDisplayMedia) {
    saveHint.textContent = 'This browser can\u2019t capture tab/system audio — try Chrome or Edge on desktop.';
    return false;
  }
  let displayStream;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
  } catch (err) {
    saveHint.textContent = 'Sharing was cancelled — pick a tab/screen and tick "Share audio" to record it.';
    return false;
  }

  const audioTracks = displayStream.getAudioTracks();
  displayStream.getVideoTracks().forEach((t) => t.stop());

  if (audioTracks.length === 0) {
    saveHint.textContent = 'No audio was shared — when picking a source, tick the "Share tab audio" (or "Share system audio") checkbox.';
    return false;
  }

  micStream = new MediaStream(audioTracks);
  audioTracks[0].addEventListener('ended', () => {
    if (recordingState === 'recording') stopRecording();
  });
  return true;
}

async function startRecording() {
  if (recordSource === 'display') {
    const ok = await startDisplayCapture();
    if (!ok) return;
  } else {
    const ok = await startMicCapture();
    if (!ok) return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  sourceNode = audioCtx.createMediaStreamSource(micStream);
  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = 1024;
  analyserNode.smoothingTimeConstant = 0.75;
  sourceNode.connect(analyserNode);

  const mimeType = pickMimeType();
  currentTakeMimeType = mimeType || 'audio/webm';
  recordedChunks = [];
  try {
    mediaRecorder = mimeType ? new MediaRecorder(micStream, { mimeType }) : new MediaRecorder(micStream);
  } catch (err) {
    mediaRecorder = new MediaRecorder(micStream);
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    currentTakeBlob = new Blob(recordedChunks, { type: currentTakeMimeType });
    enterPreviewMode();
  };

  mediaRecorder.start(100);
  recordingState = 'recording';
  recordStartTime = performance.now();
  recordElapsedBeforePause = 0;

  btnRecord.classList.add('recording');
  statusDot.classList.add('rec');
  statusDot.classList.remove('play');
  saveHint.textContent = 'Recording…';
  nameRow.style.display = 'none';
  btnSave.disabled = true;
  btnDiscard.disabled = false;
  sourceToggle.querySelectorAll('.src-btn').forEach((b) => (b.disabled = true));

  fitCanvas(liveWaveCanvas);
  runLiveMeter();
  runCounter();
}

function stopRecording() {
  if (mediaRecorder && recordingState === 'recording') {
    mediaRecorder.stop();
  }
  cancelAnimationFrame(liveMeterRAF);
  cancelAnimationFrame(counterRAF);
  decayNeedles();
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close();
}

function enterPreviewMode() {
  recordingState = 'preview';
  currentTakeDuration = (performance.now() - recordStartTime) / 1000;
  btnRecord.classList.remove('recording');
  statusDot.classList.remove('rec');
  saveHint.textContent = 'Take captured — name it and save, or discard.';
  nameRow.style.display = 'flex';
  nameInput.value = `Take ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  nameInput.focus();
  nameInput.select();
  btnSave.disabled = false;
  btnDiscard.disabled = false;
}

function resetToIdle() {
  recordingState = 'idle';
  currentTakeBlob = null;
  currentTakeDuration = 0;
  btnRecord.classList.remove('recording');
  statusDot.classList.remove('rec', 'play');
  saveHint.textContent = 'Tap the red button to start rolling tape';
  nameRow.style.display = 'none';
  btnSave.disabled = true;
  btnDiscard.disabled = true;
  counterEl.textContent = '00:00.0';
  clearLiveWave();
  sourceToggle.querySelectorAll('.src-btn').forEach((b) => (b.disabled = false));
}

function runLiveMeter() {
  const bufferLength = analyserNode.fftSize;
  const dataArray = new Uint8Array(bufferLength);

  function tick() {
    if (recordingState !== 'recording') return;
    analyserNode.getByteTimeDomainData(dataArray);

    let sumSq = 0;
    for (let i = 0; i < bufferLength; i++) {
      const v = (dataArray[i] - 128) / 128;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / bufferLength);
    const level = Math.min(1, rms * 3.2);

    setNeedle(vuL, level);
    setNeedle(vuR, Math.max(0, Math.min(1, level * (0.9 + Math.random() * 0.15))));

    drawLiveWave(dataArray);

    liveMeterRAF = requestAnimationFrame(tick);
  }
  tick();
}

function clearLiveWave() {
  const w = liveWaveCanvas.getBoundingClientRect().width;
  const h = liveWaveCanvas.getBoundingClientRect().height;
  liveWaveCtx.clearRect(0, 0, w, h);
  liveWaveCtx.strokeStyle = 'rgba(231,224,211,0.15)';
  liveWaveCtx.beginPath();
  liveWaveCtx.moveTo(0, h / 2);
  liveWaveCtx.lineTo(w, h / 2);
  liveWaveCtx.stroke();
}

function drawLiveWave(dataArray) {
  const rect = liveWaveCanvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  liveWaveCtx.clearRect(0, 0, w, h);
  liveWaveCtx.beginPath();
  liveWaveCtx.strokeStyle = '#c9a227';
  liveWaveCtx.lineWidth = 1.5;
  const step = dataArray.length / w;
  for (let x = 0; x < w; x++) {
    const idx = Math.floor(x * step);
    const v = (dataArray[idx] - 128) / 128;
    const y = h / 2 + v * (h / 2 - 3);
    if (x === 0) liveWaveCtx.moveTo(x, y);
    else liveWaveCtx.lineTo(x, y);
  }
  liveWaveCtx.stroke();
}

function runCounter() {
  function tick() {
    if (recordingState !== 'recording') return;
    const elapsed = (performance.now() - recordStartTime) / 1000;
    counterEl.textContent = formatTime(elapsed, true);
    counterRAF = requestAnimationFrame(tick);
  }
  tick();
}

function formatTime(seconds, withDeci) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (withDeci) {
    const d = Math.floor((seconds * 10) % 10);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${d}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

btnRecord.addEventListener('click', () => {
  if (recordingState === 'idle') {
    stopAllPlayback();
    startRecording();
  } else if (recordingState === 'recording') {
    stopRecording();
  }
});

btnDiscard.addEventListener('click', () => {
  if (recordingState === 'recording') stopRecording();
  resetToIdle();
});

btnSave.addEventListener('click', async () => {
  if (!currentTakeBlob) return;
  btnSave.disabled = true;
  btnDiscard.disabled = true;
  saveHint.textContent = 'Saving to your library…';

  const peaks = await computePeaks(currentTakeBlob).catch(() => []);
  const name = nameInput.value.trim() || 'Untitled take';

  try {
    await dbAdd({
      name,
      mimeType: currentTakeMimeType,
      blob: currentTakeBlob,
      duration: currentTakeDuration,
      peaks,
      createdAt: Date.now()
    });
    resetToIdle();
    await renderLibrary();
  } catch (err) {
    saveHint.textContent = 'Save failed — check your connection and try again.';
    btnSave.disabled = false;
    btnDiscard.disabled = false;
  }
});

async function computePeaks(blob, targetPoints = 240) {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const channelData = audioBuffer.getChannelData(0);
    const blockSize = Math.max(1, Math.floor(channelData.length / targetPoints));
    const peaks = [];
    for (let i = 0; i < targetPoints; i++) {
      const start = i * blockSize;
      let max = 0;
      for (let j = 0; j < blockSize && start + j < channelData.length; j++) {
        const v = Math.abs(channelData[start + j]);
        if (v > max) max = v;
      }
      peaks.push(max);
    }
    return peaks;
  } finally {
    ctx.close();
  }
}

// ---------- 7. Library rendering + playback ----------

const libCount = document.getElementById('lib-count');
const emptyState = document.getElementById('empty-state');
const reelList = document.getElementById('reel-list');

let sharedAudioEl = null;
let sharedAudioSource = null;
let currentPlayingId = null;
let playbackMeterRAF = null;

function ensureSharedAudio() {
  if (sharedAudioEl) return;
  sharedAudioEl = new Audio();
  sharedAudioEl.preload = 'auto';
  sharedAudioEl.crossOrigin = 'anonymous';

  try {
    const ctx = audioCtx && audioCtx.state !== 'closed' ? audioCtx : new (window.AudioContext || window.webkitAudioContext)();
    audioCtx = ctx;
    sharedAudioSource = ctx.createMediaElementSource(sharedAudioEl);
    const playbackAnalyser = ctx.createAnalyser();
    playbackAnalyser.fftSize = 1024;
    sharedAudioSource.connect(playbackAnalyser);
    playbackAnalyser.connect(ctx.destination);
    sharedAudioEl._analyser = playbackAnalyser;
  } catch (err) {
    // Fallback: if routing through WebAudio fails, still allow plain playback.
  }

  sharedAudioEl.addEventListener('ended', () => {
    stopAllPlayback();
  });
}

function stopAllPlayback() {
  if (sharedAudioEl) sharedAudioEl.pause();
  currentPlayingId = null;
  cancelAnimationFrame(playbackMeterRAF);
  decayNeedles();
  statusDot.classList.remove('play');
  document.querySelectorAll('.reel-play').forEach((btn) => setPlayIcon(btn, false));
}

function setPlayIcon(btn, playing) {
  btn.innerHTML = playing
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
}

function runPlaybackMeter() {
  if (!sharedAudioEl || !sharedAudioEl._analyser) return;
  const analyser = sharedAudioEl._analyser;
  const data = new Uint8Array(analyser.fftSize);

  function tick() {
    if (sharedAudioEl.paused) return;
    analyser.getByteTimeDomainData(data);
    let sumSq = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / data.length);
    const level = Math.min(1, rms * 3.2);
    setNeedle(vuL, level);
    setNeedle(vuR, Math.max(0, Math.min(1, level * (0.9 + Math.random() * 0.15))));
    playbackMeterRAF = requestAnimationFrame(tick);
  }
  tick();
}

async function playTake(record, cardEls) {
  if (recordingState === 'recording') return;

  ensureSharedAudio();
  if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume();

  if (currentPlayingId === record.id) {
    if (sharedAudioEl.paused) {
      sharedAudioEl.play();
      statusDot.classList.add('play');
      runPlaybackMeter();
      setPlayIcon(cardEls.playBtn, true);
    } else {
      sharedAudioEl.pause();
      statusDot.classList.remove('play');
      setPlayIcon(cardEls.playBtn, false);
    }
    return;
  }

  stopAllPlayback();
  sharedAudioEl.src = record.blobUrl;
  currentPlayingId = record.id;
  await sharedAudioEl.play();
  statusDot.classList.add('play');
  runPlaybackMeter();
  setPlayIcon(cardEls.playBtn, true);
}

function drawPeaks(canvas, peaks, progressRatio) {
  fitCanvas(canvas);
  const rect = canvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!peaks || peaks.length === 0) return;

  const barW = w / peaks.length;
  const progressX = w * (progressRatio || 0);

  for (let i = 0; i < peaks.length; i++) {
    const x = i * barW;
    const amp = Math.max(0.04, peaks[i]);
    const barH = amp * (h - 6);
    const y = (h - barH) / 2;
    ctx.fillStyle = x < progressX ? '#e6c355' : 'rgba(201,162,39,0.35)';
    ctx.fillRect(x, y, Math.max(1, barW - 1), barH);
  }
}

async function renderLibrary() {
  let records;
  try {
    records = await dbGetAll();
  } catch (err) {
    emptyState.textContent = 'Could not load your library — check your connection and reload.';
    emptyState.style.display = 'block';
    reelList.innerHTML = '';
    libCount.textContent = '';
    return;
  }

  libCount.textContent = `${records.length} take${records.length === 1 ? '' : 's'}`;
  emptyState.style.display = records.length ? 'none' : 'block';
  reelList.innerHTML = '';

  records.forEach((record) => {
    const card = document.createElement('div');
    card.className = 'reel';
    card.innerHTML = `
      <div class="reel-top">
        <button class="reel-play" title="Play / pause">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>
        <div class="reel-meta">
          <input class="reel-name" value="${escapeAttr(record.name)}" maxlength="60" />
          <div class="reel-sub">${formatTime(record.duration)} · ${new Date(record.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</div>
        </div>
        <div class="reel-actions">
          <button class="dl" title="Download">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 21h16"/></svg>
          </button>
          <button class="del danger" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>
          </button>
        </div>
      </div>
      <div class="reel-confirm" style="display:none;">
        <span>Delete this take?</span>
        <button class="confirm-cancel">Cancel</button>
        <button class="confirm-delete">Delete</button>
      </div>
      <div class="reel-progress"><canvas></canvas><div class="fill"></div></div>
    `;

    const playBtn = card.querySelector('.reel-play');
    const nameEl = card.querySelector('.reel-name');
    const dlBtn = card.querySelector('.dl');
    const delBtn = card.querySelector('.del');
    const progressWrap = card.querySelector('.reel-progress');
    const canvas = progressWrap.querySelector('canvas');
    const fill = progressWrap.querySelector('.fill');

    const cardEls = { playBtn };
    requestAnimationFrame(() => drawPeaks(canvas, record.peaks, 0));

    playBtn.addEventListener('click', () => playTake(record, cardEls));

    nameEl.addEventListener('change', async () => {
      record.name = nameEl.value.trim() || 'Untitled take';
      nameEl.value = record.name;
      await dbUpdate(record);
    });

    dlBtn.addEventListener('click', async () => {
      const ext = record.mimeType.includes('mp4') ? 'm4a' : record.mimeType.includes('ogg') ? 'ogg' : 'webm';
      const res = await fetch(record.blobUrl);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${record.name.replace(/[^a-z0-9 _-]/gi, '') || 'take'}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    });

    const confirmBar = card.querySelector('.reel-confirm');
    const confirmCancel = card.querySelector('.confirm-cancel');
    const confirmDelete = card.querySelector('.confirm-delete');

    delBtn.addEventListener('click', () => {
      confirmBar.style.display = 'flex';
    });

    confirmCancel.addEventListener('click', () => {
      confirmBar.style.display = 'none';
    });

    confirmDelete.addEventListener('click', async () => {
      if (currentPlayingId === record.id) stopAllPlayback();
      await dbDelete(record.id);
      await renderLibrary();
    });

    progressWrap.addEventListener('click', (e) => {
      if (currentPlayingId !== record.id || !sharedAudioEl) return;
      const rect = progressWrap.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      if (sharedAudioEl.duration) sharedAudioEl.currentTime = ratio * sharedAudioEl.duration;
    });

    const syncInterval = setInterval(() => {
      if (!document.body.contains(card)) { clearInterval(syncInterval); return; }
      if (currentPlayingId === record.id && sharedAudioEl && sharedAudioEl.duration) {
        const ratio = sharedAudioEl.currentTime / sharedAudioEl.duration;
        fill.style.width = `${ratio * 100}%`;
        drawPeaks(canvas, record.peaks, ratio);
      }
    }, 120);

    reelList.appendChild(card);
  });
}

function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ---------- Boot ----------

window.addEventListener('resize', () => {
  if (recordingState === 'recording') fitCanvas(liveWaveCanvas);
});

clearLiveWave();
if (isUnlocked()) {
  renderLibrary();
}
// If locked, renderLibrary() runs once the correct passcode is submitted
// (see the lock form's submit handler above).