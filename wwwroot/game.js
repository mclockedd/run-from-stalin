import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

// ---- world constants -------------------------------------------------------
const PLAYER_R = 18;
const EYE_H = 34;
const WALL_H = 95;
const BODY_H = 52;
const SPEED_RUN = 230;      // must match the server
const SPEED_STALIN = 255;
let selfPos = null;         // client-predicted position of the local player
let spectating = false;     // free-fly spectator state (after being caught)
let specPos = null;
let specMode = "free";      // "free" (fly) | "follow" (watch a player)
let specTargetId = null;

// ---- state -----------------------------------------------------------------
let ws;
let myId = null;
let isHost = false;
let roomCode = "";
let latest = null;          // last "state" message
let lastCaughtCount = 0;

const screens = {
  home: document.getElementById("home"),
  wheel: document.getElementById("wheelScreen"),
  game: document.getElementById("game"),
};
function show(name) {
  for (const k in screens) screens[k].classList.toggle("active", k === name);
}

// ---- audio -----------------------------------------------------------------
// Tracks are discovered from /api/sounds (any files named lobby*, game*, kill*
// in wwwroot/sounds). A fresh random track is picked each time we switch mode
// (enter the lobby / start a round); a random kill clip plays on each catch.
const Sound = {
  pools: { lobby: [], game: [], kill: [] },
  mode: null,        // "lobby" | "game"
  current: null,     // current looping HTMLAudioElement
  ready: false,      // becomes true after the first user gesture
  muted: localStorage.getItem("rfs_muted") === "1",
  async load() {
    try { this.pools = await (await fetch("/api/sounds")).json(); } catch { /* silent */ }
  },
  unlock() { this.ready = true; },
  pick(arr) { return arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null; },
  setMode(mode) {
    if (mode === this.mode) return;        // already in this mode → keep playing
    this.mode = mode;
    if (this.current) { this.current.onended = null; this.current.pause(); this.current = null; }
    this.queue = null; this.qi = 0;
    if (mode === "game") { this._playNext(); return; }   // game: shuffled playlist, no loop
    const url = this.pick(this.pools.lobby);             // lobby: single random track, looped
    if (!url) return;
    const a = new Audio(url);
    a.loop = true; a.volume = 0.18;
    this.current = a;
    if (this.ready && !this.muted) a.play().catch(() => {});
  },
  _shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; },
  _playNext() {
    if (this.mode !== "game") return;
    const pool = this.pools.game || [];
    if (pool.length === 0) return;
    if (!this.queue || this.qi >= this.queue.length) { this.queue = this._shuffle(pool.slice()); this.qi = 0; }
    const url = this.queue[this.qi++];
    const a = new Audio(url);
    a.loop = false; a.volume = 0.18;        // no loop — advance through the shuffle
    a.onended = () => { if (this.mode === "game") this._playNext(); };
    this.current = a;
    if (this.ready && !this.muted) a.play().catch(() => {});
  },
  playKill() {
    if (this.muted || !this.ready) return;
    const url = this.pick(this.pools.kill);
    if (!url) return;
    try { const k = new Audio(url); k.volume = 0.85; k.play().catch(() => {}); } catch {}
  },
  setMuted(m) {
    this.muted = m;
    localStorage.setItem("rfs_muted", m ? "1" : "0");
    if (m) { if (this.current) this.current.pause(); }
    else if (this.current) this.current.play().catch(() => {});
    refreshMuteBtn();
  },
};
Sound.load();
const muteBtn = document.getElementById("muteBtn");
function refreshMuteBtn() { muteBtn.textContent = Sound.muted ? "🔇" : "🔊"; }
muteBtn.onclick = () => Sound.setMuted(!Sound.muted);
refreshMuteBtn();

// ---- networking ------------------------------------------------------------
function connect(onOpenMsg) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify(onOpenMsg));
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    if (myId) showHomeError("Disconnected from server.");
    myId = null; latest = null; selfPos = null; spectating = false; specPos = null;
    if (Sound.current) Sound.current.pause();
    Sound.mode = null;
    showPause(false);
    show("home");
  };
}
function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handle(msg) {
  switch (msg.type) {
    case "error": showHomeError(msg.message); break;
    case "joined":
      myId = msg.id; roomCode = msg.code; isHost = msg.isHost; selfPos = null; spectating = false; specPos = null;
      document.getElementById("lobbyCodeVal").textContent = roomCode;
      Sound.unlock(); ensureAudioCtx(); Sound.setMode("lobby");
      show("game");
      break;
    case "wheel": runWheel(msg.players, msg.winnerId); break;
    case "state": latest = msg; onState(msg); break;
    case "taunt": playTaunt(msg.id); break;
  }
}

