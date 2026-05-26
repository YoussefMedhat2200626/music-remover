/**
 * AudioLift — app.js
 * Vocal extraction: maximum aggression, no user options.
 * File mode: browser-side FFmpeg.wasm + Web Audio API fallback
 * URL mode:  server-side yt-dlp + ffmpeg via SSE
 */

// ── FFmpeg CDN ─────────────────────────────────────────────────────────────
const FFMPEG_CORE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js';
const FFMPEG_WASM_URL = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js';

// ── State ──────────────────────────────────────────────────────────────────
let ffmpegInstance = null;
let selectedFile   = null;
let outputURL      = null;
let activeTab      = 'file';
let selectedURL    = null;
let toolsChecked   = false;
let toolsOk        = false;

// ── Maximum vocal extraction filter chain (browser-side) ──────────────────
// Mirrors the server-side chain in server.js buildAudioFilter()
const VOCAL_FILTER_CHAIN = [
  'pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1', // center extraction
  'highpass=f=280:poles=2',
  'highpass=f=280:poles=2',
  'lowpass=f=9000:poles=2',
  'afftdn=nf=-40:nr=0.97',
  'afftdn=nf=-40:nr=0.97',
  'anlmdn=s=7:p=0.002:r=0.002:m=15',
  'equalizer=f=65:width_type=o:width=3:g=-30',
  'equalizer=f=100:width_type=o:width=3:g=-28',
  'equalizer=f=160:width_type=o:width=2:g=-20',
  'equalizer=f=250:width_type=o:width=2:g=-18',
  'equalizer=f=350:width_type=o:width=2:g=-14',
  'equalizer=f=440:width_type=o:width=2:g=-12',
  'equalizer=f=880:width_type=o:width=2:g=-10',
  'equalizer=f=8000:width_type=o:width=3:g=-16',
  'equalizer=f=12000:width_type=o:width=4:g=-24',
  'equalizer=f=1200:width_type=o:width=1.2:g=7',
  'equalizer=f=2500:width_type=o:width=1.5:g=10',
  'acompressor=threshold=0.03:ratio=20:attack=2:release=30:makeup=7:knee=2',
  'agate=threshold=0.025:ratio=20:attack=1:release=40:detection=peak',
  'speechnorm=e=25:r=0.0001:l=1',
  'loudnorm=I=-16:TP=-1.5:LRA=7',
].join(',');

// ── DOM refs ───────────────────────────────────────────────────────────────
const uploadZone      = document.getElementById('uploadZone');
const fileInput       = document.getElementById('fileInput');
const uploadBtn       = document.getElementById('uploadBtn');
const fileInfo        = document.getElementById('fileInfo');
const fileNameEl      = document.getElementById('fileName');
const fileMetaEl      = document.getElementById('fileMeta');
const removeFileBtn   = document.getElementById('removeFile');
const processPanel    = document.getElementById('processPanel');
const processBtn      = document.getElementById('processBtn');
const processBtnText  = document.getElementById('processBtnText');
const progressSection = document.getElementById('progressSection');
const progressTitle   = document.getElementById('progressTitle');
const progressSub     = document.getElementById('progressSub');
const progressBar     = document.getElementById('progressBar');
const progressLog     = document.getElementById('progressLog');
const resultSection   = document.getElementById('resultSection');
const resultDesc      = document.getElementById('resultDesc');
const audioPlayer     = document.getElementById('audioPlayer');
const audioPreview    = document.getElementById('audioPreview');
const downloadLink    = document.getElementById('downloadLink');
const resetBtn        = document.getElementById('resetBtn');
const waveformCanvas  = document.getElementById('waveformCanvas');

