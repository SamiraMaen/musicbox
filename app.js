/**
 * Music Box — Interactive Vinyl Player Experience
 * Three.js + GSAP + YouTube IFrame API
 */
import * as THREE from 'three';
import { GLTFLoader }  from 'three/addons/loaders/GLTFLoader.js';

/* ══════════════════════════════════════════════════════
   CONSTANTS
   ══════════════════════════════════════════════════════ */
const VINYL_RPM        = 33.33;
const VINYL_RAD_S      = (VINYL_RPM / 60) * Math.PI * 2;   // ~3.49 rad/s
const PIPED_INSTANCES  = [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.projectsegfau.lt',
  'https://piped-api.garudalinux.org',
];
const TONEARM_REST  = 0.48;   // Y rotation when parked
const TONEARM_START = -0.05;  // Y rotation at record start
const TONEARM_END   = -0.46;  // Y rotation at record end

/* ══════════════════════════════════════════════════════
   SHARED STATE
   ══════════════════════════════════════════════════════ */
const S = {
  mode:           'idle',     // idle | loading | playing | paused | finishing
  currentTrack:   null,
  history:        [],
  searchResults:  [],
  spinSpeed:      0,
  targetSpin:     0,
  tonearmProg:    0,          // 0..1 playback progress for tonearm
  ytPlayer:       null,
  ytReady:        false,
  progressTimer:  null,
};

/* ══════════════════════════════════════════════════════
   3D OBJECTS (populated during load)
   ══════════════════════════════════════════════════════ */
const O = {
  renderer: null, scene: null, camera: null,
  turntable: null,
  platter:   null,   // spinning disc part
  tonearm:   null,   // tonearm mesh/group
  vinyl:     null,   // the active record sitting on the platter
};

/* ══════════════════════════════════════════════════════
   BOOTSTRAP
   ══════════════════════════════════════════════════════ */
async function main() {
  setupRenderer();
  setupLights();
  // Shadow plane removed intentionally
  await loadModels();
  setupYouTube();
  setupSearch();
  setupControls();
  startLoop();
  hideLoading();
}

main().catch(console.error);

/* ══════════════════════════════════════════════════════
   THREE.JS — RENDERER & SCENE
   ══════════════════════════════════════════════════════ */
function setupRenderer() {
  const canvas = document.getElementById('scene-canvas');
  const panel  = document.getElementById('turntable-container');

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled   = false;   // no shadows — cleaner look
  renderer.outputColorSpace    = THREE.SRGBColorSpace;
  renderer.toneMapping         = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.setClearColor(0x000000, 0);   // transparent — shows panel bg
  O.renderer = renderer;

  const scene = new THREE.Scene();
  O.scene = scene;

  // Camera — top-down, turntable centred at world origin
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  camera.position.set(0, 13, 0.4);   // directly above, tiny Z to keep 'up' stable
  camera.up.set(0, 0, -1);           // screen-up = world -Z
  camera.lookAt(0, 0, 0);
  O.camera = camera;

  // Keep canvas filling the right-panel at all times
  function syncSize() {
    const W = panel.clientWidth  || 640;
    const H = panel.clientHeight || 480;
    renderer.setSize(W, H);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
  }
  syncSize();
  new ResizeObserver(syncSize).observe(panel);
}

function setupLights() {
  const scene = O.scene;

  scene.add(new THREE.AmbientLight(0xC8D0E0, 1.4));

  const key = new THREE.DirectionalLight(0xffffff, 2.8);
  key.position.set(4, 12, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far  = 40;
  key.shadow.camera.left = key.shadow.camera.bottom = -8;
  key.shadow.camera.right = key.shadow.camera.top  =  8;
  key.shadow.bias = -0.001;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x8090C0, 1.1);
  fill.position.set(-6, 5, 3);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffffff, 0.7);
  rim.position.set(0, 2, -10);
  scene.add(rim);
}