// ---- home ------------------------------------------------------------------
const nameInput = document.getElementById("nameInput");
nameInput.value = localStorage.getItem("rfs_name") || "";
function myName() {
  const n = nameInput.value.trim();
  localStorage.setItem("rfs_name", n);
  return n || "Player";
}
function showHomeError(t) { document.getElementById("homeError").textContent = t || ""; }

document.getElementById("createBtn").onclick = () => { showHomeError(""); connect({ type: "create", name: myName() }); };
document.getElementById("joinBtn").onclick = () => {
  const code = document.getElementById("codeInput").value.trim().toUpperCase();
  if (code.length < 4) { showHomeError("Enter a 4-letter code."); return; }
  showHomeError(""); connect({ type: "join", name: myName(), code });
};
document.getElementById("codeInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("joinBtn").click();
});

// ---- lobby HUD -------------------------------------------------------------
document.getElementById("spinBtn").onclick = () => send({ type: "spin" });

function renderLobbyHud(s) {
  document.getElementById("lobbyCodeVal").textContent = s.code || roomCode;
  const ul = document.getElementById("lobbyPlayers");
  ul.innerHTML = "";
  for (const p of s.players) {
    const li = document.createElement("li");
    const nm = document.createElement("span");
    nm.textContent = p.name + (p.id === myId ? " (you)" : "");
    li.appendChild(nm);
    if (p.id === s.hostId) { const h = document.createElement("span"); h.className = "host"; h.textContent = "HOST"; li.appendChild(h); }
    ul.appendChild(li);
  }
  const spin = document.getElementById("spinBtn");
  const hint = document.getElementById("lobbyHint");
  const enough = s.players.length >= 2;
  spin.style.display = isHost ? "inline-block" : "none";
  if (isHost) {
    spin.disabled = !enough;
    hint.textContent = enough ? "or press E to spin" : "Need at least 2 players to spin.";
  } else {
    hint.textContent = "Waiting for the host to spin the wheel…";
  }
}

// ---- killer reveal (slot-machine of player cards) --------------------------
const AVATARS = ["😀", "😎", "🤠", "🧐", "😴", "🤡", "👻", "🤖", "👽", "🐱", "🦊", "🐻"];
function runWheel(players, winnerId) {
  show("wheel");
  const title = document.getElementById("wheelTitle");
  title.textContent = "Choosing the Killer…";

  const wrap = document.getElementById("revealCards");
  wrap.innerHTML = "";
  const cards = players.map((p, i) => {
    const card = document.createElement("div");
    card.className = "reveal-card";
    card.innerHTML =
      `<div class="rc-crown">🔪</div>` +
      `<div class="rc-av">${AVATARS[i % AVATARS.length]}</div>` +
      `<div class="rc-name">${escapeHtml(p.name)}</div>` +
      `<div class="rc-tag">KILLER</div>`;
    wrap.appendChild(card);
    return card;
  });
  const n = cards.length;
  const winnerIdx = players.findIndex((p) => p.id === winnerId);
  const setActive = (idx) => cards.forEach((c, i) => c.classList.toggle("active", i === idx));

  // cycle the highlight, slowing down, then land + reveal
  const dur = 3000;
  const t0 = performance.now();
  let i = Math.floor(Math.random() * n);
  function step() {
    setActive(i % n);
    const elapsed = performance.now() - t0;
    if (elapsed >= dur && (i % n) === winnerIdx) { land(); return; }
    i++;
    const p = Math.min(1, elapsed / dur);
    setTimeout(step, 60 + p * p * 240);   // 60ms → ~300ms
  }
  function land() {
    cards.forEach((c, idx) => {
      c.classList.remove("active");
      if (idx === winnerIdx) c.classList.add("killer");
      else c.classList.add("dim");
    });
    title.innerHTML = `<span class="kill">${escapeHtml(players[winnerIdx].name)}</span> is THE KILLER`;
  }
  step();
}

// ---- three.js scene --------------------------------------------------------
const sceneEl = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
sceneEl.appendChild(renderer.domElement);

const SKY_TOP = new THREE.Color(0x1d2c52);
const SKY_HORIZON = new THREE.Color(0xd98a4e);
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x9c7350, 400, 2600);

const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 8000);
camera.rotation.order = "YXZ";

// gradient sky dome (follows the camera so the horizon stays put)
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(4000, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: SKY_TOP }, horizon: { value: SKY_HORIZON } },
    vertexShader: "varying vec3 vp; void main(){ vp = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: "varying vec3 vp; uniform vec3 top; uniform vec3 horizon; void main(){ float h = clamp((normalize(vp).y + 0.1) * 1.1, 0.0, 1.0); gl_FragColor = vec4(mix(horizon, top, pow(h, 0.55)), 1.0); }",
  })
);
scene.add(sky);

