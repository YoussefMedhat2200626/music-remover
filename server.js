/**
 * AudioLift Server
 * - Serves static files with COOP/COEP headers (for FFmpeg.wasm)
 * - API: yt-dlp + aria2c URL downloading
 * - API: Server-side FFmpeg audio processing
 * - API: SSE real-time progress streaming
 */
'use strict';

const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const { exec, spawn } = require('child_process');
const os       = require('os');
const crypto   = require('crypto');

const PORT    = 3000;
const TEMP_DIR = path.join(__dirname, '.temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ── Job store ──────────────────────────────────────────────────────────────
// jobId -> { status, events[], clients[], file, filename, error, title }
const jobs = new Map();

// ── MIME types ─────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ── SSE helper ─────────────────────────────────────────────────────────────
function sendSSE(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
}

function broadcastSSE(job, event, data) {
  job.events.push({ event, data });
  job.clients.forEach(res => sendSSE(res, event, data));
}

// ── Demucs vocal separation (matches app.py exactly) ─────────────────────
// Uses: python -m demucs.separate -n htdemucs --two-stems=vocals -o outDir input
// Output with --mp3:  outDir/htdemucs/<inputBasename>/vocals.mp3
//
// WHY --mp3:
//   torchaudio >= 2.11 requires 'torchcodec' to save WAV files.
//   With --mp3, Demucs uses 'lameenc' (already installed) instead,
//   completely bypassing torchaudio save and the torchcodec error.
async function runDemucs(inputFile, outDir, onLine) {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const args = [
    '-m', 'demucs.separate',
    '-n', 'htdemucs',        // same model as app.py
    '--two-stems=vocals',    // only split vocals / no_vocals
    '--mp3',                 // use lameenc instead of torchaudio (avoids torchcodec error)
    '--mp3-bitrate', '320',  // maximum quality
    '-o', outDir,
    inputFile,
  ];
  return spawnStream(python, args, onLine);
}

// ── FFmpeg fallback filter (used only when Demucs unavailable) ────────────
function buildFallbackFilter() {
  return [
    'pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1',
    'highpass=f=280:poles=2', 'highpass=f=280:poles=2',
    'lowpass=f=9000:poles=2',
    'afftdn=nf=-40:nr=0.97', 'afftdn=nf=-40:nr=0.97',
    'anlmdn=s=7:p=0.002:r=0.002:m=15',
    'equalizer=f=65:width_type=o:width=3:g=-30',
    'equalizer=f=100:width_type=o:width=3:g=-28',
    'equalizer=f=250:width_type=o:width=2:g=-18',
    'equalizer=f=440:width_type=o:width=2:g=-12',
    'equalizer=f=2500:width_type=o:width=1.5:g=10',
    'acompressor=threshold=0.03:ratio=20:attack=2:release=30:makeup=7:knee=2',
    'agate=threshold=0.025:ratio=20:attack=1:release=40:detection=peak',
    'loudnorm=I=-16:TP=-1.5:LRA=7',
  ].join(',');
}


// ── Utility: check if a CLI tool exists ───────────────────────────────────
function checkTool(cmd) {
  return new Promise(resolve => {
    exec(cmd, { timeout: 10000 }, err => resolve(!err));
  });
}

// ── Check if demucs is installed (python -m demucs --help) ────────────────
function checkDemucs() {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  return new Promise(resolve => {
    exec(`${python} -m demucs --help`, { timeout: 15000 }, err => resolve(!err));
  });
}

// ── Utility: run command, resolve stdout string ────────────────────────────
function runCmd(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 20 * 1024 * 1024, timeout: 30000, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// ── Utility: spawn process and stream output lines ─────────────────────────
// IMPORTANT: shell MUST be false on Windows.
// With shell:true, cmd.exe mangles:
//   - `%(ext)s`  → env-var expansion strips the % signs
//   - `<=`       → treated as shell input redirection
//   - `[`, `]`   → potential glob interpretation
// Using shell:false passes args directly to the process via CreateProcess (Win)
// or execvp (Unix), with no shell interpretation.
function spawnStream(cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { shell: false });
    const parse = buf => buf.toString().split('\n').forEach(l => { if (l.trim()) onLine(l.trim()); });
    proc.stdout.on('data', parse);
    proc.stderr.on('data', parse);
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)));
    proc.on('error', err => {
      const hint = process.platform === 'win32'
        ? ` (make sure "${cmd}" is installed and in PATH)`
        : '';
      reject(new Error(`Cannot launch ${cmd}${hint}: ${err.message}`));
    });
  });
}