function addShadowPlane() {
  // Invisible plane that only receives shadows — looks great over the lavender bg
  const geo = new THREE.PlaneGeometry(30, 30);
  const mat = new THREE.ShadowMaterial({ opacity: 0.12 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -0.45;
  mesh.receiveShadow = true;
  O.scene.add(mesh);
  O.shadowPlane = mesh;
}

/* ══════════════════════════════════════════════════════
   MODEL LOADING
   ══════════════════════════════════════════════════════ */
async function loadModels() {
  const loader = new GLTFLoader();
  const load   = url => new Promise((res, rej) =>
    loader.load(url, res, undefined, rej));

  try {
    const turntableGLTF = await load('./turntable.glb');
    setupTurntableModel(turntableGLTF.scene);

  } catch (err) {
    console.warn('GLB load error — using fallback geometry', err);
    buildFallbackScene();
  }
}

/* ── Turntable ── */
function setupTurntableModel(model) {
  normaliseMesh(model, 5.8);   // scaled to fit comfortably

  const box = new THREE.Box3().setFromObject(model);
  const ctr = new THREE.Vector3();
  box.getCenter(ctr);
  model.position.sub(ctr);
  model.position.x = 0;      // centred in the right-panel canvas
  model.position.y = 0;

  model.traverse(child => {
    if (!child.isMesh) return;
    child.castShadow = child.receiveShadow = true;
    boostMaterial(child.material);
  });

  O.scene.add(model);
  O.turntable = model;
  discoverParts(model);
}


/* ── Helpers ── */
function normaliseMesh(model, targetSize) {
  const box  = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  model.scale.setScalar(targetSize / maxDim);
}

function boostMaterial(mat) {
  if (!mat) return;
  if (mat.metalness !== undefined) {
    mat.metalness = Math.max(mat.metalness, 0.25);
    mat.roughness = Math.min(mat.roughness, 0.75);
  }
  mat.needsUpdate = true;
}

function discoverParts(model) {
  const meshes = [];
  model.traverse(ch => {
    if (!ch.isMesh) return;
    const box  = new THREE.Box3().setFromObject(ch);
    const size = new THREE.Vector3();
    box.getSize(size);
    meshes.push({ mesh: ch, name: ch.name.toLowerCase(), sx: size.x, sy: size.y, sz: size.z });
  });

  // log for debugging
  console.log('[MusicBox] Turntable parts:', meshes.map(m => m.name || '(unnamed)'));

  const platKW = ['platter','plate','disc','rotating','record','turntable','mat'];
  const armKW  = ['arm','tone','needle','stylus','pickup','headshell','cartridge'];

  let platter = meshes.find(m => platKW.some(k => m.name.includes(k)))?.mesh;
  let tonearm = meshes.find(m => armKW.some(k => m.name.includes(k)))?.mesh;

  if (!platter) {
    // Heuristic: largest flat disc (wide & thin)
    platter = meshes
      .filter(m => Math.max(m.sx, m.sz) / (m.sy + 0.001) > 4)
      .sort((a, b) => Math.max(b.sx, b.sz) - Math.max(a.sx, a.sz))[0]?.mesh;
  }
  if (!tonearm) {
    // Heuristic: elongated thin object (skip platter)
    tonearm = meshes
      .filter(m => m.mesh !== platter)
      .filter(m => { const max = Math.max(m.sx, m.sy, m.sz); const min = Math.min(m.sx, m.sy, m.sz) + 0.001; return max / min > 3.5; })
      .sort((a, b) => Math.max(b.sx, b.sz) - Math.max(a.sx, a.sz))[0]?.mesh;
  }

  console.log('[MusicBox] Platter:', platter?.name, '| Tonearm:', tonearm?.name);
  O.platter = platter;
  O.tonearm = tonearm;

  // Park tonearm
  if (O.tonearm) O.tonearm.rotation.y = TONEARM_REST;
}

function platPos() {
  if (O.platter) {
    const box = new THREE.Box3().setFromObject(O.platter);
    const ctr = new THREE.Vector3(); box.getCenter(ctr);
    return ctr;
  }
  return new THREE.Vector3(0, 0, 0);  // turntable centred at world origin
}

/* ══════════════════════════════════════════════════════
   FALLBACK GEOMETRY (used when GLBs fail to load)
   ══════════════════════════════════════════════════════ */
function buildFallbackScene() {
  const s = O.scene;

  // Body — centred at origin
  const bodyM = new THREE.MeshStandardMaterial({ color: 0x2A2A30, metalness: 0.5, roughness: 0.5 });
  const body  = new THREE.Mesh(new THREE.BoxGeometry(5, 0.2, 5), bodyM);
  body.position.set(0, -0.1, 0);
  body.castShadow = body.receiveShadow = true;
  s.add(body);

  // Platter
  const platM = new THREE.MeshStandardMaterial({ color: 0x181820, metalness: 0.4, roughness: 0.6 });
  const plat  = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 0.12, 64), platM);
  plat.position.set(0, 0.06, 0);
  plat.castShadow = plat.receiveShadow = true;
  s.add(plat);
  O.platter = plat;

  // Tonearm
  const armM  = new THREE.MeshStandardMaterial({ color: 0xB0B0B8, metalness: 0.85, roughness: 0.15 });
  const pivot = new THREE.Group();
  pivot.position.set(1.6, 0.18, -1.2);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.05, 2.2), armM);
  arm.position.set(0, 0, 1.1);
  pivot.add(arm);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 0.18), armM);
  head.position.set(0, -0.02, 2.25);
  pivot.add(head);
  pivot.rotation.y = TONEARM_REST;
  s.add(pivot);
  O.tonearm = pivot;

  // Active vinyl (hidden)
  const vinylM = makeVinylMat();
  const vinyl  = new THREE.Mesh(new THREE.CylinderGeometry(1.75, 1.75, 0.09, 64), vinylM);
  vinyl.position.set(0, 0.13, 0);
  vinyl.visible = false;
  s.add(vinyl);
  O.vinyl = vinyl;

  O.turntable = body;
}