// Spatial audio: listener rides the camera, taunts play from the taunter's body.
const listener = new THREE.AudioListener();
camera.add(listener);
let tauntBuffer = null;
new THREE.AudioLoader().load("sounds/taunt.mp3", (b) => { tauntBuffer = b; }, undefined, () => {});
function ensureAudioCtx() {
  if (listener.context && listener.context.state === "suspended") listener.context.resume().catch(() => {});
}
function playTaunt(playerId) {
  if (!tauntBuffer || Sound.muted) return;
  const a = avatars.get(playerId);
  if (!a) return;
  try {
    const pa = new THREE.PositionalAudio(listener);
    pa.setBuffer(tauntBuffer);
    pa.setRefDistance(260);
    pa.setRolloffFactor(1.3);
    pa.setDistanceModel("inverse");
    if (pa.panner) pa.panner.panningModel = "HRTF";
    a.group.add(pa);
    pa.onEnded = () => { try { a.group.remove(pa); } catch {} };
    pa.play();
  } catch {}
}

// Local-only footstep loop — only YOU hear your own walking.
const walkAudio = new Audio("sounds/fart%20walk.mp3");
walkAudio.loop = true;
walkAudio.volume = 0.5;
function updateWalkSound() {
  const moving = MOVE_KEYS.some((k) => pressed.has(k));
  const me = latest && latest.players.find((p) => p.id === myId);
  const should = canMoveNow() && moving && !(me && me.caught) && !Sound.muted && Sound.ready;
  if (should) { if (walkAudio.paused) walkAudio.play().catch(() => {}); }
  else if (!walkAudio.paused) { walkAudio.pause(); }
}

scene.add(new THREE.HemisphereLight(0x9fb0d8, 0x5a4636, 0.65));
scene.add(new THREE.AmbientLight(0x55504a, 0.35));
const sun = new THREE.DirectionalLight(0xffe0b0, 1.7);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0006;
scene.add(sun);
scene.add(sun.target);

let floor = null;
let wallGroup = new THREE.Group();
scene.add(wallGroup);
let builtWorldKey = "";