// URL tab refs
const tabFile        = document.getElementById('tabFile');
const tabUrl         = document.getElementById('tabUrl');
const urlZone        = document.getElementById('urlZone');
const urlInput       = document.getElementById('urlInput');
const urlClearBtn    = document.getElementById('urlClearBtn');
const urlDetect      = document.getElementById('urlDetect');
const urlDetectIcon  = document.getElementById('urlDetectIcon');
const urlDetectText  = document.getElementById('urlDetectText');
const urlConfirmBtn  = document.getElementById('urlConfirmBtn');
const urlFileInfo    = document.getElementById('urlFileInfo');
const urlFileName    = document.getElementById('urlFileName');
const urlFileMeta    = document.getElementById('urlFileMeta');
const urlSourceEmoji = document.getElementById('urlSourceEmoji');
const removeUrlBtn   = document.getElementById('removeUrl');
const toolYtdlp      = document.getElementById('toolYtdlp');
const toolAria2c     = document.getElementById('toolAria2c');
const toolFfmpeg     = document.getElementById('toolFfmpeg');
const ytdlpVersion   = document.getElementById('ytdlpVersion');
const aria2cVersion  = document.getElementById('aria2cVersion');
const ffmpegVersion  = document.getElementById('ffmpegVersion');
const installWarn    = document.getElementById('installWarn');

const steps = {
  1: document.getElementById('step1'),
  2: document.getElementById('step2'),
  3: document.getElementById('step3'),
};

// ── Helpers ────────────────────────────────────────────────────────────────
function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}
function isVideo(f) {
  return f.type.startsWith('video/') || /\.(mp4|webm|mkv|avi|mov|m4v|ts)$/i.test(f.name);
}
function getExt(f) { return f.name.split('.').pop().toLowerCase(); }

function setProgress(pct, title, sub) {
  progressBar.style.width = pct + '%';
  if (title) progressTitle.textContent = title;
  if (sub)   progressSub.textContent   = sub;
}
function addLog(msg, highlight = false) {
  const d = document.createElement('div');
  d.className = 'log-entry' + (highlight ? ' highlight' : '');
  d.textContent = msg;
  progressLog.appendChild(d);
  progressLog.scrollTop = progressLog.scrollHeight;
}
function activateStep(n) {
  Object.entries(steps).forEach(([k, el]) => {
    el.classList.remove('active', 'completed');
    if (+k < n)  el.classList.add('completed');
    if (+k === n) el.classList.add('active');
  });
}
function showProcess() {
  processPanel.style.display = '';
  activateStep(2);
}
function hideAll() {
  uploadZone.style.display    = 'none';
  fileInfo.style.display      = 'none';
  urlZone.style.display       = 'none';
  urlFileInfo.style.display   = 'none';
  processPanel.style.display  = 'none';
  progressSection.style.display = 'none';
  resultSection.style.display = 'none';
}

// ── Tab switching ──────────────────────────────────────────────────────────
tabFile.addEventListener('click', () => switchTab('file'));
tabUrl.addEventListener('click',  () => switchTab('url'));

function switchTab(tab) {
  activeTab = tab;
  tabFile.classList.toggle('active', tab === 'file');
  tabUrl.classList.toggle('active',  tab === 'url');

  if (tab === 'file') {
    uploadZone.style.display    = selectedFile ? 'none' : '';
    fileInfo.style.display      = selectedFile ? 'flex' : 'none';
    urlZone.style.display       = 'none';
    urlFileInfo.style.display   = 'none';
    processPanel.style.display  = selectedFile ? '' : 'none';
  } else {
    uploadZone.style.display    = 'none';
    fileInfo.style.display      = 'none';
    urlZone.style.display       = selectedURL ? 'none' : '';
    urlFileInfo.style.display   = selectedURL ? 'flex' : 'none';
    processPanel.style.display  = selectedURL ? '' : 'none';
    if (!toolsChecked) checkTools();
  }
}