function makeVinylMat(thumbnailUrl) {
  const sz  = 512;
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = sz;
  const ctx = cvs.getContext('2d');
  const cx  = sz / 2;

  // Dark grooves
  for (let r = cx - 14; r > cx * 0.32; r -= 2.4) {
    const v = 18 + Math.random() * 16;
    ctx.beginPath();
    ctx.arc(cx, cx, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgb(${v},${Math.floor(v * 0.22)},${Math.floor(v * 0.22)})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  // Red label
  ctx.beginPath();
  ctx.arc(cx, cx, cx * 0.3, 0, Math.PI * 2);
  ctx.fillStyle = '#C83050';
  ctx.fill();
  // Hole
  ctx.beginPath();
  ctx.arc(cx, cx, 8, 0, Math.PI * 2);
  ctx.fillStyle = '#0A0008';
  ctx.fill();

  const tex = new THREE.CanvasTexture(cvs);
  const mat = new THREE.MeshStandardMaterial({
    map: tex, color: 0x1a0008,
    roughness: 0.18, metalness: 0.55,
  });

  if (thumbnailUrl) applyThumb(mat, tex, cvs, ctx, cx, thumbnailUrl);
  return mat;
}

function applyThumb(mat, tex, cvs, ctx, cx, url) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const r = cx * 0.3;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cx, r, 0, Math.PI * 2); ctx.clip();
    ctx.globalAlpha = 0.72;
    ctx.drawImage(img, cx - r, cx - r, r * 2, r * 2);
    ctx.restore();
    // Re-punch hole
    ctx.beginPath(); ctx.arc(cx, cx, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#0A0008'; ctx.fill();
    tex.needsUpdate = true;
  };
  img.src = url;
}

/* ══════════════════════════════════════════════════════
   RENDER LOOP
   ══════════════════════════════════════════════════════ */
const clock = new THREE.Clock();

function startLoop() {
  (function loop() {
    requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.05);
    tick(dt);
    O.renderer.render(O.scene, O.camera);
  })();
}

function tick(dt) {
  // Smooth spin interpolation
  const diff = S.targetSpin - S.spinSpeed;
  S.spinSpeed += diff * (Math.abs(diff) > 0.05 ? 0.05 : 0.025);

  // Rotate platter + vinyl
  if (Math.abs(S.spinSpeed) > 0.0005) {
    // Spin the vinyl if visible
    if (O.vinyl?.visible) O.vinyl.rotation.y += S.spinSpeed * dt;
  }

  // Smooth tonearm creep during playback
  if (S.mode === 'playing' && O.tonearm) {
    const target = TONEARM_START + (TONEARM_END - TONEARM_START) * S.tonearmProg;
    const tdiff  = target - O.tonearm.rotation.y;
    O.tonearm.rotation.y += tdiff * 0.003;   // very slow, realistic
  }
}

/* ══════════════════════════════════════════════════════
   PLAYBACK CONTROL
   ══════════════════════════════════════════════════════ */