function buildWorld(s) {
  const isLobby = s.phase === "lobby";
  const key = isLobby ? "lobby" : "game:" + (s.mapVersion || 0);
  if (key === builtWorldKey) return;       // only rebuild when the map actually changes
  builtWorldKey = key;

  if (floor) { scene.remove(floor); floor.geometry.dispose(); floor.material.map?.dispose(); floor.material.dispose(); }
  const ftex = floorBaseTex.clone(); ftex.needsUpdate = true;
  ftex.wrapS = ftex.wrapT = THREE.RepeatWrapping;
  ftex.repeat.set(s.world.w / 300, s.world.h / 300);
  floor = new THREE.Mesh(
    new THREE.PlaneGeometry(s.world.w, s.world.h),
    new THREE.MeshStandardMaterial({ map: ftex, color: isLobby ? 0x6a5a7a : 0x7d6a48, roughness: 1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(s.world.w / 2, 0, s.world.h / 2);
  floor.receiveShadow = true;
  scene.add(floor);

  // aim the sun + shadow camera at the centre of the current map
  const cxw = s.world.w / 2, czw = s.world.h / 2;
  sun.position.set(cxw + 900, 2000, czw + 700);
  sun.target.position.set(cxw, 0, czw);
  sun.target.updateMatrixWorld();
  const ext = Math.max(s.world.w, s.world.h) / 2 + 250;
  const sc = sun.shadow.camera;
  sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext;
  sc.near = 200; sc.far = 6000;
  sc.updateProjectionMatrix();

  // dispose old wall meshes + their textures
  for (const c of wallGroup.children) { c.geometry.dispose(); c.material.map?.dispose(); c.material.dispose(); }
  wallGroup.clear();

  const palette = isLobby ? [0x8a7560] : [0x9c7a52, 0x86684a, 0xa6885c, 0x756853, 0x97705a];
  const add = (geo, mat, x, y, z, ry) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    if (ry) m.rotation.y = ry;
    m.castShadow = true; m.receiveShadow = true;
    wallGroup.add(m);
    return m;
  };

  for (const w of s.walls || []) {
    const cx = w.x + w.w / 2, cz = w.y + w.h / 2;
    const seed = Math.abs(Math.sin(w.x * 12.9898 + w.y * 78.233)) % 1;
    const kind = w.kind || "building";

    if (kind === "building") {
      const isBorder = w.w >= s.world.w - 1 || w.h >= s.world.h - 1;
      const h = isBorder ? WALL_H : 90 + Math.floor(seed * 95);
      const col = palette[Math.floor(seed * 997) % palette.length];
      const wtex = wallBaseTex.clone(); wtex.needsUpdate = true;
      wtex.wrapS = wtex.wrapT = THREE.RepeatWrapping;
      wtex.repeat.set(Math.max(1, Math.round(w.w / 150)), Math.max(1, Math.round(h / 95)));
      add(new THREE.BoxGeometry(w.w, h, w.h), new THREE.MeshStandardMaterial({ map: wtex, color: col, roughness: 0.95 }), cx, h / 2, cz);
    } else if (kind === "crate") {
      const hh = Math.min(w.w, w.h) * (0.9 + seed * 0.4);
      add(new THREE.BoxGeometry(w.w, hh, w.h), new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.85 }), cx, hh / 2, cz, seed * 0.7);
    } else if (kind === "barrel") {
      const r = w.w / 2, hh = 70 + seed * 28;
      add(new THREE.CylinderGeometry(r, r, hh, 14), new THREE.MeshStandardMaterial({ color: seed < 0.5 ? 0x7a2e26 : 0x3f6e4a, roughness: 0.55, metalness: 0.3 }), cx, hh / 2, cz);
    } else if (kind === "rock") {
      const r = w.w * 0.58;
      add(new THREE.IcosahedronGeometry(r, 0), new THREE.MeshStandardMaterial({ color: 0x6f6a63, roughness: 1, flatShading: true }), cx, r * 0.55, cz, seed * 3).scale.y = 0.7;
    } else if (kind === "tower") {
      const r = w.w / 2, hh = 170 + seed * 70;
      add(new THREE.CylinderGeometry(r * 0.85, r, hh, 16), new THREE.MeshStandardMaterial({ color: 0x8c7d63, roughness: 0.95 }), cx, hh / 2, cz);
      add(new THREE.ConeGeometry(r * 1.15, r * 1.3, 16), new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.9 }), cx, hh + r * 0.65, cz);
    } else if (kind === "tree") {
      const trunkH = 70 + seed * 55;
      add(new THREE.CylinderGeometry(w.w * 0.32, w.w * 0.42, trunkH, 8), new THREE.MeshStandardMaterial({ color: 0x5b3a22, roughness: 1 }), cx, trunkH / 2, cz);
      const fr = 46 + seed * 38;
      add(new THREE.IcosahedronGeometry(fr, 0), new THREE.MeshStandardMaterial({ color: seed < 0.5 ? 0x3f6b32 : 0x4f7a3a, roughness: 1, flatShading: true }), cx, trunkH + fr * 0.55, cz).scale.y = 1.1;
    }
  }

  // bushes — decorative ground cover (walk-through)
  for (const p of s.props || []) {
    const fr = p.s * 0.6;
    const m = add(new THREE.IcosahedronGeometry(fr, 0), new THREE.MeshStandardMaterial({ color: 0x3e6233, roughness: 1, flatShading: true }), p.x + p.s / 2, fr * 0.5, p.y + p.s / 2, Math.random() * 3);
    m.scale.y = 0.65;
  }
}

// Procedural brick/panel texture (grayscale → tinted by the material color).
function makeWallTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "#b8b8b8"; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 3000; i++) {           // grain
    const v = (170 + Math.random() * 70) | 0;
    g.fillStyle = `rgba(${v},${v},${v},${Math.random() * 0.18})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  const bh = 36, bw = 64;
  g.strokeStyle = "rgba(40,35,30,0.55)"; g.lineWidth = 4;
  for (let row = 0; row * bh < 256; row++) {
    const y = row * bh;
    g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke();
    const off = (row % 2) ? bw / 2 : 0;
    for (let x = off; x <= 256; x += bw) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + bh); g.stroke(); }
    for (let x = off - bw; x < 256; x += bw)
      if (Math.random() < 0.5) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.14})`; g.fillRect(x + 3, y + 3, bw - 6, bh - 6); }
  }
  return new THREE.CanvasTexture(c);
}

// Procedural cobbled-ground texture.
function makeFloorTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "#aa9c86"; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 70; i++) {             // blotches
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.13})`;
    g.beginPath(); g.arc(Math.random() * 256, Math.random() * 256, 8 + Math.random() * 28, 0, 7); g.fill();
  }
  for (let i = 0; i < 4000; i++) {           // speckle
    const v = Math.random() < 0.5 ? 255 : 0;
    g.fillStyle = `rgba(${v},${v},${v},${Math.random() * 0.05})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  g.strokeStyle = "rgba(0,0,0,0.16)"; g.lineWidth = 3; g.strokeRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

const wallBaseTex = makeWallTexture();
const floorBaseTex = makeFloorTexture();