// ── Process a URL job ──────────────────────────────────────────────────────
async function processURLJob(jobId, mediaUrl, opts) {
  const job    = jobs.get(jobId);
  const jobDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const emit = (event, data) => broadcastSSE(job, event, data);
  const log  = (msg, highlight = false) => emit('log', { msg, highlight });
  const prog = (pct, title, sub)        => emit('progress', { pct, title, sub });

  try {
    // ── 1. Check required tools ──────────────────────────────────────────
    prog(3, 'Checking tools...', 'Verifying yt-dlp, demucs, ffmpeg');
    const [hasYtDlp, hasAria2c, hasFfmpeg, hasDemucs] = await Promise.all([
      checkTool('yt-dlp --version'),
      checkTool('aria2c --version'),
      checkTool('ffmpeg -version'),
      checkDemucs(),
    ]);

    if (!hasYtDlp) {
      throw new Error(
        'yt-dlp is not installed.\n' +
        'Install: pip install yt-dlp  OR  winget install yt-dlp'
      );
    }

    log(`✅ yt-dlp found`, true);
    log(hasAria2c
      ? '✅ aria2c found — 8-thread accelerated download enabled'
      : '⚠️  aria2c not found — single-threaded download (install: winget install aria2)');
    log(hasDemucs
      ? '✅ Demucs (htdemucs) found — perfect ML vocal separation active 🎤'
      : '⚠️  Demucs NOT found — will use FFmpeg DSP fallback (install: pip install demucs)');
    log(hasFfmpeg
      ? '✅ ffmpeg found — video stitching enabled'
      : '⚠️  ffmpeg not found (install: winget install ffmpeg)');

    // ── 2. Fetch media info ──────────────────────────────────────────────
    prog(8, 'Fetching media info...', 'Connecting to platform');
    log(`📡 Fetching info for: ${mediaUrl}`);

    let info = {};
    try {
      const raw = await runCmd(`yt-dlp --dump-json --no-playlist "${mediaUrl}"`);
      const jsonLine = raw.split('\n').find(l => l.startsWith('{'));
      if (jsonLine) info = JSON.parse(jsonLine);
    } catch (_) {}

    const title     = info.title    || 'media';
    const duration  = info.duration || 0;
    const uploader  = info.uploader || info.channel || '';
    const extractor = info.extractor_key || '';
    const thumbnail = info.thumbnail || '';

    log(`📺 Title: ${title}`);
    if (uploader) log(`👤 Uploader: ${uploader}`);
    if (duration) log(`⏱️  Duration: ${Math.floor(duration / 60)}m ${duration % 60}s`);

    emit('info', { title, uploader, duration, thumbnail, extractor });
    job.title = title;

    // ── 3. Download ──────────────────────────────────────────────────────
    prog(12, 'Downloading...', title.slice(0, 50));
    log(`⬇️  Starting download${hasAria2c ? ' via aria2c (8 threads)' : ''}...`);

    // Choose format based on ffmpeg availability:
    // • With ffmpeg   → request best video+audio streams separately and merge
    // • Without ffmpeg → request a pre-merged single-file stream (no merge needed)
    // NOTE: The format string MUST be passed as a single array element (shell:false)
    //       so that `<=` is not misinterpreted as shell redirection on Windows.
    const dlFormat = hasFfmpeg
      ? 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best'
      : 'best[ext=mp4]/best[height<=1080]/best[height<=720]/best';

    const outTemplate = path.join(jobDir, 'downloaded.%(ext)s');

    const dlArgs = [
      '--no-playlist',
      '--no-warnings',
      '--restrict-filenames',          // safe ASCII-only filenames in temp dir
      '-f', dlFormat,
    ];

    if (hasFfmpeg) {
      dlArgs.push('--merge-output-format', 'mp4');
    }

    dlArgs.push('-o', outTemplate);

    if (hasAria2c) {
      dlArgs.push('--external-downloader', 'aria2c');
      dlArgs.push('--external-downloader-args', 'aria2c:-x 8 -s 8 -k 2M --file-allocation=none --console-log-level=warn');
    }

    dlArgs.push('--newline', mediaUrl);

    log(`🔧 Format: ${dlFormat.slice(0, 80)}`);
    log(`📂 Output: ${outTemplate}`);

    await spawnStream('yt-dlp', dlArgs, line => {
      log('📥 ' + line.slice(0, 120));
      const m = line.match(/(\d+\.\d+)%/);
      if (m) {
        const dlPct   = parseFloat(m[1]);
        const overall = 12 + Math.round(dlPct * 0.48);
        const speed   = (line.match(/at\s+([^\s]+)/i) || [])[1] || '';
        const eta     = (line.match(/ETA\s+([^\s]+)/i) || [])[1] || '';
        prog(overall, 'Downloading...', `${dlPct.toFixed(1)}%${speed ? ` · ${speed}` : ''}${eta ? ` · ETA ${eta}` : ''}`);
      }
    });

    // ── 4. Find downloaded file ──────────────────────────────────────────
    const files = fs.readdirSync(jobDir).filter(f => f.startsWith('downloaded'));
    if (!files.length) throw new Error('Download failed — no output file found in temp directory.');

    const dlFile = path.join(jobDir, files[0]);
    const dlExt  = path.extname(files[0]).slice(1) || 'mp4';
    const dlSize = fs.statSync(dlFile).size;
    log(`✅ Download complete: ${files[0]} (${(dlSize / 1024 / 1024).toFixed(1)} MB)`, true);

    // ── 5. Vocal separation ───────────────────────────────────────────────
    const safeTitle = title.replace(/[^\w\s\-]/g, '').trim().slice(0, 60) || 'output';
    const outFile   = path.join(jobDir, 'output.' + dlExt);

    if (hasDemucs && hasFfmpeg) {
      // ── Path A: Demucs ML separation (same as app.py) ─────────────────
      // demucs writes: <demucsOut>/htdemucs/<inputStem>/vocals.mp3  (with --mp3 flag)
      const demucsOutDir  = path.join(jobDir, 'demucs_out');
      const inputBasename = path.basename(dlFile, path.extname(dlFile));
      let   vocalsFile    = path.join(demucsOutDir, 'htdemucs', inputBasename, 'vocals.mp3');

      prog(62, 'Separating vocals...', 'Running Demucs htdemucs model — may take 1-3 min');
      log('🤖 Starting Demucs ML vocal separation...');
      log(`   Model: htdemucs  |  Mode: --two-stems=vocals`);

      let demucsProgress = 62;
      await runDemucs(dlFile, demucsOutDir, line => {
        log('🔬 ' + line.slice(0, 110));
        // Demucs prints progress as: Separated track N/N
        const m = line.match(/(\d+)%|Separated track (\d+)\/(\d+)/i);
        if (m) {
          if (m[1]) demucsProgress = 62 + Math.round(parseInt(m[1]) * 0.25);
          else if (m[2]) demucsProgress = 62 + Math.round((parseInt(m[2]) / parseInt(m[3])) * 25);
          prog(demucsProgress, 'Separating vocals...', line.slice(0, 60));
        }
      });

      if (!fs.existsSync(vocalsFile)) {
        // Fallback: older torchaudio might still write .wav
        const vocalsWavAlt = vocalsFile.replace('.mp3', '.wav');
        if (!fs.existsSync(vocalsWavAlt)) {
          throw new Error(`Demucs finished but no output found. Expected: ${vocalsFile}`);
        }
        vocalsFile = vocalsWavAlt;
        log('ℹ️  Found vocals.wav (older torchaudio), using that.');
      }
      log(`✅ Demucs complete — vocal track extracted!`, true);

      // ── Stitch vocals back onto the original video (Phase 3 of app.py)
      prog(90, 'Stitching audio...', 'Merging vocals with video');
      log('🎬 Stitching vocals onto video with ffmpeg...');

      await spawnStream('ffmpeg', [
        '-y',
        '-i', dlFile,        // original video (for video stream)
        '-i', vocalsFile,    // demucs vocal track (mp3 or wav)
        '-c:v', 'copy',      // copy video stream unchanged
        '-map', '0:v:0',     // take video from input 0
        '-map', '1:a:0',     // take audio from input 1 (vocals)
        '-b:a', '192k',
        '-shortest',
        outFile,
      ], line => log('📟 ' + line.slice(0, 80)));

      log('✅ Vocal extraction complete!', true);

    } else if (hasFfmpeg) {
      // ── Path B: FFmpeg DSP fallback (when Demucs not installed) ──────────
      prog(62, 'Extracting vocals (FFmpeg)...', 'Applying DSP filter chain');
      log('⚠️  Demucs not found — using FFmpeg DSP fallback.');
      log('   For perfect separation install: pip install demucs');

      await spawnStream('ffmpeg', [
        '-i', dlFile,
        '-vcodec', 'copy',
        '-af', buildFallbackFilter(),
        '-acodec', 'aac', '-b:a', '192k',
        '-y', outFile,
      ], line => {
        log('📟 ' + line.slice(0, 90));
        const tm = line.match(/time=(\d+):(\d+):(\d+)/);
        if (tm && duration) {
          const elapsed = +tm[1]*3600 + +tm[2]*60 + +tm[3];
          prog(62 + Math.round(Math.min(1, elapsed/duration)*30),
            'Extracting vocals...', tm[0].replace('time=',''));
        }
      });

      log('✅ FFmpeg filter complete.', true);

    } else {
      // ── Path C: No ffmpeg at all — serve raw download ────────────────────
      log('⚠️  Neither Demucs nor FFmpeg found — serving original download.');
      log('   Install both: pip install demucs  +  winget install ffmpeg');
      fs.copyFileSync(dlFile, outFile);
    }


    // ── 6. Done ──────────────────────────────────────────────────────────
    prog(100, 'Done!', 'Ready to download');
    log('🎉 All done!', true);

    job.status   = 'done';
    job.file     = outFile;
    job.filename = `${safeTitle}_processed.${dlExt}`;
    emit('done', { filename: job.filename, title });

  } catch (err) {
    job.status = 'error';
    job.error  = err.message;
    emit('error', { msg: err.message });
    log('❌ Error: ' + err.message);
    console.error('[Job Error]', jobId, err.message);
  }
}