function playTrack(track) {
  if (S.mode === 'finishing') return;

  S.currentTrack = track;
  S.mode = 'loading';
  S.tonearmProg = 0;

  // UI
  document.getElementById('np-title').textContent  = track.title;
  document.getElementById('np-artist').textContent = track.channel;
  document.getElementById('np-card').classList.add('visible');
  setPlayIcon(false);

  // Close search
  document.getElementById('search-dropdown').classList.remove('open');
  document.getElementById('search-input').value = '';

  // Load YouTube
  if (S.ytPlayer && S.ytReady) {
    try { S.ytPlayer.loadVideoById(track.id); }
    catch { /* ignore */ }
  }

  // 3D: drop vinyl onto platter
  dropVinylOntoTurntable(track);
  setStatus('Loading…');
}

function dropVinylOntoTurntable(track) {
  if (!O.vinyl) return;

  // Apply thumbnail texture
  applyThumbToVinyl(track);

  const pos = platPos();
  O.vinyl.position.set(pos.x, 9, pos.z);
  O.vinyl.rotation.set(0, 0, 0);
  O.vinyl.visible = true;

  // Drop animation
  gsap.to(O.vinyl.position, {
    y: pos.y + 0.06,
    duration: 1.1,
    ease: 'power3.out',
    onComplete: () => {
      // Bounce/settle
      gsap.to(O.vinyl.position, { y: pos.y + 0.04, duration: 0.25, ease: 'power2.out',
        onComplete: () => {
          S.mode = 'loading';
          S.targetSpin = VINYL_RAD_S;
          dropTonearm(() => {
            S.mode = 'playing';
            setStatus('Playing');
            setChipPlaying(true);
          });
        }
      });
    },
  });

  // Subtle tilt while falling
  gsap.from(O.vinyl.rotation, { x: 0.15, z: 0.08, duration: 1.1, ease: 'power2.out' });
}

function applyThumbToVinyl(track) {
  if (!O.vinyl) return;
  const url = thumbUrl(track.id);
  O.vinyl.traverse(child => {
    if (!child.isMesh) return;
    if (!child.material) return;
    const loader = new THREE.TextureLoader();
    loader.crossOrigin = 'anonymous';
    loader.load(url, tex => {
      child.material = child.material.clone();
      child.material.map = tex;
      child.material.needsUpdate = true;
    });
  });
}

function dropTonearm(cb) {
  if (!O.tonearm) { cb?.(); return; }
  gsap.to(O.tonearm.rotation, {
    y: TONEARM_START,
    duration: 2.0,
    ease: 'power2.inOut',
    onComplete: cb,
  });
}

function raiseTonearm(cb) {
  if (!O.tonearm) { cb?.(); return; }
  gsap.to(O.tonearm.rotation, {
    y: TONEARM_REST,
    duration: 1.6,
    ease: 'power2.inOut',
    onComplete: cb,
  });
}

/* ── Song ends (naturally or forced) ── */
function onSongEnd() {
  if (S.mode === 'finishing' || S.mode === 'idle') return;
  S.mode = 'finishing';

  clearProgressTimer();
  S.targetSpin = 0;
  setChipPlaying(false);
  setStatus('Finishing…');

  raiseTonearm(() => {
    flyVinylToSleeve(() => {
      addToHistory(S.currentTrack);
      S.mode = 'idle';
      setStatus('Ready to play');
      if (O.vinyl) O.vinyl.visible = false;
    });
  });
}

/* ══════════════════════════════════════════════════════
   FLYING VINYL ANIMATIONS
   ══════════════════════════════════════════════════════ */

/** Project a 3D world position to 2D screen coordinates (canvas-relative) */
function toScreen(worldVec) {
  const v      = worldVec.clone().project(O.camera);
  const canvas = document.getElementById('scene-canvas');
  const rect   = canvas.getBoundingClientRect();
  return {
    x: rect.left + (v.x  * 0.5 + 0.5) * rect.width,
    y: rect.top  + (-v.y * 0.5 + 0.5) * rect.height,
  };
}

function getVinylScreenPos() {
  const pos = O.vinyl ? O.vinyl.position.clone() : new THREE.Vector3(3.2, 0.1, 0);
  return toScreen(pos);
}