function makeNameSprite(text) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const g = c.getContext("2d");
  g.font = "bold 30px Segoe UI, sans-serif";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.lineWidth = 6; g.strokeStyle = "rgba(0,0,0,.85)"; g.strokeText(text, 128, 32);
  g.fillStyle = "#f3e9d8"; g.fillText(text, 128, 32);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: true }));
  spr.scale.set(120, 30, 1);
  return spr;
}

const avatars = new Map();

function makeAvatar(p) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xd4a017, roughness: 0.6 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(PLAYER_R, BODY_H - PLAYER_R * 2, 4, 10), mat);
  body.position.y = BODY_H / 2;
  body.castShadow = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(PLAYER_R * 0.7, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xf0c27a, roughness: 0.6 }));
  head.position.y = BODY_H + 4;
  head.castShadow = true;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(5, 14, 8), new THREE.MeshStandardMaterial({ color: 0x222 }));
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, BODY_H + 4, -PLAYER_R * 0.7 - 4);
  const label = makeNameSprite(p.name);
  label.position.y = BODY_H + 40;
  group.add(body, head, nose, label);
  scene.add(group);
  return { group, body, head, label, render: { x: p.x, y: p.y, face: p.face || 0 } };
}

// ---- first-person controls -------------------------------------------------
let yaw = 0, pitch = 0;
let locked = false;
const pressed = new Set();
const sensitivity = 0.0022;
const MOVE_KEYS = ["KeyW","KeyA","KeyS","KeyD","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"];

function typing() {
  const el = document.activeElement;
  return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}
function canMoveNow() {
  return latest && (latest.phase === "lobby" || latest.phase === "playing");
}

renderer.domElement.addEventListener("click", () => {
  if (canMoveNow() || (latest && latest.phase === "countdown")) renderer.domElement.requestPointerLock();
});
const pauseOverlay = document.getElementById("pauseOverlay");
function showPause(on) { pauseOverlay.classList.toggle("hidden", !on); }

document.addEventListener("pointerlockchange", () => {
  const nowLocked = document.pointerLockElement === renderer.domElement;
  // Releasing the mouse (Esc) while in the world opens the pause menu.
  if (locked && !nowLocked && latest && ["lobby", "playing", "countdown"].includes(latest.phase))
    showPause(true);
  if (nowLocked) showPause(false);
  locked = nowLocked;
});

document.getElementById("resumeBtn").onclick = () => {
  showPause(false);
  renderer.domElement.requestPointerLock();
};
document.getElementById("leaveBtn").onclick = () => {
  showPause(false);
  if (ws) ws.close();
};
document.addEventListener("mousemove", (e) => {
  if (!locked) return;
  yaw -= e.movementX * sensitivity;
  pitch -= e.movementY * sensitivity;
  pitch = Math.max(-1.2, Math.min(1.2, pitch));
});
let lastTauntSent = 0;
window.addEventListener("keydown", (e) => {
  if (typing()) return;                              // let people type their name/code
  if (MOVE_KEYS.includes(e.code)) { e.preventDefault(); pressed.add(e.code); }
  if (e.code === "KeyE" && isHost && latest && latest.phase === "lobby" && latest.players.length >= 2) {
    send({ type: "spin" });
  }
  if (e.code === "KeyT" && latest && latest.phase === "playing") {
    const now = performance.now();
    if (now - lastTauntSent >= 1200) { lastTauntSent = now; ensureAudioCtx(); send({ type: "taunt" }); }
  }
  // spectator controls (only while caught)
  const meK = latest && latest.players.find((p) => p.id === myId);
  if (meK && meK.caught) {
    if (e.code === "Space") { e.preventDefault(); cycleSpectate(); }
    if (e.code === "KeyF") { specMode = "free"; }
  }
});

// Cycle the followed player (alive players, not yourself). Switches to follow mode.
function cycleSpectate() {
  if (!latest) return;
  const cands = latest.players.filter((p) => p.id !== myId && !p.caught);
  if (!cands.length) { specMode = "free"; return; }
  let idx = cands.findIndex((p) => p.id === specTargetId);
  idx = (idx + 1) % cands.length;
  specTargetId = cands[idx].id;
  specMode = "follow";
}
window.addEventListener("keyup", (e) => pressed.delete(e.code));
window.addEventListener("blur", () => pressed.clear());

