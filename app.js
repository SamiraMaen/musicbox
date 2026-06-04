/**
 * Music Box — Interactive Vinyl Player Experience
 * Three.js + GSAP + YouTube IFrame API
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/* ══════════════════════════════════════════════════════
   CONSTANTS
   ══════════════════════════════════════════════════════ */
const VINYL_RPM = 33.33;
const VINYL_RAD_S = (VINYL_RPM / 60) * Math.PI * 2;   // ~3.49 rad/s (playing speed)
const VINYL_IDLE_RAD_S = 0.0;               // completely stopped when idle
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.projectsegfau.lt',
  'https://piped-api.garudalinux.org',
];
const TONEARM_REST = 0.0;    // natural position
const TONEARM_START = -0.40;  // Y rotation at record start
const TONEARM_END = -0.80;  // Y rotation at record end

/* ══════════════════════════════════════════════════════
   SHARED STATE
   ══════════════════════════════════════════════════════ */
const S = {
  mode: 'idle',
  currentTrack: null,
  history: [
    { id: 'lAIGb1lfpBw', title: 'Highway to Hell', channel: 'AC/DC' },
    { id: 'fJ9rUzIMcZQ', title: 'Bohemian Rhapsody', channel: 'Queen' },
    { id: 'hTWKbfoikeg', title: 'Smells Like Teen Spirit', channel: 'Nirvana' },
    { id: '9jK-NcRmVcw', title: 'The Final Countdown', channel: 'Europe' }
  ],
  searchResults: [],
  spinSpeed: 0,
  targetSpin: VINYL_IDLE_RAD_S,   // idle slow spin from the start
  tonearmProg: 0,          // 0..1 playback progress for tonearm
  ytPlayer: null,
  ytReady: false,
  progressTimer: null,
  volume: 80,         // 0–100
  loopEnabled: false,      // loop toggle (Circling button)
  speedBoost: false,      // speed boost toggle (circling button)
};

/* ══════════════════════════════════════════════════════
   3D OBJECTS (populated during load)
   ══════════════════════════════════════════════════════ */
const O = {
  renderer: null, scene: null, camera: null,
  turntable: null,
  platter: null,
  platterCenter: null,
  tonearm: null,
  vinyl: null,
  vinylCanvas: null,
  vinylCtx: null,
  vinylTex: null,
  // Interactive 3D buttons
  slider: null,   // 'VolumeButtom'    — physical volume fader (drag up/down)
  sliderInitZ: 0,      // local Z at spawn (= volume 50 mid-point)
  sliderRange: 16,     // ± units in local Z for 0–100 % travel
  btnPlay: null,   // 'PauseButton'     — play / pause
  btnRew: null,   // 'Button 1'        — seek −10 s
  btnFwd: null,   // 'Button 2'        — seek +10 s
  btnSpeed: null,   // 'circling button' — speed boost toggle
  btnLoop: null,   // 'Circling'        — loop mode toggle
  hoverMesh: null,
  isDragging: false,
  dragStartY: 0,
  dragStartVol: 80,
  bar: null,
  barInitY: 0,
};

/* ══════════════════════════════════════════════════════
   BOOTSTRAP
   ══════════════════════════════════════════════════════ */
async function main() {
  const startTime = Date.now();

  setupShaderBackground(); // Initialize WebGL Shader Background
  setupRenderer();
  setupLights();
  await loadModels();
  setupYouTube();
  setupSearch();
  setupControls();
  setup3DControls();    // 3D button raycasting
  startLoop();

  const elapsed = Date.now() - startTime;

  // The page loads for a total of 6 seconds (6000 ms), keeping the loader visible and animating normally
  const overlayDelay = Math.max(0, 6000 - elapsed);
  setTimeout(() => {
    hideLoading();
  }, overlayDelay);

  window.O = O;
  window.S = S;
  window.THREE = THREE;
}

main().catch(console.error);

/* ══════════════════════════════════════════════════════
   THREE.JS — RENDERER & SCENE
   ══════════════════════════════════════════════════════ */
function setupRenderer() {
  const canvas = document.getElementById('scene-canvas');
  const panel = document.getElementById('turntable-container');

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = false;   // no shadows — cleaner look
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.setClearColor(0x000000, 0);   // transparent — shows panel bg
  O.renderer = renderer;

  const scene = new THREE.Scene();
  O.scene = scene;

  // Camera — top-down, turntable centred at world origin
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  camera.position.set(0, 13, 1.65);   // directly above, Z shifted to 1.65 to move model up on screen
  camera.up.set(0, 0, -1);           // screen-up = world -Z
  camera.lookAt(0, 0, 1.25);
  O.camera = camera;

  // Keep canvas filling the right-panel at all times
  function syncSize() {
    const W = panel.clientWidth || 640;
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
  key.shadow.camera.far = 40;
  key.shadow.camera.left = key.shadow.camera.bottom = -8;
  key.shadow.camera.right = key.shadow.camera.top = 8;
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
  const load = url => new Promise((res, rej) =>
    loader.load(url, res, undefined, rej));

  try {
    const playerGLTF = await load('./Music Box22.glb');
    setupTurntableModel(playerGLTF.scene);
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
  });

  O.scene.add(model);
  O.turntable = model;
  discoverParts(model);       // sets O.platter, O.tonearm, O.vinyl, O.platterCenter

  // Apply canvas texture to the top face so grooves + label + thumbnail show
  if (O.platter && !O.platter.name.includes('REC0002')) {
    let baseColor = '#CDBF00'; // Exact color requested by user
    O.vinylBaseColor = baseColor; // save for applyThumbToVinyl
    const vinylMat = makeVinylMat(baseColor);
    O.platter.material = vinylMat;
  } else {
    O.vinylCanvas = document.createElement('canvas');
    O.vinylCanvas.width = 1024;
    O.vinylCanvas.height = 1024;
    O.vinylCtx = O.vinylCanvas.getContext('2d');
    O.vinylTex = new THREE.CanvasTexture(O.vinylCanvas);
  }

  setupInteractiveControls(model);
}


/* ── Interaction Hitboxes ── */
O.hitboxes = [];
let isDraggingTempo = false;
S.isPowered = true;

function createHitbox(name, x, y, z, w, h, d) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.0, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.name = 'Hitbox_' + name;
  mesh.userData.action = name;
  return mesh;
}