// flyVinylToSleeve is replaced by lift-off in onSongEnd — kept as no-op stub
// so any remaining references don't crash.
function flyVinylToSleeve(onDone) {
  const { x: sx, y: sy } = getVinylScreenPos();

  // ── Measure the exact pixel position of the first (newest) history slot ──
  const histRow  = document.getElementById('history-row');
  const emptyEl  = document.getElementById('history-empty');
  const wasEmpty = S.history.length === 0;

  // Insert invisible ghost card so we can read its bounding rect
  const ghost = document.createElement('div');
  ghost.className = 'hist-card';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.cssText = 'opacity:0;pointer-events:none;visibility:hidden;flex-shrink:0;';
  histRow.prepend(ghost);
  if (wasEmpty && emptyEl) emptyEl.style.display = 'none';

  void ghost.offsetWidth;  // force layout
  const slotRect = ghost.getBoundingClientRect();
  ghost.remove();
  if (wasEmpty && emptyEl) emptyEl.style.display = '';

  const tx = slotRect.left + slotRect.width  / 2 - 80;
  const ty = slotRect.top  + slotRect.height / 2 - 80;

  showFlyingVinyl(sx - 80, sy - 80, S.currentTrack?.id);

  const el   = document.getElementById('flying-vinyl');
  const disc = document.getElementById('fly-disc');
  disc.classList.add('spinning');

  gsap.timeline({ onComplete: () => { hideFlyingVinyl(); onDone?.(); } })
    .to(el, { y: sy - 200, duration: 0.4,  ease: 'power2.out' })
    .to(el, { x: tx, y: ty, scale: 0.9,   duration: 1.05, ease: 'power3.inOut' })
    .to(el, { scale: 0.45, opacity: 0,    duration: 0.28, ease: 'power2.in',
      onComplete: () => disc.classList.remove('spinning') });
}

function flyVinylFromSleeve(track, cardEl, onDone) {
  if (!cardEl) { onDone?.(); return; }

  const cardRect = cardEl.getBoundingClientRect();
  const sx = cardRect.left + cardRect.width  / 2 - 80;
  const sy = cardRect.top  + cardRect.height / 2 - 80;
  const { x: tx, y: ty } = getVinylScreenPos();

  showFlyingVinyl(sx, sy, track.id, 0.5, 0);

  const el   = document.getElementById('flying-vinyl');
  const disc = document.getElementById('fly-disc');
  disc.classList.add('spinning');

  gsap.timeline({ onComplete: () => { hideFlyingVinyl(); onDone?.(); } })
    .to(el, { scale: 0.95, opacity: 1, duration: 0.3,  ease: 'back.out(1.4)' })
    .to(el, { y: sy - 80,             duration: 0.25, ease: 'power2.out' })
    .to(el, { x: tx - 80, y: ty - 80, scale: 1,       duration: 1.0,  ease: 'power3.inOut' })
    .to(el, { scale: 0.65, opacity: 0,                duration: 0.25, ease: 'power2.in',
      onComplete: () => disc.classList.remove('spinning') });
}

function showFlyingVinyl(x, y, videoId, scale = 1, opacity = 1) {
  const el  = document.getElementById('flying-vinyl');
  const art = document.getElementById('fly-art');
  if (videoId) art.src = thumbUrl(videoId);
  gsap.set(el, { display: 'block', x, y, scale, opacity });
}
function hideFlyingVinyl() {
  const el = document.getElementById('flying-vinyl');
  gsap.set(el, { display: 'none' });
}

/* ══════════════════════════════════════════════════════
   HISTORY
   ══════════════════════════════════════════════════════ */
function addToHistory(track) {
  if (!track) return;
  S.history = S.history.filter(t => t.id !== track.id);
  S.history.unshift(track);
  renderHistory();
}

function renderHistory() {
  const row   = document.getElementById('history-row');
  const badge = document.getElementById('history-badge');
  const empty = document.getElementById('history-empty');
  if (!row) return;

  const n = S.history.length;
  if (badge) badge.textContent = `${n} record${n !== 1 ? 's' : ''}`;

  if (!n) { if (empty) empty.style.display = ''; return; }
  if (empty) empty.style.display = 'none';

  row.innerHTML = S.history.map((tr, i) => `
    <div class="hist-card" id="hc-${i}" data-i="${i}" tabindex="0" role="button"
         aria-label="Play ${esc(tr.title)}">
      <div class="hist-vinyl">
        <div class="hist-label">
          <img src="${thumbUrl(tr.id)}" alt="" crossorigin="anonymous"
               onerror="this.style.display='none'" loading="lazy" />
        </div>
        <div class="hist-hole"></div>
      </div>
      <div class="hist-name">${esc(tr.title)}</div>
      <div class="hist-artist">${esc(tr.channel)}</div>
    </div>
  `).join('');

  row.querySelectorAll('.hist-card').forEach(card => {
    const act = () => {
      const i = parseInt(card.dataset.i);
      if (!isNaN(i) && S.history[i]) recallFromHistory(S.history[i], card);
    };
    card.addEventListener('click', act);
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') act(); });
  });
}