// ---- HUD / overlays from state ---------------------------------------------
function onState(msg) {
  show("game");
  onResize();

  const lobby = msg.phase === "lobby";
  document.getElementById("lobbyHud").classList.toggle("hidden", !lobby);
  document.getElementById("hud").style.display = lobby ? "none" : "block";
  document.getElementById("statusPanel").classList.toggle("hidden", lobby);
  const meP = msg.players.find((p) => p.id === myId);
  document.getElementById("playHint").classList.toggle("hidden", !(msg.phase === "playing" && !(meP && meP.caught)));

  // audio per phase — fresh random track when entering lobby vs a round
  Sound.setMode(lobby ? "lobby" : "game");

  if (lobby) {
    isHost = msg.hostId === myId;
    renderLobbyHud(msg);
    lastCaughtCount = 0;
  } else {
    isHost = msg.hostId === myId;
    updateRoundHud(msg);
  }

  // countdown overlay
  const co = document.getElementById("countdownOverlay");
  if (msg.phase === "countdown") { co.classList.remove("hidden"); co.textContent = msg.countdown > 0 ? msg.countdown : "GO!"; }
  else co.classList.add("hidden");

  // gameover overlay
  const go = document.getElementById("gameoverOverlay");
  if (msg.phase === "gameover") {
    document.exitPointerLock?.();
    showPause(false);
    go.classList.remove("hidden");
    const t = document.getElementById("goText");
    if (msg.winner === "stalin") { t.textContent = `${msg.stalinName} caught everyone!`; t.className = "stalin"; }
    else { t.textContent = "The runners survived!"; t.className = "runners"; }
    document.getElementById("goSub").textContent = "Returning to lobby…";
    document.getElementById("againBtn").classList.toggle("hidden", !isHost);
  } else go.classList.add("hidden");

  syncAvatars(msg);

  // Safeguard: if requestAnimationFrame is being throttled (background tab,
  // some headless contexts), draw on the incoming state so the world still
  // shows. When rAF is healthy this is a no-op.
  if (performance.now() - lastRafRender > 100) renderScene(0);
}
document.getElementById("againBtn").onclick = () => send({ type: "restart" });

function updateRoundHud(msg) {
  const me = msg.players.find((p) => p.id === myId);
  const roleEl = document.getElementById("role");
  if (me) {
    if (me.stalin) { roleEl.textContent = "You are THE KILLER — catch them all"; roleEl.className = "role stalin"; }
    else if (me.caught) { roleEl.textContent = "Caught! Spectating — fly with WASD"; roleEl.className = "role"; }
    else { roleEl.textContent = "RUN! Survive the timer"; roleEl.className = "role runner"; }
  }
  const timerEl = document.getElementById("timer");
  timerEl.textContent = Math.ceil(msg.timeLeft);
  timerEl.classList.toggle("low", msg.timeLeft <= 15);

  // scoreboard: killer + alive/caught runners
  const killer = msg.players.find((p) => p.stalin);
  document.getElementById("killerName").textContent = killer ? killer.name : "—";
  const runners = msg.players.filter((p) => !p.stalin);
  const list = document.getElementById("statusList");
  list.innerHTML = "";
  for (const p of runners) {
    const li = document.createElement("li");
    if (p.caught) li.className = "caught";
    li.innerHTML = `<span class="dot"></span><span class="nm">${p.caught ? "💀 " : ""}${escapeHtml(p.name)}</span>`;
    if (p.id === myId) { const y = document.createElement("span"); y.className = "you"; y.textContent = "you"; li.appendChild(y); }
    list.appendChild(li);
  }
  const alive = runners.filter((p) => !p.caught).length;
  document.getElementById("statusSummary").textContent = `${alive} alive · ${runners.length - alive} caught`;

  // kill sound when the caught count grows — incl. the FINAL catch, which the
  // server delivers in the "gameover" state (same tick the round ends).
  if (msg.phase === "countdown") {
    lastCaughtCount = 0;
  } else if (msg.phase === "playing" || msg.phase === "gameover") {
    const caught = msg.players.filter((p) => p.caught).length;
    if (caught > lastCaughtCount) Sound.playKill();
    lastCaughtCount = caught;
  }
}

function syncAvatars(msg) {
  const seen = new Set();
  for (const p of msg.players) {
    seen.add(p.id);
    let a = avatars.get(p.id);
    if (!a) { a = makeAvatar(p); avatars.set(p.id, a); }
    a.target = p;
    a.group.visible = p.id !== myId;             // hide own body in first person
    const col = p.stalin ? 0xc0392b : (p.caught ? 0x666666 : 0xd4a017);
    a.body.material.color.setHex(col);
    a.body.material.opacity = p.caught ? 0.45 : 1;
    a.body.material.transparent = p.caught;
    a.label.material.opacity = p.caught ? 0.4 : 1;
  }
  for (const [id, a] of avatars) {
    if (!seen.has(id)) { scene.remove(a.group); avatars.delete(id); }
  }
}