function setupInteractiveControls(model) {
  O.hitboxes = [];
  const hitboxes = new THREE.Group();

  // 1. Black Dial (Object_18): Restart from beginning
  hitboxes.add(createHitbox('loop', -0.20, -0.09, 0.11, 0.04, 0.04, 0.05));
  // 2. Start/Stop: Play/Pause (large silver button)
  hitboxes.add(createHitbox('playpause', -0.20, -0.16, 0.11, 0.05, 0.05, 0.05));
  // 3. Left small button: Rewind 10s
  hitboxes.add(createHitbox('rewind', -0.14, -0.16, 0.11, 0.02, 0.05, 0.05));
  // 4. Right small button: Fast forward 10s
  hitboxes.add(createHitbox('fastforward', -0.11, -0.16, 0.11, 0.02, 0.05, 0.05));
  // 5. Tonearm: Over the Bar
  hitboxes.add(createHitbox('tonearm', 0.15, -0.01, 0.12, 0.06, 0.22, 0.05));
  // 6. Tempo Slider: Right edge (as background clicking area)
  hitboxes.add(createHitbox('tempo', 0.20, -0.09, 0.11, 0.04, 0.16, 0.05));
  
  O.hitboxesGroup = hitboxes;
  let targetParent = model;

  O.btnPowerMesh = null;
  O.btnResetMesh = null;
  O.btnVolumeMesh = null;
  model.traverse(ch => {
    if (ch.isMesh && ch.material && typeof ch.material.name === 'string') {
      const name = ch.material.name.toLowerCase();
      if (name.includes('metalbrushedblack') || name.includes('black')) {
        // Exclude the vinyl record materials from this change
        if (!name.includes('rec0002') && !name.includes('vinyl') && !name.includes('record')) {
          ch.material.color.setHex(0x1A1C1E); // Sleek charcoal-black brushed metal
          ch.material.needsUpdate = true;
        }
      } else if (name === 'chrome.chinche') {
        ch.material.map = null;
        ch.material.normalMap = null;
        ch.material.roughnessMap = null;
        ch.material.metalnessMap = null;
        ch.material.color.setHex(0xD0D4DC); // Brushed silver body
        ch.material.metalness = 0.85;
        ch.material.roughness = 0.22;
        ch.material.needsUpdate = true;
      }
    }

    if (ch.isMesh && ch.name === 'Object_18') {
      targetParent = ch.parent;
      O.btnLoop = ch;
    }
    if (ch.isMesh && ch.material && ch.material.name === 'blue.emission') {
      O.ledStrips = ch;
      O.ledStrips.userData.origEmissive = new THREE.Color(0x00A2FF); // Vibrant neon blue light
      O.ledStrips.userData.origColor = new THREE.Color(0x00A2FF);
      O.ledStrips.userData.origIntensity = 3.5;
      
      // Initially paused state: gray color, no emissive glow
      ch.material.color.setHex(0xaab4c2); // Lighter gray shade
      ch.material.emissive.setHex(0x000000);
      ch.material.emissiveIntensity = 0.0;
      ch.material.needsUpdate = true;
    }
    if (ch.isMesh && ch.name === 'Object_8') {
      O.btnPlay = ch;
      ch.material = ch.material.clone();
    }
    if (ch.isMesh && ch.name === 'Object_9') {
      O.btnRew = ch;
      ch.material = ch.material.clone();
    }
    if (ch.isMesh && ch.name === 'Object_10') {
      O.btnFwd = ch;
      ch.material = ch.material.clone();
    }
    if (ch.isMesh && ch.name === 'Object_5') O.btnResetMesh = ch;
    
    const isVolumeNode = ch.name === 'VolumeButtom' || ch.name === 'VolumeButton' || ch.name.toLowerCase().includes('volume');
    if (isVolumeNode) {
      O.btnVolumeMesh = ch;
      ch.updateMatrixWorld(true);

      const initLocalPos = ch.position.clone();

      // Define range in local units
      const range = 0.4; 

      O.sliderState = {
        mesh: ch,
        origVal: initLocalPos.z,
        minVal: initLocalPos.z - range, // screen-up (100% volume)
        maxVal: initLocalPos.z + range, // screen-down (0% volume)
      };

      console.log(`[Volume Config] Slider: ${ch.name}, Local Z: init=${initLocalPos.z.toFixed(3)}, min=${(initLocalPos.z - range).toFixed(3)}, max=${(initLocalPos.z + range).toFixed(3)}`);
      debugLog(`Volume Slider: ${ch.name}, Local Z init: ${initLocalPos.z.toFixed(3)}`);

      // Visually start at initial volume
      updateSliderPositionFromVolume(S.volume);

      // Make the button itself interactive
      ch.userData.action = 'tempo';
      if (O.hitboxes && !O.hitboxes.includes(ch)) {
        O.hitboxes.push(ch);
      }
    }
  });

  targetParent.add(hitboxes);
  hitboxes.children.forEach(hb => O.hitboxes.push(hb));
}

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

// Pointer down interaction registered inside setup3DControls on the canvas element.