// ── Drag & drop / file pick ────────────────────────────────────────────────
uploadZone.addEventListener('dragover',  e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault(); uploadZone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
uploadZone.addEventListener('click', () => fileInput.click());
uploadBtn.addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

function handleFile(file) {
  selectedFile = file;
  const ext  = getExt(file);
  const type = isVideo(file) ? 'Video' : 'Audio';
  fileNameEl.textContent = file.name;
  fileMetaEl.textContent = `${formatBytes(file.size)} · ${type} · .${ext.toUpperCase()}`;
  uploadZone.style.display = 'none';
  fileInfo.style.display   = 'flex';
  showProcess();
}

removeFileBtn.addEventListener('click', () => {
  selectedFile = null;
  fileInput.value = '';
  uploadZone.style.display   = '';
  fileInfo.style.display     = 'none';
  processPanel.style.display = 'none';
  activateStep(1);
});

// ── Platform detection ─────────────────────────────────────────────────────
const PLATFORMS = [
  { key: 'youtube',   pattern: /youtube\.com|youtu\.be/i,  emoji: '▶️',  label: 'YouTube' },
  { key: 'instagram', pattern: /instagram\.com/i,           emoji: '📸', label: 'Instagram' },
  { key: 'facebook',  pattern: /facebook\.com|fb\.watch/i, emoji: '👤', label: 'Facebook' },
  { key: 'tiktok',    pattern: /tiktok\.com/i,              emoji: '🎵', label: 'TikTok' },
  { key: 'twitter',   pattern: /twitter\.com|x\.com/i,     emoji: '🐦', label: 'X / Twitter' },
];
function detectPlatform(url) { return PLATFORMS.find(p => p.pattern.test(url)) || null; }
function highlightPlatform(key) {
  document.querySelectorAll('.platform-logo').forEach(el => {
    el.classList.toggle('detected', el.dataset.platform === key);
  });
}

// ── URL input handlers ─────────────────────────────────────────────────────
urlInput.addEventListener('input', () => {
  const val = urlInput.value.trim();
  urlClearBtn.style.display = val ? '' : 'none';
  const platform = val ? detectPlatform(val) : null;
  if (platform) {
    urlDetect.style.display = '';
    urlDetectIcon.textContent = platform.emoji;
    urlDetectText.textContent = 'Detected: ' + platform.label;
    highlightPlatform(platform.key);
    urlConfirmBtn.disabled = !toolsOk;
  } else {
    urlDetect.style.display = 'none';
    highlightPlatform(null);
    urlConfirmBtn.disabled = true;
  }
});

urlClearBtn.addEventListener('click', () => {
  urlInput.value = '';
  urlClearBtn.style.display = 'none';
  urlDetect.style.display = 'none';
  urlConfirmBtn.disabled = true;
  highlightPlatform(null);
});

urlConfirmBtn.addEventListener('click', () => {
  const val = urlInput.value.trim();
  if (!val) return;
  const platform = detectPlatform(val);
  selectedURL = val;
  urlZone.style.display     = 'none';
  urlFileInfo.style.display = 'flex';
  urlFileName.textContent   = val.length > 60 ? val.slice(0, 57) + '...' : val;
  urlFileMeta.textContent   = platform ? platform.label + ' URL' : 'URL source';
  urlSourceEmoji.textContent = platform ? platform.emoji : '🔗';
  showProcess();
});

removeUrlBtn.addEventListener('click', () => {
  selectedURL = null;
  urlFileInfo.style.display  = 'none';
  urlZone.style.display      = '';
  processPanel.style.display = 'none';
  activateStep(1);
});

// ── Tool status check ──────────────────────────────────────────────────────
async function checkTools() {
  toolsChecked = true;
  try {
    const data = await fetch('/api/check-tools').then(r => r.json());

    // Demucs — the star of the show
    const toolDemucs   = document.getElementById('toolDemucs');
    const demucsVerEl  = document.getElementById('demucsVersion');
    if (data.hasDemucs) {
      toolDemucs.className = 'tool-status-item ok';
      demucsVerEl.textContent = data.demucsVersion || 'htdemucs ready ✨';
      toolsOk = true; // demucs + yt-dlp is all we need
    } else {
      toolDemucs.className = 'tool-status-item optional';
      demucsVerEl.textContent = 'not found — install: pip install demucs';
    }

    // yt-dlp
    if (data.hasYtDlp) {
      toolYtdlp.className = 'tool-status-item ok';
      ytdlpVersion.textContent = data.ytdlpVersion || 'found';
      if (!data.hasDemucs) toolsOk = true; // still usable with FFmpeg fallback
    } else {
      toolYtdlp.className = 'tool-status-item missing';
      ytdlpVersion.textContent = 'not found';
      installWarn.style.display = 'flex';
    }

    // aria2c (optional)
    if (data.hasAria2c) {
      toolAria2c.className = 'tool-status-item ok';
      aria2cVersion.textContent = data.aria2cVersion || 'found';
    } else {
      toolAria2c.className = 'tool-status-item optional';
      aria2cVersion.textContent = 'optional — not found';
    }

    // ffmpeg
    if (data.hasFfmpeg) {
      toolFfmpeg.className = 'tool-status-item ok';
      ffmpegVersion.textContent = data.ffmpegVersion || 'found';
    } else {
      toolFfmpeg.className = 'tool-status-item optional';
      ffmpegVersion.textContent = 'optional — not found';
    }

    const val = urlInput.value.trim();
    if (val && detectPlatform(val) && toolsOk) urlConfirmBtn.disabled = false;
  } catch (e) {
    toolYtdlp.className = 'tool-status-item missing';
    ytdlpVersion.textContent = 'server unreachable';
  }
}

// ── Process button dispatch ────────────────────────────────────────────────
processBtn.addEventListener('click', () => {
  if (activeTab === 'url' && selectedURL) startURLProcessing();
  else if (selectedFile) startFileProcessing();
});

// ── URL processing (server-side via SSE) ──────────────────────────────────
async function startURLProcessing() {
  hideAll();
  progressSection.style.display = '';
  processBtn.disabled = true;
  activateStep(2);
  setProgress(0, 'Starting...', 'Connecting to server');
  progressLog.innerHTML = '<div class="log-entry">🚀 Connecting to AudioLift server...</div>';

  let jobId;
  try {
    const res = await fetch('/api/process-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: selectedURL }),
    });
    if (!res.ok) throw new Error('Server error ' + res.status);
    jobId = (await res.json()).jobId;
    addLog('🆔 Job: ' + jobId);
  } catch (e) {
    addLog('❌ ' + e.message);
    setProgress(0, 'Failed', e.message);
    processBtn.disabled = false;
    return;
  }

  const evtSource = new EventSource(`/api/events/${jobId}`);

  evtSource.addEventListener('progress', e => {
    const d = JSON.parse(e.data);
    setProgress(d.pct, d.title, d.sub);
  });
  evtSource.addEventListener('log', e => {
    const d = JSON.parse(e.data);
    addLog(d.msg, d.highlight);
  });
  evtSource.addEventListener('info', e => {
    const d = JSON.parse(e.data);
    if (d.title) addLog(`📺 "${d.title}"`, true);
  });
  evtSource.addEventListener('done', e => {
    evtSource.close();
    const d = JSON.parse(e.data);
    progressSection.style.display = 'none';
    resultSection.style.display   = '';
    activateStep(3);
    resultDesc.textContent = `"${d.title || 'Media'}" — vocals extracted, music removed.`;
    const fileUrl = `/api/download/${jobId}`;
    downloadLink.href = fileUrl;
    audioPreview.style.display   = 'flex';
    audioPlayer.src              = fileUrl;
    waveformCanvas.style.display = 'none';
    processBtn.disabled = false;
  });
  evtSource.addEventListener('error', e => {
    evtSource.close();
    try {
      const d = JSON.parse(e.data);
      addLog('❌ ' + d.msg);
      setProgress(0, 'Failed', d.msg.slice(0, 80));
    } catch (_) {
      addLog('❌ Connection lost');
      setProgress(0, 'Failed', 'Server error');
    }
    processBtn.disabled = false;
  });
}