// ---- radar / minimap -------------------------------------------------------
const radar = document.getElementById("radar");
const rctx = radar.getContext("2d");
function drawRadar() {
  const active = latest && (latest.phase === "playing" || latest.phase === "countdown");
  radar.classList.toggle("hidden", !active);
  if (!active) return;

  const W = radar.width, H = radar.height;
  const sx = W / latest.world.w, sy = H / latest.world.h;
  rctx.clearRect(0, 0, W, H);

  // map walls
  rctx.fillStyle = "rgba(190,160,115,.55)";
  for (const w of latest.walls || [])
    rctx.fillRect(w.x * sx, w.y * sy, Math.max(1, w.w * sx), Math.max(1, w.h * sy));

  // player blips, per visibility rules:
  //  - runners see all runners (incl. self), never Stalin
  //  - Stalin sees no players, only the map
  const me = latest.players.find((p) => p.id === myId);
  const amStalin = me && me.stalin;
  for (const p of latest.players) {
    const isMe = p.id === myId;
    if (!isMe) {
      if (amStalin) continue;     // Stalin sees no OTHER players on radar
      if (p.stalin) continue;     // runners never see Stalin
    }
    const a = avatars.get(p.id);
    const px = (a ? a.render.x : p.x) * sx;
    const py = (a ? a.render.y : p.y) * sy;
    rctx.beginPath();
    rctx.arc(px, py, isMe ? 4.5 : 3, 0, Math.PI * 2);
    rctx.fillStyle = isMe ? (p.stalin ? "#e74c3c" : "#ffffff")
                          : (p.caught ? "rgba(150,150,150,.5)" : "#d4a017");
    rctx.fill();
  }
}

// ---- input send loop -------------------------------------------------------
let sendAccum = 0;
function sendInput(dt) {
  if (!canMoveNow()) return;
  sendAccum += dt;
  if (sendAccum < 0.04) return;
  sendAccum = 0;
  const f = (pressed.has("KeyW") || pressed.has("ArrowUp") ? 1 : 0) - (pressed.has("KeyS") || pressed.has("ArrowDown") ? 1 : 0);
  const r = (pressed.has("KeyD") || pressed.has("ArrowRight") ? 1 : 0) - (pressed.has("KeyA") || pressed.has("ArrowLeft") ? 1 : 0);
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  let mx = fx * f + rx * r;
  let my = fz * f + rz * r;
  const len = Math.hypot(mx, my);
  if (len > 1) { mx /= len; my /= len; }
  send({ type: "input", mx, my, face: yaw });
}

// ---- render loop -----------------------------------------------------------
let lastT = performance.now();
let lastRafRender = 0;

function renderScene(dt) {
  if (!latest || !["lobby", "playing", "countdown", "gameover"].includes(latest.phase)) return;

  buildWorld(latest);
  sendInput(dt);

  // Remote players: smooth interpolation toward the latest server state.
  const k = Math.min(1, dt * 14);
  for (const a of avatars.values()) {
    if (!a.target || a.target.id === myId) continue;   // local player is predicted below
    a.render.x += (a.target.x - a.render.x) * k;
    a.render.y += (a.target.y - a.render.y) * k;
    a.render.face = lerpAngle(a.render.face, a.target.face || 0, k);
    a.group.position.set(a.render.x, 0, a.render.y);
    a.group.rotation.y = -a.render.face;
  }

  const meNow = latest.players.find((p) => p.id === myId);
  const specHintEl = document.getElementById("specHint");
  let camHandled = false;

  if (meNow && meNow.caught) {
    specHintEl.classList.remove("hidden");
    // Follow-a-player view (see from their position, their facing).
    if (specMode === "follow") {
      const t = latest.players.find((p) => p.id === specTargetId && !p.caught);
      const a = t && avatars.get(t.id);
      if (a) {
        camera.position.set(a.render.x, EYE_H, a.render.y);
        camera.rotation.y = a.render.face;
        camera.rotation.x = 0;
        camHandled = true;
        specHintEl.textContent = `Watching ${t.name}   ·   SPACE: next player   ·   F: free-fly`;
      } else {
        specMode = "free";        // target left or got caught → back to free-fly
      }
    }
    if (specMode === "free") {
      spectateFly(dt);
      camera.position.set(specPos.x, specPos.y, specPos.z);
      specHintEl.textContent = "Free-fly   ·   WASD + mouse   ·   SPACE: watch a player";
    }
  } else {
    specHintEl.classList.add("hidden");
    spectating = false; specMode = "free"; specTargetId = null;
    // Local player: client-side prediction (instant, no 30Hz stutter).
    predictSelf(dt);
    const myAv = avatars.get(myId);
    if (selfPos && myAv) {
      myAv.render.x = selfPos.x; myAv.render.y = selfPos.y;
      myAv.group.position.set(selfPos.x, 0, selfPos.y);
      myAv.group.rotation.y = -yaw;
    }
    if (selfPos) camera.position.set(selfPos.x, EYE_H, selfPos.y);
    else camera.position.set(latest.world.w / 2, 300, latest.world.h / 2);
  }

  if (!camHandled) { camera.rotation.y = yaw; camera.rotation.x = pitch; }

  sky.position.copy(camera.position);   // keep the horizon centred on the viewer
  renderer.render(scene, camera);
  drawRadar();
  updateWalkSound();
}