window.addEventListener('pointermove', (e) => {
  if (O.renderer && O.renderer.domElement) {
    const rect = O.renderer.domElement.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  if (isDraggingTempo && O.sliderState && O.sliderState.mesh) {
    const deltaY = e.clientY - O.dragStartScreenY;
    // 150 pixels of drag for full 0-100% volume travel
    const deltaVol = -(deltaY / 150) * 100;
    S.volume = Math.max(0, Math.min(100, Math.round(O.dragStartVol + deltaVol)));
    debugLog(`Drag: deltaY=${deltaY}px, vol=${S.volume}%`);

    // Update 3D slider position
    updateSliderPositionFromVolume(S.volume);

    // Update YouTube volume
    if (S.ytPlayer && typeof S.ytPlayer.setVolume === 'function') {
      try { S.ytPlayer.setVolume(S.volume); } catch (err) { }
    }

    setStatus(`Volume: ${S.volume}%`);
  }
});

window.addEventListener('pointerup', () => {
  if (isDraggingTempo) {
    isDraggingTempo = false;
    debugLog(`PointerUp: drag ended, vol = ${S.volume}%`);
    if (window.controls) window.controls.enabled = true;
    setSliderVolume(S.volume);
    setStatus(`Volume: ${S.volume}%`);
    setTimeout(() => setStatus(S.mode === 'playing' ? 'Playing' : 'Ready to play'), 1200);
  }
  
  // Clear any stuck hover glow on release of any interaction
  if (O.hoverMesh) {
    setMeshEmissive(O.hoverMesh, 0x000000);
    O.hoverMesh = null;
  }
  const canvas = document.getElementById('scene-canvas');
  if (canvas && !isDraggingTempo) {
    canvas.style.cursor = '';
  }
});

function handleControlAction(action, e, hitboxMesh) {
  if (action === 'power') {
    S.isPowered = !S.isPowered;
    // User requested to NOT move (rotate) the power dial
    // if (O.btnPowerMesh) {
    //   gsap.to(O.btnPowerMesh.rotation, { z: S.isPowered ? -Math.PI / 4 : 0, duration: 0.2 });
    // }
    // Pause if turning off
    if (!S.isPowered && S.mode === 'playing') {
      document.getElementById('play-pause-btn').click();
    }
  }

  if (!S.isPowered) return;

  if (action === 'playpause') {
    if (S.currentTrack) {
      document.getElementById('btn-toggle').click();
    }
  } else if (action === 'rewind') {
    action3DSeek(-10);
  } else if (action === 'fastforward') {
    action3DSeek(10);
  } else if (action === 'loop') {
    // Restart song without moving the dial
    action3DRestartSong();
  } else if (action === 'tempo') {
    isDraggingTempo = true;
    if (window.controls) window.controls.enabled = false;
    O.dragStartScreenY = e.clientY;
    O.dragStartVol = S.volume;
    
    // Clear active hover glow on start drag
    if (O.hoverMesh) {
      setMeshEmissive(O.hoverMesh, 0x000000);
      O.hoverMesh = null;
    }
    debugLog(`Drag start: clientY=${e.clientY}, currentVol=${S.volume}%`);
  }
}

/* ── Helpers ── */
function normaliseMesh(model, targetSize) {
  const box = new THREE.Box3().setFromObject(model);
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
  // Check if we are loading Music Box.glb by looking for 'vinyl-single'
  let hasVinylSingle = false;
  model.traverse(ch => {
    const n = ch.name.toLowerCase();
    if (ch.isMesh && (n === 'vinyl-single' || n === 'object_157.001' || n.includes('rec0002'))) {
      hasVinylSingle = true;
    }
  });

  let hasExplicitBar = false;
  model.traverse(ch => {
    if (ch.isMesh && ch.name.toLowerCase().startsWith('bar')) hasExplicitBar = true;
  });

  if (hasVinylSingle) {
    console.log('[MusicBox] Detected advanced model structure');

    // ── Find vinyl-single or Object_157.001 (platter reference) ──
    let platter = null;
    model.traverse(ch => {
      const n = ch.name.toLowerCase();
      if (ch.isMesh && (n === 'vinyl-single' || n === 'object_157.001' || n.includes('rec0002'))) platter = ch;
    });
    O.platter = platter;

    if (platter.name.includes('REC0002') || platter.name === 'Object_157.001') {
      platter.userData.isZUp = true;
    }

    platter.userData.origY = platter.position.y;
    platter.userData.origZ = platter.position.z;

    // Suspend record in the air initially
    if (platter.userData.isZUp) {
      platter.position.z += 15;
    } else {
      platter.position.y += 15;
    }
    platter.visible = false;

    // ── Compute platter world-space center before reparenting ──
    model.updateMatrixWorld(true);
    if (O.platter) {
      const pBox = new THREE.Box3().setFromObject(O.platter);
      O.platterCenter = new THREE.Vector3();
      pBox.getCenter(O.platterCenter);
    } else {
      O.platterCenter = new THREE.Vector3(0, 0.06, 0);
    }

    // ── Collect ALL vinyl-group meshes (vinyl-single + layer Cylinders at same XZ) ──
    const vinylLocalCenter = platter ? platter.position.clone() : new THREE.Vector3(4.2, 2.9, 4.0);
    const vinylParts = [];
    model.traverse(ch => {
      if (!ch.isMesh) return;
      if (ch.name === 'vinyl-single') { vinylParts.push(ch); return; }
      if (!ch.name.startsWith('Cylinder')) return;
      // Include if centre is within 15 GLB units of vinyl-single in XZ
      const dx = Math.abs(ch.position.x - vinylLocalCenter.x);
      const dz = Math.abs(ch.position.z - vinylLocalCenter.z);
      if (dx < 15 && dz < 15) vinylParts.push(ch);
    });

    // ── Create a dedicated vinyl group at the platter world center ──
    // vinylGroup.scale = model.scale so mesh positions stay in model-local units.
    const vinylGroup = new THREE.Group();
    vinylGroup.position.copy(O.platterCenter);
    vinylGroup.scale.copy(model.scale);
    O.scene.add(vinylGroup);

    // Reparent vinyl parts: express their positions relative to vinylLocalCenter
    vinylParts.forEach(mesh => {
      if (mesh.parent) mesh.parent.remove(mesh);
      mesh.position.sub(vinylLocalCenter);   // now relative to group origin
      vinylGroup.add(mesh);
    });

    O.vinyl = vinylGroup;   // rotating group.rotation.y spins all vinyl parts in place

    // ── Tonearm: collect ALL right-side meshes by world position ──
    model.updateMatrixWorld(true);

    const armParts = [];
    const skipNames = new Set(['vinyl-single', 'turntable-single', 'volumebuttom',
      'button 1', 'button 2', 'pausebutton', 'circling', 'speed button',
      'turntable-single.002', 'turntable-single.003']);

    model.traverse(ch => {
      if (!ch.isMesh) return;
      const nm = ch.name.trim().toLowerCase();
      if (skipNames.has(nm)) return;

      ch.geometry.computeBoundingBox();
      const center = new THREE.Vector3();
      ch.geometry.boundingBox.getCenter(center);

      // Tonearm parts: ONLY animate the gold part (chrome.CHINCHE)
      if (nm.startsWith('bar') || (ch.parent && ch.parent.name.toLowerCase().startsWith('bar'))) {
        if (ch.material && ch.material.name === 'chrome.CHINCHE') {
          armParts.push(ch);
        }
      }
    });

    // Pivot point: dynamically get the center of Square.001 or Object_16
    let pivotMesh = null;
    model.traverse(ch => {
      const n = ch.name.trim().toLowerCase();
      if (ch.isMesh && (n === 'square.001' || n === 'object_16')) pivotMesh = ch;
    });
    const pivotWorld = new THREE.Vector3();
    if (pivotMesh) {
      new THREE.Box3().setFromObject(pivotMesh).getCenter(pivotWorld);
    } else {
      pivotWorld.set(1.5, 0.5, -0.5); // Fallback
    }

    const tonearmGroup = new THREE.Group();
    tonearmGroup.position.copy(pivotWorld);
    O.scene.add(tonearmGroup);
    model.updateMatrixWorld(true);
    armParts.forEach(part => {
      tonearmGroup.attach(part);
    });
    O.tonearm = tonearmGroup;

    // DEBUG UI removed as requested

    // ── Interactive button mapping for Music Box2.glb ──
    let mainBody = null;
    let barMesh = null;
    model.traverse(ch => {
      if (!ch.isMesh) return;
      const n = ch.name.trim();
      switch (n) {
        case 'VolumeButtom':
        case 'Volume Button':
        case 'VolumeButton':
          O.slider = ch; 
          break;   // volume fader (drag up/down)
        case 'PauseButton': O.btnPlay = ch; break;   // play / pause
        case 'Button 1': O.btnRew = ch; break;   // seek −10 s
        case 'Button 2': O.btnFwd = ch; break;   // seek +10 s
        case 'Speed Button': O.btnSpeed = ch; break;   // speed boost
        case 'Circling': O.btnLoop = ch; break;   // loop toggle
        case 'turntable-single': mainBody = ch; break;   // main device body
        case 'Bar':
          O.bar = ch;
          break;
      }
    });

    // Fader position initialization is handled in setupInteractiveControls
    if (O.slider) {
      updateSliderPositionFromVolume(S.volume);
    }
    console.log('[MusicBox2] Slider:', O.slider?.name, 'Play:', O.btnPlay?.name,
      'Fwd:', O.btnFwd?.name, 'Rew:', O.btnRew?.name,
      'Speed:', O.btnSpeed?.name, 'Loop:', O.btnLoop?.name);

  } else {
    // Original generic discovery logic
    const meshes = [];
    model.traverse(ch => {
      if (!ch.isMesh) return;
      const box = new THREE.Box3().setFromObject(ch);
      const size = new THREE.Vector3();
      box.getSize(size);
      meshes.push({ mesh: ch, name: ch.name.toLowerCase(), sx: size.x, sy: size.y, sz: size.z });
    });

    console.log('[MusicBox] Generic Turntable parts:', meshes.map(m => m.name || '(unnamed)'));

    const platKW = ['platter', 'plate', 'disc', 'rotating', 'record', 'turntable', 'mat'];
    const armKW = ['arm', 'tone', 'needle', 'stylus', 'pickup', 'headshell', 'cartridge'];

    let platter = meshes.find(m => platKW.some(k => m.name.includes(k)))?.mesh;
    let tonearm = meshes.find(m => armKW.some(k => m.name.includes(k)))?.mesh;

    if (!platter) {
      platter = meshes
        .filter(m => Math.max(m.sx, m.sz) / (m.sy + 0.001) > 4)
        .sort((a, b) => Math.max(b.sx, b.sz) - Math.max(a.sx, a.sz))[0]?.mesh;
    }
    if (!tonearm) {
      tonearm = meshes
        .filter(m => m.mesh !== platter)
        .filter(m => { const max = Math.max(m.sx, m.sy, m.sz); const min = Math.min(m.sx, m.sy, m.sz) + 0.001; return max / min > 3.5; })
        .sort((a, b) => Math.max(b.sx, b.sz) - Math.max(a.sx, a.sz))[0]?.mesh;
    }

    console.log('[MusicBox] Platter:', platter?.name, '| Tonearm:', tonearm?.name);
    O.platter = platter;
    O.tonearm = tonearm;
  }

  // For generic branch: compute platterCenter if not already set by hasVinylSingle branch
  if (!O.platterCenter) {
    if (O.platter) {
      const box = new THREE.Box3().setFromObject(O.platter);
      O.platterCenter = new THREE.Vector3();
      box.getCenter(O.platterCenter);
    } else {
      O.platterCenter = new THREE.Vector3(0, 0.06, 0);
    }
  }

  // Park tonearm
  if (O.tonearm) O.tonearm.rotation.y = TONEARM_REST;
}

function platPos() {
  return O.platterCenter || new THREE.Vector3(0, 0, 0);
}

/* ══════════════════════════════════════════════════════
   FALLBACK GEOMETRY (used when GLBs fail to load)
   ══════════════════════════════════════════════════════ */
function buildFallbackScene() {
  const s = O.scene;

  // Body — centred at origin
  const bodyM = new THREE.MeshStandardMaterial({ color: 0x2A2A30, metalness: 0.5, roughness: 0.5 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(5, 0.2, 5), bodyM);
  body.position.set(0, -0.1, 0);
  body.castShadow = body.receiveShadow = true;
  s.add(body);

  // Platter
  const platM = new THREE.MeshStandardMaterial({ color: 0x181820, metalness: 0.4, roughness: 0.6 });
  const plat = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 0.12, 64), platM);
  plat.position.set(0, 0.06, 0);
  plat.castShadow = plat.receiveShadow = true;
  s.add(plat);
  O.platter = plat;

  // Tonearm
  const armM = new THREE.MeshStandardMaterial({ color: 0xB0B0B8, metalness: 0.85, roughness: 0.15 });
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
  const vinyl = new THREE.Mesh(new THREE.CylinderGeometry(1.75, 1.75, 0.09, 64), vinylM);
  vinyl.position.set(0, 0.13, 0);
  vinyl.visible = false;
  s.add(vinyl);
  O.vinyl = vinyl;

  O.turntable = body;
}