function recallFromHistory(track, cardEl) {
  if (S.mode === 'finishing') return;
  if (S.mode === 'playing' || S.mode === 'paused') {
    S.targetSpin = 0;
    if (O.vinyl)   O.vinyl.visible = false;
    if (O.tonearm) O.tonearm.rotation.y = TONEARM_REST;
    clearProgressTimer();
  }
  flyVinylFromSleeve(track, cardEl, () => playTrack(track));
}

/* ══════════════════════════════════════════════════════
   YOUTUBE
   ══════════════════════════════════════════════════════ */
function setupYouTube() {
  const init = () => {
    S.ytPlayer = new YT.Player('youtube-player', {
      height: '1', width: '1',
      playerVars: { autoplay: 1, controls: 0, playsinline: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady() { S.ytReady = true; },
        onStateChange(e) { handleYTState(e.data); },
      },
    });
  };

  if (window._ytReady) init();
  else window._ytCallbacks.push(init);
}

function handleYTState(state) {
  // 0=ended, 1=playing, 2=paused, 3=buffering, 5=cued
  switch (state) {
    case 0:
      onSongEnd();
      break;
    case 1:
      if (S.mode !== 'playing') {
        S.mode = 'playing';
        S.targetSpin = VINYL_RAD_S;
        setChipPlaying(true);
        setStatus('Playing');
      }
      setPlayIcon(true);
      startProgressTimer();
      break;
    case 2:
      S.targetSpin = 0;
      setPlayIcon(false);
      setStatus('Paused');
      break;
    case 3:
      setStatus('Loading…');
      break;
  }
}

function startProgressTimer() {
  clearProgressTimer();
  S.progressTimer = setInterval(() => {
    if (!S.ytPlayer || typeof S.ytPlayer.getCurrentTime !== 'function') return;
    try {
      const cur = S.ytPlayer.getCurrentTime() || 0;
      const dur = S.ytPlayer.getDuration()    || 0;
      if (dur > 0) {
        const pct = cur / dur;
        document.getElementById('np-prog-fill').style.width = (pct * 100) + '%';
        document.getElementById('t-cur').textContent = fmtTime(cur);
        document.getElementById('t-tot').textContent = fmtTime(dur);
        S.tonearmProg = pct;
      }
    } catch { /* ignore */ }
  }, 500);
}

function clearProgressTimer() {
  if (S.progressTimer) { clearInterval(S.progressTimer); S.progressTimer = null; }
}

/* ══════════════════════════════════════════════════════
   SEARCH
   ══════════════════════════════════════════════════════ */
function setupSearch() {
  const inp  = document.getElementById('search-input');
  const drop = document.getElementById('search-dropdown');
  let   timer;

  inp.addEventListener('input', e => {
    const q = e.target.value.trim();
    clearTimeout(timer);
    drop.classList.remove('open');

    if (!q) return;

    const vid = extractYTId(q);
    if (vid) { loadByUrl(vid); return; }

    timer = setTimeout(() => runSearch(q), 380);
  });

  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const q = inp.value.trim();
      const vid = extractYTId(q);
      if (vid) loadByUrl(vid);
      else if (q) runSearch(q);
    }
    if (e.key === 'Escape') { drop.classList.remove('open'); inp.setAttribute('aria-expanded','false'); }
  });

  // Nav search mirrors main
  document.getElementById('nav-search').addEventListener('input', e => {
    const q = e.target.value.trim();
    if (!q) return;
    inp.value = q;
    clearTimeout(timer);
    timer = setTimeout(() => runSearch(q), 380);
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#search-module') && !e.target.closest('.nav-search-wrap'))
      drop.classList.remove('open');
  });
}