// Predict the local player from input each frame, then softly correct toward
// the authoritative server position (handles collisions, catches, spawns).
function predictSelf(dt) {
  const me = latest.players.find((p) => p.id === myId);
  if (!me) { selfPos = null; return; }
  if (!selfPos) { selfPos = { x: me.x, y: me.y }; return; }

  const canWalk = dt > 0 && !me.caught && (latest.phase === "playing" || latest.phase === "lobby");
  if (canWalk) {
    const f = (pressed.has("KeyW") || pressed.has("ArrowUp") ? 1 : 0) - (pressed.has("KeyS") || pressed.has("ArrowDown") ? 1 : 0);
    const r = (pressed.has("KeyD") || pressed.has("ArrowRight") ? 1 : 0) - (pressed.has("KeyA") || pressed.has("ArrowLeft") ? 1 : 0);
    if (f || r) {
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
      let mx = fx * f + rx * r, my = fz * f + rz * r;
      const len = Math.hypot(mx, my); if (len > 1) { mx /= len; my /= len; }
      const speed = me.stalin ? SPEED_STALIN : SPEED_RUN;
      clientMove(selfPos, mx * speed * dt, my * speed * dt);
    }
  }

  // reconcile: snap big jumps (spawn); ignore tiny latency drift (dead zone) so
  // the camera doesn't fight the prediction; gently correct medium desyncs.
  const ddx = me.x - selfPos.x, ddy = me.y - selfPos.y;
  const d2 = ddx * ddx + ddy * ddy;
  if (d2 > 260 * 260) { selfPos.x = me.x; selfPos.y = me.y; }
  else if (d2 > 48 * 48) { const c = Math.min(1, dt * 8); selfPos.x += ddx * c; selfPos.y += ddy * c; }
}

// Free-flying spectator camera (after being caught). Full 3D movement, no walls.
function spectateFly(dt) {
  if (!spectating || !specPos) {
    spectating = true;
    specPos = {
      x: selfPos ? selfPos.x : latest.world.w / 2,
      y: EYE_H + 40,
      z: selfPos ? selfPos.y : latest.world.h / 2,
    };
  }
  if (dt <= 0) return;
  const f = (pressed.has("KeyW") || pressed.has("ArrowUp") ? 1 : 0) - (pressed.has("KeyS") || pressed.has("ArrowDown") ? 1 : 0);
  const r = (pressed.has("KeyD") || pressed.has("ArrowRight") ? 1 : 0) - (pressed.has("KeyA") || pressed.has("ArrowLeft") ? 1 : 0);
  const cp = Math.cos(pitch);
  const fwd = { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
  const rgt = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
  const sp = 430;
  specPos.x += (fwd.x * f + rgt.x * r) * sp * dt;
  specPos.y += (fwd.y * f) * sp * dt;
  specPos.z += (fwd.z * f + rgt.z * r) * sp * dt;
  specPos.x = Math.max(0, Math.min(latest.world.w, specPos.x));
  specPos.z = Math.max(0, Math.min(latest.world.h, specPos.z));
  specPos.y = Math.max(12, Math.min(800, specPos.y));
}

// Client-side copy of the server's circle-vs-rect collision (must match).
function clientMove(pos, dx, dy) {
  const walls = latest.walls || [], W = latest.world.w, H = latest.world.h, R = PLAYER_R;
  pos.x += dx; resolveAxisC(pos, walls, true, R);
  pos.y += dy; resolveAxisC(pos, walls, false, R);
  pos.x = Math.max(R, Math.min(W - R, pos.x));
  pos.y = Math.max(R, Math.min(H - R, pos.y));
}
function resolveAxisC(pos, walls, xAxis, R) {
  for (const w of walls) {
    const cx = Math.max(w.x, Math.min(pos.x, w.x + w.w));
    const cy = Math.max(w.y, Math.min(pos.y, w.y + w.h));
    const dx = pos.x - cx, dy = pos.y - cy;
    if (dx * dx + dy * dy >= R * R) continue;
    if (xAxis) pos.x = (pos.x < w.x + w.w / 2) ? w.x - R : w.x + w.w + R;
    else pos.y = (pos.y < w.y + w.h / 2) ? w.y - R : w.y + w.h + R;
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  lastRafRender = now;
  renderScene(dt);
}
requestAnimationFrame(frame);

// ---- helpers ---------------------------------------------------------------
function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", onResize);
onResize();

function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