function makeVinylMat(baseColor) {
  const sz = 512;
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = sz;
  const ctx = cvs.getContext('2d');
  const cx = sz / 2;

  drawVinylBase(ctx, cx, baseColor);

  const tex = new THREE.CanvasTexture(cvs);
  const mat = new THREE.MeshStandardMaterial({
    map: tex, color: 0xffffff,
    transparent: true,
    roughness: 0.18, metalness: 0.55,
  });

  // Store refs so applyThumbToVinyl can update the texture later
  O.vinylCanvas = cvs;
  O.vinylCtx = ctx;
  O.vinylTex = tex;

  return mat;
}

function drawVinylBase(ctx, cx, baseColor) {
  const sz = cx * 2;

  // Base vinyl background
  ctx.fillStyle = baseColor || '#CDBF00';
  ctx.fillRect(0, 0, sz, sz);

  // Subtle sheen radial highlight (gives 3D depth)
  const sheen = ctx.createRadialGradient(cx * 0.65, cx * 0.55, 0, cx, cx, cx);
  sheen.addColorStop(0, 'rgba(255,255,255,0.06)');
  sheen.addColorStop(0.4, 'rgba(255,255,255,0.02)');
  sheen.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, sz, sz);

  // ── Groove rings: alternating dark/slightly-lighter for contrast ──
  for (let r = cx - 4; r > cx * 0.34; r -= 3.2) {
    // Dark groove trough
    ctx.beginPath();
    ctx.arc(cx, cx, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.95)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    // Lighter ridge beside it
    ctx.beginPath();
    ctx.arc(cx, cx, r - 1.4, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(80,65,80,0.55)';
    ctx.lineWidth = 1.0;
    ctx.stroke();
  }

  // ── White label circle (high contrast against dark vinyl) ──
  const lr = cx * 0.30;
  // Outer thin ring around label for definition
  ctx.beginPath();
  ctx.arc(cx, cx, lr + 2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fill();
  // Label fill — off-white/cream
  ctx.beginPath();
  ctx.arc(cx, cx, lr, 0, Math.PI * 2);
  ctx.fillStyle = '#f0ece8';
  ctx.fill();

  // Centre hole
  ctx.beginPath();
  ctx.arc(cx, cx, 7, 0, Math.PI * 2);
  ctx.fillStyle = '#0a0508';
  ctx.fill();
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

  // Rotate vinyl (always visible on the turntable)
  if (Math.abs(S.spinSpeed) > 0.0005) {
    if (O.vinyl) {
      O.vinyl.rotation.y += S.spinSpeed * dt;
    }
    if (O.platter && S.mode === 'playing') {
      if (O.platter.userData.isZUp) {
        O.platter.rotation.z -= S.spinSpeed * dt;
      } else {
        O.platter.rotation.y -= S.spinSpeed * dt;
      }
    }
  }

  // Position YouTube iframe exactly behind the vinyl hole (Disabled to show thumbnail instead)
  if (O.vinyl) {
    const wrap = document.getElementById('yt-wrap');
    if (wrap) wrap.style.opacity = '0';
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
  document.getElementById('np-title').textContent = track.title;
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
  if (!O.platter) return;

  // Apply album art texture to the canvas
  if (O.platter && O.platter.name.includes('REC0002')) {
    if (!O.thumbnailDecal) {
      const decalGeo = new THREE.CircleGeometry(0.054, 64);
      const decalMat = new THREE.MeshBasicMaterial({ map: O.vinylTex, transparent: true, depthTest: true, side: THREE.DoubleSide });
      O.thumbnailDecal = new THREE.Mesh(decalGeo, decalMat);
      O.thumbnailDecal.position.z = 0.05; // Elevated safely above record face to prevent hiding
      
      // The user requested to use scale to make the decal cover the label
      O.thumbnailDecal.scale.set(10.5, 10.5, 1);
      
      O.platter.add(O.thumbnailDecal);
    }
  }

  if (O.platter.name === 'Object_157.001' || O.platter.name.includes('REC0002')) {
    O.platter.visible = true;
    gsap.to(O.platter.position, {
      [O.platter.userData.isZUp ? 'z' : 'y']: O.platter.userData.isZUp ? O.platter.userData.origZ : O.platter.userData.origY,
      duration: 1.0,
      ease: 'bounce.out',
      onComplete: () => {
        dropTonearm(() => {
          playVideo(track);
        });
      }
    });
  } else {
    // Vinyl is already on the turntable — just drop tonearm
    dropTonearm(() => {
      playVideo(track);
    });
  }
}

function applyThumbToVinyl(track) {
  if (!O.vinylCanvas || !O.vinylCtx || !O.vinylTex) return;
  const ctx = O.vinylCtx;
  const cvs = O.vinylCanvas;
  const cx = cvs.width / 2;

  // Draw thumbnail image masked to the label, and extract color
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    // Clear canvas completely
    ctx.clearRect(0, 0, cvs.width, cvs.height);

    if (O.platter && O.platter.name.includes('REC0002')) {
      // Just draw the circular thumbnail for the decal
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cx, cx, 0, Math.PI * 2);
      ctx.clip();

      const imgAspect = img.width / img.height;
      let dw = cx * 2, dh = cx * 2;
      if (imgAspect > 1) { dw = dh * imgAspect; } else { dh = dw / imgAspect; }
      ctx.drawImage(img, cx - dw / 2, cx - dh / 2, dw, dh);
      ctx.restore();

      // Punch center hole
      ctx.beginPath();
      ctx.arc(cx, cx, 15, 0, Math.PI * 2);
      ctx.fillStyle = '#0a0508';
      ctx.fill();

      O.vinylTex.needsUpdate = true;

      if (!O.thumbnailDecal) {
        const decalGeo = new THREE.CircleGeometry(0.054, 64);
        const decalMat = new THREE.MeshBasicMaterial({ map: O.vinylTex, transparent: true, depthTest: true, side: THREE.DoubleSide });
        O.thumbnailDecal = new THREE.Mesh(decalGeo, decalMat);
        O.thumbnailDecal.position.z = 0.01;
        
        O.thumbnailDecal.scale.set(10.5, 10.5, 1);
        
        O.platter.add(O.thumbnailDecal);
      }
    } else {
      // 1. Extract average color for the vinyl base
      const tmpCvs = document.createElement('canvas');
      tmpCvs.width = 1; tmpCvs.height = 1;
      const tmpCtx = tmpCvs.getContext('2d');
      tmpCtx.drawImage(img, 0, 0, 1, 1);
      const data = tmpCtx.getImageData(0, 0, 1, 1).data;
      // Darken a bit for a premium vinyl look
      const rCol = Math.floor(data[0] * 0.85);
      const gCol = Math.floor(data[1] * 0.85);
      const bCol = Math.floor(data[2] * 0.85);
      O.vinylBaseColor = `rgb(${rCol}, ${gCol}, ${bCol})`;

      // 2. Redraw base with dynamic color
      drawVinylBase(ctx, cx, O.vinylBaseColor);

      // 3. Draw thumbnail masked to the label
      const r = cx / 3;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cx, r, 0, Math.PI * 2);
      ctx.clip();

      // Fill image preserving aspect ratio
      const imgAspect = img.width / img.height;
      let dw = r * 2, dh = r * 2;
      if (imgAspect > 1) {
        dw = dh * imgAspect;
      } else {
        dh = dw / imgAspect;
      }
      ctx.drawImage(img, cx - dw / 2, cx - dh / 2, dw, dh);
      ctx.restore();

      // Re-punch centre hole (peg)
      ctx.beginPath();
      ctx.arc(cx, cx, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#0a0508';
      ctx.fill();

      O.vinylTex.needsUpdate = true;
    }
  };
  const originalUrl = track.thumbnail || `https://img.youtube.com/vi/${track.id}/hqdefault.jpg`;
  img.src = `https://corsproxy.io/?${encodeURIComponent(originalUrl)}`;
}