// ── HTTP Request router ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // Universal headers
  res.setHeader('Cross-Origin-Opener-Policy',  'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const rawUrl  = req.url || '/';
  const urlPath = rawUrl.split('?')[0];

  // ────────────────────────────────────────────────────────────────────────
  // POST /api/process-url  — start a new download+process job
  // ────────────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && urlPath === '/api/process-url') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const opts = JSON.parse(body);
        if (!opts.url) { res.writeHead(400); res.end(JSON.stringify({ error: 'No URL provided' })); return; }

        const jobId = crypto.randomBytes(8).toString('hex');
        jobs.set(jobId, {
          status: 'running', events: [], clients: [],
          file: null, filename: null, title: null, error: null,
        });

        // Fire and forget — progress streamed via SSE
        processURLJob(jobId, opts.url, opts).catch(e => console.error('Unhandled job error:', e));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobId }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
    });
    return;
  }

  // ────────────────────────────────────────────────────────────────────────
  // GET /api/events/:jobId  — SSE progress stream
  // ────────────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && urlPath.startsWith('/api/events/')) {
    const jobId = urlPath.slice('/api/events/'.length);
    const job   = jobs.get(jobId);
    if (!job) { res.writeHead(404); res.end('Job not found'); return; }

    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });
    res.write(': connected\n\n');

    // Replay buffered events
    job.events.forEach(({ event, data }) => sendSSE(res, event, data));

    if (job.status === 'done' || job.status === 'error') { res.end(); return; }

    job.clients.push(res);
    req.on('close', () => { job.clients = job.clients.filter(c => c !== res); });
    return;
  }

  // ────────────────────────────────────────────────────────────────────────
  // GET /api/download/:jobId  — stream processed file to browser
  // ────────────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && urlPath.startsWith('/api/download/')) {
    const jobId = urlPath.slice('/api/download/'.length);
    const job   = jobs.get(jobId);

    if (!job || job.status !== 'done' || !job.file) {
      res.writeHead(404); res.end('File not ready'); return;
    }
    if (!fs.existsSync(job.file)) {
      res.writeHead(404); res.end('File no longer exists'); return;
    }

    const stat = fs.statSync(job.file);
    const ext  = path.extname(job.file).slice(1);
    const mimeMap = { mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4' };

    res.writeHead(200, {
      'Content-Type':        mimeMap[ext] || 'application/octet-stream',
      'Content-Length':      stat.size,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(job.filename || ('output.' + ext))}"`,
    });

    const stream = fs.createReadStream(job.file);
    stream.pipe(res);

    // Schedule cleanup
    setTimeout(() => {
      try { fs.rmSync(path.join(TEMP_DIR, jobId), { recursive: true, force: true }); } catch (_) {}
      jobs.delete(jobId);
    }, 10 * 60 * 1000);
    return;
  }

  // ────────────────────────────────────────────────────────────────────────
  // GET /api/check-tools  — check installed tools
  // ────────────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && urlPath === '/api/check-tools') {
    const [hasYtDlp, hasAria2c, hasFfmpeg, hasDemucs] = await Promise.all([
      checkTool('yt-dlp --version'),
      checkTool('aria2c --version'),
      checkTool('ffmpeg -version'),
      checkDemucs(),
    ]);
    let ytdlpVersion = '', aria2cVersion = '', ffmpegVersion = '', demucsVersion = '';
    if (hasYtDlp)  try { ytdlpVersion  = (await runCmd('yt-dlp --version')).trim(); } catch (_) {}
    if (hasAria2c) try { aria2cVersion = (await runCmd('aria2c --version')).split('\n')[0].trim(); } catch (_) {}
    if (hasFfmpeg) try { ffmpegVersion = (await runCmd('ffmpeg -version')).split('\n')[0].replace('ffmpeg version ','').split(' ')[0]; } catch (_) {}
    if (hasDemucs) {
      const python = process.platform === 'win32' ? 'python' : 'python3';
      try { demucsVersion = (await runCmd(`${python} -m demucs --version`)).trim() || 'installed'; } catch (_) { demucsVersion = 'installed'; }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hasYtDlp, hasAria2c, hasFfmpeg, hasDemucs, ytdlpVersion, aria2cVersion, ffmpegVersion, demucsVersion }));
    return;
  }


  // ────────────────────────────────────────────────────────────────────────
  // Static file serving
  // ────────────────────────────────────────────────────────────────────────
  let filePath = path.join(__dirname, urlPath === '/' ? 'index.html' : urlPath);
  const ext    = path.extname(filePath).toLowerCase();
  const mime   = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? '404 Not Found' : 'Server Error');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n  🎵  AudioLift Server\n`);
  console.log(`  ➜  http://localhost:${PORT}\n`);
  console.log(`  Features:`);
  console.log(`    • COOP/COEP headers   → FFmpeg.wasm (browser)`);
  console.log(`    • /api/process-url    → yt-dlp + aria2c download`);
  console.log(`    • /api/events/:id     → SSE real-time progress`);
  console.log(`    • /api/download/:id   → serve processed file`);
  console.log(`    • /api/check-tools    → tool availability check\n`);
});

// Cleanup temp on exit
process.on('exit',    () => { try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch (_) {} });
process.on('SIGINT',  () => { try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch (_) {} process.exit(); });
process.on('SIGTERM', () => { try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch (_) {} process.exit(); });