function extractYTId(s) {
  const pats = [
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of pats) { const m = s.match(p); if (m) return m[1]; }
  return null;
}

async function loadByUrl(videoId) {
  spinner(true);
  let track = {
    id: videoId, title: 'YouTube Track', channel: 'YouTube',
  };
  try {
    const r = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { signal: AbortSignal.timeout(4000) }
    );
    if (r.ok) { const d = await r.json(); track.title = d.title; track.channel = d.author_name; }
  } catch { /* use defaults */ }
  spinner(false);
  playTrack(track);
}

async function runSearch(query) {
  spinner(true);
  const drop = document.getElementById('search-dropdown');
  drop.classList.remove('open');
  let results = [];

  for (const base of PIPED_INSTANCES) {
    try {
      const r = await fetch(
        `${base}/search?q=${encodeURIComponent(query)}&filter=videos`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!r.ok) continue;
      const d = await r.json();
      results = (d.items || [])
        .filter(i => i.type === 'stream' && i.url)
        .slice(0, 8)
        .map(i => {
          const id = i.url.replace('/watch?v=', '');
          return { id, title: i.title || 'Unknown', channel: i.uploaderName || '—', duration: i.duration };
        })
        .filter(i => i.id.length === 11);
      if (results.length) break;
    } catch { /* try next instance */ }
  }

  spinner(false);
  S.searchResults = results;
  renderDropdown(results);
}

function renderDropdown(results) {
  const drop = document.getElementById('search-dropdown');
  const inp  = document.getElementById('search-input');

  if (!results.length) {
    drop.innerHTML = '<p class="results-empty">No results. Try a different search or paste a YouTube link.</p>';
    drop.classList.add('open');
    inp.setAttribute('aria-expanded', 'true');
    return;
  }

  drop.innerHTML = results.map((r, i) => `
    <div class="result-item" data-i="${i}" role="option" tabindex="0">
      <img class="result-thumb" src="${thumbUrl(r.id)}" alt=""
           loading="lazy" onerror="this.style.visibility='hidden'" />
      <div class="result-meta">
        <div class="result-title">${esc(r.title)}</div>
        <div class="result-channel">${esc(r.channel)}</div>
      </div>
      <div class="result-dur">${fmtTime(r.duration || 0)}</div>
    </div>
  `).join('');

  drop.classList.add('open');
  inp.setAttribute('aria-expanded', 'true');

  drop.querySelectorAll('.result-item').forEach(item => {
    const select = () => {
      const t = S.searchResults[parseInt(item.dataset.i)];
      if (t) playTrack(t);
    };
    item.addEventListener('click', select);
    item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') select(); });
  });
}

/* ══════════════════════════════════════════════════════
   UI HELPERS
   ══════════════════════════════════════════════════════ */
function setupControls() {
  document.getElementById('btn-toggle').addEventListener('click', () => {
    if (!S.ytPlayer || !S.ytReady) return;
    try {
      const st = S.ytPlayer.getPlayerState();
      if (st === 1) { S.ytPlayer.pauseVideo(); S.targetSpin = 0; setChipPlaying(false); }
      else          { S.ytPlayer.playVideo();  S.targetSpin = VINYL_RAD_S; setChipPlaying(true); }
    } catch { /* ignore */ }
  });
}

function setPlayIcon(playing) {
  document.getElementById('ico-play').style.display  = playing ? 'none' : '';
  document.getElementById('ico-pause').style.display = playing ? '' : 'none';
}

function setChipPlaying(yes) {
  const dot = document.getElementById('chip-dot');
  yes ? dot.classList.add('playing') : dot.classList.remove('playing');
}

function setStatus(msg) {
  document.getElementById('chip-msg').textContent = msg;
}


function spinner(on) {
  const el = document.getElementById('s-spinner');
  on ? el.classList.add('active') : el.classList.remove('active');
}

function hideLoading() {
  const el = document.getElementById('loading-overlay');
  if (!el) return;
  el.classList.add('hidden');
  setTimeout(() => el.remove(), 600);
}

/* ══════════════════════════════════════════════════════
   UTILS
   ══════════════════════════════════════════════════════ */
function thumbUrl(id)       { return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`; }
function fmtTime(sec)       { const m = Math.floor(sec/60); const s = String(Math.floor(sec%60)).padStart(2,'0'); return `${m}:${s}`; }
function esc(s)             { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