function dropTonearm(cb) {
  if (!O.tonearm) { cb?.(); return; }
  
  if (O.tonearmTimer) clearTimeout(O.tonearmTimer);
  gsap.killTweensOf(O.tonearm.rotation);

  // Start spinning when the tonearm gets close to the record
  O.tonearmTimer = setTimeout(() => {
    S.targetSpin = VINYL_RAD_S;
  }, 1000);

  gsap.to(O.tonearm.rotation, {
    y: TONEARM_START,
    duration: 2.0,
    ease: 'power2.inOut',
    onUpdate: () => O.tonearm.updateMatrixWorld(true),
    onComplete: cb,
  });
}

function raiseTonearm(cb) {
  if (!O.tonearm) { cb?.(); return; }

  if (O.tonearmTimer) clearTimeout(O.tonearmTimer);
  gsap.killTweensOf(O.tonearm.rotation);

  gsap.to(O.tonearm.rotation, {
    y: TONEARM_REST,
    duration: 1.6,
    ease: 'power2.inOut',
    onUpdate: () => O.tonearm.updateMatrixWorld(true),
    onComplete: cb,
  });
}

/* ── Song ends (naturally or forced) ── */
function onSongEnd() {
  if (S.mode === 'finishing' || S.mode === 'idle') return;
  S.mode = 'finishing';

  clearProgressTimer();
  S.targetSpin = VINYL_IDLE_RAD_S;   // return to gentle idle spin
  setChipPlaying(false);
  setStatus('Finishing…');

  raiseTonearm(() => {
    addToHistory(S.currentTrack);
    S.mode = 'idle';
    setStatus('Ready to play');
    // vinyl stays on the turntable — it's part of the 3D model
  });
}