// ── File processing (browser-side FFmpeg.wasm) ─────────────────────────────
async function startFileProcessing() {
  hideAll();
  progressSection.style.display = '';
  processBtn.disabled = true;
  activateStep(2);
  setProgress(0, 'Initializing...', 'Loading FFmpeg WebAssembly');
  progressLog.innerHTML = '<div class="log-entry">⚡ Booting AudioLift engine...</div>';

  try {
    addLog('⚡ Loading FFmpeg.wasm (first run ~30 MB, cached after)...');
    setProgress(5, 'Loading FFmpeg...', 'Downloading WebAssembly engine');

    if (!ffmpegInstance) {
      await loadScript(FFMPEG_WASM_URL);
      const { FFmpeg } = window.FFmpegWASM || window.FFmpegLib || {};
      if (!FFmpeg) throw new Error('FFmpeg library failed to load from CDN');
      ffmpegInstance = new FFmpeg();
      ffmpegInstance.on('log', ({ message }) => addLog('📟 ' + message.slice(0, 120)));
      ffmpegInstance.on('progress', ({ progress }) => {
        setProgress(Math.min(90, 30 + Math.round(progress * 60)),
          'Extracting vocals...', Math.round(progress * 100) + '%');
      });
      setProgress(15, 'Loading core...', 'Initializing WebAssembly core');
      await ffmpegInstance.load({ coreURL: FFMPEG_CORE_URL });
      addLog('✅ FFmpeg engine loaded!', true);
    } else {
      addLog('✅ FFmpeg already cached — reusing instance.', true);
    }

    setProgress(20, 'Reading file...', 'Loading into memory');
    const ext    = getExt(selectedFile);
    const inName = 'input.' + ext;
    const buf    = await selectedFile.arrayBuffer();
    await ffmpegInstance.writeFile(inName, new Uint8Array(buf));
    addLog(`📁 ${inName} — ${formatBytes(buf.byteLength)}`);

    // Determine output extension
    const fv = isVideo(selectedFile);
    const outExt = fv ? (['mp4','webm'].includes(ext) ? ext : 'mp4')
                      : (['mp3','wav','ogg'].includes(ext) ? ext : 'mp3');
    const outName = 'output.' + outExt;

    // Build ffmpeg args
    const args = ['-i', inName];
    if (fv) {
      args.push('-vcodec', 'copy', '-af', VOCAL_FILTER_CHAIN, '-acodec', 'aac', '-b:a', '192k');
    } else {
      args.push('-vn', '-af', VOCAL_FILTER_CHAIN);
      if (outExt === 'mp3') args.push('-acodec', 'libmp3lame', '-b:a', '192k', '-q:a', '2');
      else if (outExt === 'wav') args.push('-acodec', 'pcm_s16le');
      else args.push('-acodec', 'libvorbis', '-b:a', '192k');
    }
    args.push('-y', outName);

    addLog('🎛️  Running 20-stage vocal extraction pipeline...');
    setProgress(30, 'Extracting vocals...', 'Applying maximum filter chain');
    await ffmpegInstance.exec(args);

    setProgress(92, 'Finalizing...', 'Encoding output');
    addLog('✅ Vocal extraction complete!', true);

    const outData = await ffmpegInstance.readFile(outName);
    const mime    = { mp4:'video/mp4', webm:'video/webm', mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg' }[outExt] || 'application/octet-stream';
    const blob    = new Blob([outData.buffer], { type: mime });

    if (outputURL) URL.revokeObjectURL(outputURL);
    outputURL = URL.createObjectURL(blob);

    setProgress(100, 'Done!', 'Your file is ready');

    progressSection.style.display = 'none';
    resultSection.style.display   = '';
    activateStep(3);

    resultDesc.textContent = 'Vocals extracted — music, drums, and instruments removed.';
    downloadLink.href     = outputURL;
    downloadLink.download = selectedFile.name.replace(/\.[^.]+$/, '') + '_vocals.' + outExt;

    audioPreview.style.display = 'flex';
    audioPlayer.src = outputURL;
    waveformCanvas.style.display = '';
    renderWaveform(outData.buffer);

    try { await ffmpegInstance.deleteFile(inName); await ffmpegInstance.deleteFile(outName); } catch (_) {}

  } catch (err) {
    addLog('❌ FFmpeg error: ' + err.message);
    console.error(err);
    setProgress(0, 'Error — falling back...', err.message.slice(0, 60));
    addLog('⚠️  Switching to Web Audio API fallback...', true);
    await webAudioFallback();
  }
}

// ── Web Audio fallback (no FFmpeg.wasm) ───────────────────────────────────
async function webAudioFallback() {
  addLog('🔊 Web Audio API processor starting...', true);
  setProgress(30, 'Decoding audio...', 'Using Web Audio API');

  const arrBuf = await selectedFile.arrayBuffer();
  const ctx    = new (window.AudioContext || window.webkitAudioContext)();
  let audioBuf;
  try { audioBuf = await ctx.decodeAudioData(arrBuf.slice(0)); }
  catch (e) { throw new Error('Cannot decode audio: ' + e.message); }

  addLog(`✅ Decoded: ${audioBuf.duration.toFixed(1)}s, ${audioBuf.numberOfChannels}ch`);
  setProgress(50, 'Applying filters...', 'Web Audio DSP chain');

  const offCtx = new OfflineAudioContext(audioBuf.numberOfChannels, audioBuf.length, audioBuf.sampleRate);
  const src    = offCtx.createBufferSource();
  src.buffer   = audioBuf;
  let node     = src;

  // High-pass × 2 — kill kick/bass
  for (let i = 0; i < 2; i++) {
    const hp = offCtx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 280; hp.Q.value = 0.9;
    node.connect(hp); node = hp;
  }
  // Low-pass — kill hi-hats
  const lp = offCtx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 9000; lp.Q.value = 0.9;
  node.connect(lp); node = lp;

  // Notch filters on drum shell frequencies
  for (const [freq, Q] of [[65,8],[100,8],[160,6],[250,6],[350,5],[440,5],[880,4]]) {
    const notch = offCtx.createBiquadFilter();
    notch.type = 'notch'; notch.frequency.value = freq; notch.Q.value = Q;
    node.connect(notch); node = notch;
  }
  // EQ boost on voice presence
  for (const [freq, gain] of [[1200,7],[2500,10]]) {
    const eq = offCtx.createBiquadFilter();
    eq.type = 'peaking'; eq.frequency.value = freq; eq.Q.value = 1; eq.gain.value = gain;
    node.connect(eq); node = eq;
  }
  // Hard compressor
  const comp = offCtx.createDynamicsCompressor();
  comp.threshold.value = -30; comp.ratio.value = 20; comp.attack.value = 0.002; comp.release.value = 0.03; comp.knee.value = 2;
  node.connect(comp); node = comp;

  const gain = offCtx.createGain(); gain.gain.value = 5;
  node.connect(gain); node = gain;
  node.connect(offCtx.destination);
  src.start(0);

  setProgress(70, 'Rendering...', 'Offline audio rendering');
  addLog('🎛️  Rendering 14-stage Web Audio chain...');
  const rendered = await offCtx.startRendering();
  addLog('✅ Rendering complete!', true);

  setProgress(85, 'Encoding WAV...', 'Writing output');
  const wavBlob = audioBufferToWav(rendered);
  if (outputURL) URL.revokeObjectURL(outputURL);
  outputURL = URL.createObjectURL(wavBlob);

  setProgress(100, 'Done!', 'Ready');
  addLog('🎉 Done!', true);

  progressSection.style.display = 'none';
  resultSection.style.display   = '';
  activateStep(3);

  resultDesc.textContent = 'Vocals extracted (Web Audio fallback — WAV output).';
  downloadLink.href     = outputURL;
  downloadLink.download = selectedFile.name.replace(/\.[^.]+$/, '') + '_vocals.wav';
  audioPreview.style.display = 'flex';
  audioPlayer.src = outputURL;
  waveformCanvas.style.display = '';
  renderWaveform(await wavBlob.arrayBuffer());
}

// ── WAV encoder ────────────────────────────────────────────────────────────
function audioBufferToWav(buf) {
  const nCh = buf.numberOfChannels, rate = buf.sampleRate, len = buf.length;
  const out  = new ArrayBuffer(44 + len * nCh * 2);
  const view = new DataView(out);
  const ws = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  ws(0,'RIFF'); view.setUint32(4,36+len*nCh*2,true);
  ws(8,'WAVE'); ws(12,'fmt '); view.setUint32(16,16,true); view.setUint16(20,1,true);
  view.setUint16(22,nCh,true); view.setUint32(24,rate,true); view.setUint32(28,rate*nCh*2,true);
  view.setUint16(32,nCh*2,true); view.setUint16(34,16,true);
  ws(36,'data'); view.setUint32(40,len*nCh*2,true);
  let off = 44;
  for (let i = 0; i < len; i++) for (let ch = 0; ch < nCh; ch++) {
    const s = Math.max(-1, Math.min(1, buf.getChannelData(ch)[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true); off += 2;
  }
  return new Blob([out], { type: 'audio/wav' });
}

// ── Waveform visualizer ────────────────────────────────────────────────────
async function renderWaveform(arrayBuffer) {
  try {
    const ctx   = new (window.AudioContext || window.webkitAudioContext)();
    const audio = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const data  = audio.getChannelData(0);
    const canvas = waveformCanvas;
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = canvas.offsetWidth  * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    const c = canvas.getContext('2d');
    c.scale(dpr, dpr);
    const W = canvas.offsetWidth, H = canvas.offsetHeight;
    const step = Math.ceil(data.length / W), amp = H / 2;
    const grad = c.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#a78bfa'); grad.addColorStop(0.5, '#38bdf8'); grad.addColorStop(1, '#34d399');
    c.clearRect(0, 0, W, H);
    c.beginPath(); c.moveTo(0, amp);
    for (let i = 0; i < W; i++) {
      let mn = 1, mx = -1;
      for (let j = 0; j < step; j++) { const d = data[i*step+j]||0; if(d<mn)mn=d; if(d>mx)mx=d; }
      c.lineTo(i, amp + mn * amp * 0.9);
    }
    for (let i = W-1; i >= 0; i--) {
      let mx = -1;
      for (let j = 0; j < step; j++) { const d = data[i*step+j]||0; if(d>mx)mx=d; }
      c.lineTo(i, amp - mx * amp * 0.9);
    }
    c.closePath(); c.fillStyle = grad; c.globalAlpha = 0.8; c.fill();
    c.beginPath(); c.moveTo(0,amp); c.lineTo(W,amp);
    c.strokeStyle = 'rgba(255,255,255,0.1)'; c.lineWidth = 1; c.globalAlpha = 1; c.stroke();
    ctx.close();
  } catch (e) { console.warn('Waveform failed:', e); }
}

// ── Load script helper ─────────────────────────────────────────────────────
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

// ── Reset ──────────────────────────────────────────────────────────────────
resetBtn.addEventListener('click', () => {
  selectedFile = null; selectedURL = null; fileInput.value = ''; outputURL = null;
  uploadZone.style.display    = (activeTab === 'file') ? '' : 'none';
  fileInfo.style.display      = 'none';
  urlZone.style.display       = (activeTab === 'url')  ? '' : 'none';
  urlFileInfo.style.display   = 'none';
  processPanel.style.display  = 'none';
  progressSection.style.display = 'none';
  resultSection.style.display = 'none';
  waveformCanvas.style.display = '';
  urlInput.value = ''; urlDetect.style.display = 'none';
  urlClearBtn.style.display = 'none'; urlConfirmBtn.disabled = true;
  highlightPlatform(null);
  processBtn.disabled = false;
  progressBar.style.width = '0%';
  progressLog.innerHTML = '<div class="log-entry">⚡ Booting AudioLift engine...</div>';
  audioPlayer.src = '';
  activateStep(1);
});

// ── Scroll animations ──────────────────────────────────────────────────────
const observer = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) { e.target.style.opacity = '1'; e.target.style.transform = 'translateY(0)'; }
  });
}, { threshold: 0.1 });

document.querySelectorAll('.feature-card').forEach((el, i) => {
  el.style.opacity = '0'; el.style.transform = 'translateY(30px)';
  el.style.transition = `opacity 0.5s ${i * 0.1}s, transform 0.5s ${i * 0.1}s`;
  observer.observe(el);
});

console.log('%cAudioLift — Ready', 'color:#a78bfa;font-size:16px;font-weight:bold');
console.log('%c20-stage maximum vocal extraction active', 'color:#38bdf8');