/* ══════════════════════════════════════════════════════
   FLYING VINYL ANIMATIONS
   ══════════════════════════════════════════════════════ */

/** Project a 3D world position to 2D screen coordinates (canvas-relative) */
function toScreen(worldVec) {
  const v = worldVec.clone().project(O.camera);
  const canvas = document.getElementById('scene-canvas');
  const rect = canvas.getBoundingClientRect();
  return {
    x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
    y: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
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
  const histRow = document.getElementById('history-row');
  const emptyEl = document.getElementById('history-empty');
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

  const tx = slotRect.left + slotRect.width / 2 - 80;
  const ty = slotRect.top + slotRect.height / 2 - 80;

  showFlyingVinyl(sx - 80, sy - 80, S.currentTrack?.id);

  const el = document.getElementById('flying-vinyl');
  const disc = document.getElementById('fly-disc');
  disc.classList.add('spinning');

  gsap.timeline({ onComplete: () => { hideFlyingVinyl(); onDone?.(); } })
    .to(el, { y: sy - 200, duration: 0.4, ease: 'power2.out' })
    .to(el, { x: tx, y: ty, scale: 0.9, duration: 1.05, ease: 'power3.inOut' })
    .to(el, {
      scale: 0.45, opacity: 0, duration: 0.28, ease: 'power2.in',
      onComplete: () => disc.classList.remove('spinning')
    });
}

function flyVinylFromSleeve(track, cardEl, onDone) {
  if (!cardEl) { onDone?.(); return; }

  const cardRect = cardEl.getBoundingClientRect();
  const sx = cardRect.left + cardRect.width / 2 - 80;
  const sy = cardRect.top + cardRect.height / 2 - 80;
  const { x: tx, y: ty } = getVinylScreenPos();

  showFlyingVinyl(sx, sy, track.id, 0.5, 0);

  const el = document.getElementById('flying-vinyl');
  const disc = document.getElementById('fly-disc');
  disc.classList.add('spinning');

  gsap.timeline({ onComplete: () => { hideFlyingVinyl(); onDone?.(); } })
    .to(el, { scale: 0.95, opacity: 1, duration: 0.3, ease: 'back.out(1.4)' })
    .to(el, { y: sy - 80, duration: 0.25, ease: 'power2.out' })
    .to(el, { x: tx - 80, y: ty - 80, scale: 1, duration: 1.0, ease: 'power3.inOut' })
    .to(el, {
      scale: 0.65, opacity: 0, duration: 0.25, ease: 'power2.in',
      onComplete: () => disc.classList.remove('spinning')
    });
}

function showFlyingVinyl(x, y, videoId, scale = 1, opacity = 1) {
  const el = document.getElementById('flying-vinyl');
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
  const row = document.getElementById('history-row');
  const badge = document.getElementById('history-badge');
  const empty = document.getElementById('history-empty');
  if (!row) return;

  const n = S.history.length;
  if (badge) badge.textContent = `${n} record${n !== 1 ? 's' : ''}`;

  if (!n) { if (empty) empty.style.display = ''; return; }
  if (empty) empty.style.display = 'none';

  row.innerHTML = S.history.map((tr, i) => `
    <div class="hist-card" id="hc-${i}" data-i="${i}" tabindex="0" role="button"
         aria-label="Play ${esc(tr.title)}" style="z-index: ${n - i};">
      <img src="${thumbUrl(tr.id)}" alt="" class="hist-cover" crossorigin="anonymous"
           onerror="this.style.display='none'" loading="lazy" />
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
    S.targetSpin = VINYL_IDLE_RAD_S;   // return to idle spin
    if (O.tonearm) O.tonearm.rotation.y = TONEARM_REST;
    clearProgressTimer();
  }
  playTrack(track);
}

/* ══════════════════════════════════════════════════════
   YOUTUBE
   ══════════════════════════════════════════════════════ */
function playYoutubeAudio(id) {
  if (S.ytPlayer && S.ytReady) {
    S.ytPlayer.cueVideoById(id);
  }
}

function setupYouTube() {
  const init = () => {
    S.ytPlayer = new YT.Player('youtube-player', {
      height: '1', width: '1',
      playerVars: { autoplay: 0, controls: 0, playsinline: 1, rel: 0, modestbranding: 1 },
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
      S.mode = 'paused';
      S.targetSpin = VINYL_IDLE_RAD_S;   // slow idle on pause
      setPlayIcon(false);
      setStatus('Paused');
      setChipPlaying(false);
      raiseTonearm();
      break;
    case 3:
      S.mode = 'loading';
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
      const dur = S.ytPlayer.getDuration() || 0;
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
  const inp = document.getElementById('search-input');
  const drop = document.getElementById('search-dropdown');
  let timer;

  const btnAdd = document.getElementById('btn-add-vinyl');
  if (btnAdd) {
    btnAdd.addEventListener('click', () => {
      if (inp) {
        inp.focus();
        inp.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }

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
    if (e.key === 'Escape') { drop.classList.remove('open'); inp.setAttribute('aria-expanded', 'false'); }
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
  const inp = document.getElementById('search-input');

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
      if (st === 1) { 
        S.ytPlayer.pauseVideo(); 
      } else { 
        if (O.tonearm && Math.abs(O.tonearm.rotation.y - TONEARM_START) > 0.1) {
          // If tonearm is not dropped, drop it before playing!
          dropTonearm(() => { S.ytPlayer.playVideo(); });
        } else {
          S.ytPlayer.playVideo(); 
        }
      }
    } catch { /* ignore */ }
  });
}

/* ═══════════════════════════════════════════════════════
   SLIDER HELPERS
   ═══════════════════════════════════════════════════════ */

function updateSliderPositionFromVolume(vol) {
  if (!O.sliderState || !O.sliderState.mesh) return;
  const s = O.sliderState;
  const t = vol / 100;
  // volume = 100% is minVal (screen-up), volume = 0% is maxVal (screen-down)
  const targetWorldZ = s.maxVal - t * (s.maxVal - s.minVal);
  
  const mesh = s.mesh;
  const worldPos = new THREE.Vector3();
  mesh.getWorldPosition(worldPos);
  worldPos.z = targetWorldZ;
  
  if (mesh.parent) {
    mesh.parent.updateMatrixWorld(true);
    mesh.parent.worldToLocal(worldPos);
    mesh.position.copy(worldPos);
  } else {
    mesh.position.z = targetWorldZ;
  }
}

function getVolumeFromSliderPosition() {
  if (!O.sliderState || !O.sliderState.mesh) return S.volume;
  const s = O.sliderState;
  const mesh = s.mesh;
  const worldPos = new THREE.Vector3();
  mesh.getWorldPosition(worldPos);
  
  const pct = (worldPos.z - s.minVal) / (s.maxVal - s.minVal);
  const vol = (1.0 - pct) * 100;
  return Math.max(0, Math.min(100, Math.round(vol)));
}

/** Smoothly animate the fader mesh to the position matching `vol`. */
function setSliderVolume(vol, duration = 0.28) {
  if (!O.sliderState || !O.sliderState.mesh) return;
  const s = O.sliderState;
  const t = vol / 100;
  const targetWorldZ = s.maxVal - t * (s.maxVal - s.minVal);
  
  const mesh = s.mesh;
  const worldPos = new THREE.Vector3();
  mesh.getWorldPosition(worldPos);
  worldPos.z = targetWorldZ;
  
  if (mesh.parent) {
    mesh.parent.updateMatrixWorld(true);
    mesh.parent.worldToLocal(worldPos);
  }

  if (duration === 0) {
    mesh.position.copy(worldPos);
  } else {
    gsap.to(mesh.position, {
      x: worldPos.x,
      y: worldPos.y,
      z: worldPos.z,
      duration: duration,
      ease: 'power2.out'
    });
  }
}

/* ══════════════════════════════════════════════════════
   3D BUTTON RAYCASTING  +  FADER DRAG
   ══════════════════════════════════════════════════════ */
function setup3DControls() {
  const canvas = document.getElementById('scene-canvas');
  canvas.style.pointerEvents = 'auto';

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  /* ── Pointer Down — start fader drag or button press ── */
  canvas.addEventListener('pointerdown', (e) => {
    mouse.x = (e.offsetX / canvas.clientWidth) * 2 - 1;
    mouse.y = -(e.offsetY / canvas.clientHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, O.camera);

    if (O.hitboxes && O.hitboxes.length > 0) {
      const intersects = raycaster.intersectObjects(O.hitboxes, true);
      if (intersects.length > 0) {
        let hit = intersects[0].object;
        let action = hit.userData.action;
        while (!action && hit.parent) {
          hit = hit.parent;
          action = hit.userData.action;
        }
        if (action) {
          let physMesh = null;
          if (action === 'playpause') physMesh = O.btnPlay;
          if (action === 'rewind') physMesh = O.btnRew;
          if (action === 'fastforward') physMesh = O.btnFwd;
          
          handleControlAction(action, e, hit);
        }
      }
    }
  });

  /* ── Hover glow ── */
  canvas.addEventListener('pointermove', e => {
    if (isDraggingTempo) {
      canvas.style.cursor = 'ns-resize';
      // Clear hover mesh and glow while dragging to avoid any stuck hover effect
      if (O.hoverMesh) {
        setMeshEmissive(O.hoverMesh, 0x000000);
        O.hoverMesh = null;
      }
      return;
    }

    mouse.x = (e.offsetX / canvas.clientWidth) * 2 - 1;
    mouse.y = -(e.offsetY / canvas.clientHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, O.camera);

    let hitAction = null;
    let sliderHit = false;

    if (O.hitboxes && O.hitboxes.length > 0) {
      const hits = raycaster.intersectObjects(O.hitboxes, true);
      if (hits.length > 0) {
        hitAction = hits[0].object.userData.action;
        sliderHit = hits.some(h => h.object.userData.action === 'tempo');
      }
    }

    let physMesh = null;
    if (hitAction === 'playpause') physMesh = O.btnPlay;
    if (hitAction === 'rewind') physMesh = O.btnRew;
    if (hitAction === 'fastforward') physMesh = O.btnFwd;

    if (physMesh !== O.hoverMesh) {
      if (O.hoverMesh) setMeshEmissive(O.hoverMesh, 0x000000);
      O.hoverMesh = physMesh;
      // Disable hover emissive glow on buttons to prevent stuck hover highlights
      // if (O.hoverMesh) setMeshEmissive(O.hoverMesh, 0x444455);
    }
    
    canvas.style.cursor = hitAction ? (sliderHit ? 'ns-resize' : 'pointer') : '';
  });

  canvas.addEventListener('mouseleave', () => {
    if (O.hoverMesh) { setMeshEmissive(O.hoverMesh, 0x000000); O.hoverMesh = null; }
    canvas.style.cursor = '';
  });

  // Click actions are now entirely handled by pointerdown on hitboxes.
}

function setMeshEmissive(obj, hex) {
  if (!obj || !obj.material || !obj.material.emissive) return;
  obj.material.emissive.setHex(hex);
}



function action3DVolume(delta) {
  S.volume = Math.max(0, Math.min(100, S.volume + delta));
  if (S.ytPlayer?.setVolume) try { S.ytPlayer.setVolume(S.volume); } catch { }
  setSliderVolume(S.volume);   // animate fader to new position
  setStatus(`Volume: ${S.volume}%`);
  setTimeout(() => setStatus(S.mode === 'playing' ? 'Playing' : 'Ready to play'), 1200);
}

function action3DPlayPause() {
  if (!S.ytPlayer || !S.ytReady) return;
  try {
    const st = S.ytPlayer.getPlayerState();
    if (st === 1) {
      S.ytPlayer.pauseVideo();
      S.targetSpin = VINYL_IDLE_RAD_S;
      setChipPlaying(false);
      setPlayIcon(false);
    } else {
      S.ytPlayer.playVideo();
      S.targetSpin = VINYL_RAD_S;
      setChipPlaying(true);
      setPlayIcon(true);
    }
  } catch { }
}

function action3DSeek(delta) {
  if (!S.ytPlayer?.getCurrentTime) return;
  try {
    const cur = S.ytPlayer.getCurrentTime() || 0;
    S.ytPlayer.seekTo(Math.max(0, cur + delta), true);
    setStatus(delta > 0 ? `+${delta}s ⏩` : `${delta}s ⏪`);
    setTimeout(() => setStatus(S.mode === 'playing' ? 'Playing' : 'Ready to play'), 900);
  } catch { }
}

/** circling button — toggles 2× speed boost */
function action3DSpeedBoost() {
  S.speedBoost = !S.speedBoost;
  // 2× speed when boosted, normal speed when off
  if (S.mode === 'playing') {
    S.targetSpin = S.speedBoost ? VINYL_RAD_S * 2.5 : VINYL_RAD_S;
  }

  // Tint the button to show its state
  setMeshEmissive(O.btnSpeed, S.speedBoost ? 0x00aaff : 0x000000);
  setStatus(S.speedBoost ? '⚡ Speed Boost ON' : 'Normal Speed');
  setTimeout(() => setStatus(S.mode === 'playing' ? 'Playing' : 'Ready to play'), 1200);
}

/** Circling — restarts song from the beginning */
function action3DRestartSong() {
  if (S.ytPlayer?.seekTo) {
    try { S.ytPlayer.seekTo(0, true); } catch { }
  }
  setStatus('Restarting 🔄');
  setTimeout(() => setStatus(S.mode === 'playing' ? 'Playing' : 'Ready to play'), 1200);
}

function setPlayIcon(playing) {
  document.getElementById('ico-play').style.display = playing ? 'none' : '';
  document.getElementById('ico-pause').style.display = playing ? '' : 'none';
}

function setChipPlaying(yes) {
  const dot = document.getElementById('chip-dot');
  yes ? dot.classList.add('playing') : dot.classList.remove('playing');
  
  if (O.ledStrips && O.ledStrips.material) {
    if (yes) {
      // Playing: restore original ice blue and glow
      if (O.ledStrips.userData.origColor) O.ledStrips.material.color.copy(O.ledStrips.userData.origColor);
      if (O.ledStrips.userData.origEmissive) O.ledStrips.material.emissive.copy(O.ledStrips.userData.origEmissive);
      O.ledStrips.material.emissiveIntensity = O.ledStrips.userData.origIntensity || 2.0;
    } else {
      // Paused: set to gray shade
      O.ledStrips.material.color.setHex(0xaab4c2); // Lighter gray shade
      O.ledStrips.material.emissive.setHex(0x000000);
      O.ledStrips.material.emissiveIntensity = 0.0;
    }
    O.ledStrips.material.needsUpdate = true;
  }
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
function thumbUrl(id) { return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`; }
function fmtTime(sec) { const m = Math.floor(sec / 60); const s = String(Math.floor(sec % 60)).padStart(2, '0'); return `${m}:${s}`; }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function debugLog(msg) {
  console.log(`[DEBUG] ${msg}`);
}

/* ══════════════════════════════════════════════════════
   WEBGL SHADER BACKGROUND
   ══════════════════════════════════════════════════════ */
function setupShaderBackground() {
  const canvas = document.getElementById('bg-shader-canvas');
  if (!canvas) return;

  const gl = canvas.getContext('webgl');
  if (!gl) {
    console.error('[ShaderBackground] WebGL not supported');
    return;
  }

  const vertexShaderSource = `
    attribute vec4 a_position;
    void main() {
      gl_Position = a_position;
    }
  `;

  const fragmentShaderSource = `
    precision mediump float;
    uniform vec2 iResolution; // Canvas resolution (width, height)
    uniform float iTime;       // Time in seconds since the animation started
    uniform vec2 iMouse;      // Mouse coordinates (x, y)
    uniform vec3 u_color;     // Custom color uniform

    void mainImage(out vec4 fragColor, in vec2 fragCoord){
        vec2 uv = (1.0 * fragCoord - iResolution.xy) / min(iResolution.x, iResolution.y);
        float t = iTime * 0.5;

        vec2 mouse_uv = (4.0 * iMouse - iResolution.xy) / min(iResolution.x, iResolution.y);

        float mouseInfluence = 0.0;
        if (length(iMouse) > 0.0) {
            float dist_to_mouse = distance(uv, mouse_uv);
            mouseInfluence = smoothstep(0.8, 0.0, dist_to_mouse);
        }

        for(float i = 8.0; i < 20.0; i++) {
            uv.x += 0.6 / i * cos(i * 2.5 * uv.y + t);
            uv.y += 0.6 / i * cos(i * 1.5 * uv.x + t);
        }

        float wave = abs(sin(t - uv.y - uv.x + mouseInfluence * 8.0));
        float glow = smoothstep(0.9, 0.0, wave);

        vec3 color = glow * u_color; // Use the custom color here

        fragColor = vec4(color, 1.0);
    }

    void main() {
        mainImage(gl_FragColor, gl_FragCoord.xy);
    }
  `;

  const compileShader = (type, source) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('[ShaderBackground] Shader compile error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };

  const vertexShader = compileShader(gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
  if (!vertexShader || !fragmentShader) return;

  const program = gl.createProgram();
  if (!program) return;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('[ShaderBackground] Program link error:', gl.getProgramInfoLog(program));
    return;
  }

  gl.useProgram(program);

  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW
  );

  const positionLocation = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  const iResolutionLocation = gl.getUniformLocation(program, 'iResolution');
  const iTimeLocation = gl.getUniformLocation(program, 'iTime');
  const iMouseLocation = gl.getUniformLocation(program, 'iMouse');
  const uColorLocation = gl.getUniformLocation(program, 'u_color');

  // Set standard color to premium lead-gray (#9AA4B0) to blend with brushed-silver turntable aesthetic
  const hexToRgb = (hex) => {
    const r = parseInt(hex.substring(1, 3), 16) / 255;
    const g = parseInt(hex.substring(3, 5), 16) / 255;
    const b = parseInt(hex.substring(5, 7), 16) / 255;
    return [r, g, b];
  };
  const [cr, cg, cb] = hexToRgb('#9AA4B0');
  gl.uniform3f(uColorLocation, cr, cg, cb);

  let mousePosition = { x: 0, y: 0 };
  let isHovering = false;

  const handleMouseMove = (event) => {
    const rect = canvas.getBoundingClientRect();
    mousePosition.x = event.clientX - rect.left;
    mousePosition.y = event.clientY - rect.top;
    isHovering = true;
  };

  const handleMouseEnter = () => {
    isHovering = true;
  };

  const handleMouseLeave = () => {
    isHovering = false;
    mousePosition = { x: 0, y: 0 };
  };

  window.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('mouseenter', handleMouseEnter);
  window.addEventListener('mouseleave', handleMouseLeave);

  const startTime = Date.now();

  const render = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }

    const currentTime = (Date.now() - startTime) / 1000;

    gl.uniform2f(iResolutionLocation, width, height);
    gl.uniform1f(iTimeLocation, currentTime);
    gl.uniform2f(
      iMouseLocation,
      isHovering ? mousePosition.x : 0,
      isHovering ? height - mousePosition.y : 0
    );

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    requestAnimationFrame(render);
  };

  render();
}
