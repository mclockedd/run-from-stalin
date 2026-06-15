import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

// ---- world constants -------------------------------------------------------
const PLAYER_R = 18;
const EYE_H = 34;
const WALL_H = 95;
const BODY_H = 52;

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
    if (this.current) { this.current.pause(); this.current = null; }
    const url = this.pick(this.pools[mode]);
    if (!url) return;
    const a = new Audio(url);
    a.loop = true; a.volume = 0.45;
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
    myId = null; latest = null;
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
      myId = msg.id; roomCode = msg.code; isHost = msg.isHost;
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

// ---- the wheel (2D overlay) ------------------------------------------------
const wheelCanvas = document.getElementById("wheel");
const wctx = wheelCanvas.getContext("2d");
const WHEEL_COLORS = ["#c0392b", "#d4a017", "#27ae60", "#2980b9", "#8e44ad",
                      "#e67e22", "#16a085", "#c0392b", "#7f8c8d", "#e74c3c"];
function runWheel(players, winnerId) {
  show("wheel");
  document.getElementById("wheelTitle").textContent = "Choosing Stalin…";
  const n = players.length;
  const seg = (Math.PI * 2) / n;
  const winnerIdx = players.findIndex((p) => p.id === winnerId);
  const targetMid = winnerIdx * seg + seg / 2;
  const turns = 5 + Math.floor(Math.random() * 4);     // vary the spin each time
  const finalRot = (Math.PI * 2 * turns) + (-Math.PI / 2 - targetMid);
  const dur = 4200;
  const start = performance.now();
  function frame(now) {
    const t = Math.min(1, (now - start) / dur);
    const ease = 1 - Math.pow(1 - t, 3);
    drawWheel(players, seg, finalRot * ease);
    if (t < 1) requestAnimationFrame(frame);
    else document.getElementById("wheelTitle").innerHTML =
      `<span class="red">${escapeHtml(players[winnerIdx].name)}</span> is Stalin!`;
  }
  requestAnimationFrame(frame);
}
function drawWheel(players, seg, rot) {
  const cx = 210, cy = 210, r = 195;
  wctx.clearRect(0, 0, 420, 420);
  players.forEach((p, i) => {
    const a0 = rot + i * seg, a1 = a0 + seg;
    wctx.beginPath(); wctx.moveTo(cx, cy); wctx.arc(cx, cy, r, a0, a1); wctx.closePath();
    wctx.fillStyle = WHEEL_COLORS[i % WHEEL_COLORS.length]; wctx.fill();
    wctx.strokeStyle = "rgba(0,0,0,.35)"; wctx.lineWidth = 2; wctx.stroke();
    wctx.save(); wctx.translate(cx, cy); wctx.rotate(a0 + seg / 2);
    wctx.fillStyle = "#fff"; wctx.font = "bold 16px Segoe UI, sans-serif";
    wctx.textAlign = "right"; wctx.textBaseline = "middle";
    wctx.fillText(p.name, r - 18, 0); wctx.restore();
  });
  wctx.beginPath(); wctx.arc(cx, cy, 26, 0, Math.PI * 2);
  wctx.fillStyle = "#1d1712"; wctx.fill();
  wctx.strokeStyle = "#d4a017"; wctx.lineWidth = 3; wctx.stroke();
  wctx.beginPath(); wctx.moveTo(cx - 16, 6); wctx.lineTo(cx + 16, 6); wctx.lineTo(cx, 40);
  wctx.closePath(); wctx.fillStyle = "#f3e9d8"; wctx.fill();
}

// ---- three.js scene --------------------------------------------------------
const sceneEl = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
sceneEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x3a3550);
scene.fog = new THREE.Fog(0x3a3550, 300, 1900);

const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 6000);
camera.rotation.order = "YXZ";

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

scene.add(new THREE.HemisphereLight(0xfff1d0, 0x4a3a2a, 1.25));
const sun = new THREE.DirectionalLight(0xffe6b8, 1.1);
sun.position.set(0.5, 1, 0.3);
scene.add(sun);
scene.add(new THREE.AmbientLight(0x6a5f50, 0.5));

let floor = null;
let wallGroup = new THREE.Group();
scene.add(wallGroup);
let builtWorldKey = "";

function buildWorld(s) {
  const key = s.phase === "lobby" ? "lobby" : "game";
  const fullKey = key + ":" + s.world.w + "x" + s.world.h + ":" + (s.walls ? s.walls.length : 0);
  if (fullKey === builtWorldKey) return;
  builtWorldKey = fullKey;

  if (floor) { scene.remove(floor); floor.geometry.dispose(); floor.material.dispose(); }
  const tex = makeGridTexture();
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(s.world.w / 80, s.world.h / 80);
  floor = new THREE.Mesh(
    new THREE.PlaneGeometry(s.world.w, s.world.h),
    new THREE.MeshStandardMaterial({ map: tex, color: key === "lobby" ? 0x5a4a6a : 0x6b5a3f, roughness: 1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(s.world.w / 2, 0, s.world.h / 2);
  scene.add(floor);

  wallGroup.clear();
  const wallMat = new THREE.MeshStandardMaterial({ color: key === "lobby" ? 0x6a5340 : 0x5a4632, roughness: 0.9 });
  for (const w of s.walls || []) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(w.w, WALL_H, w.h), wallMat);
    box.position.set(w.x + w.w / 2, WALL_H / 2, w.y + w.h / 2);
    wallGroup.add(box);
  }
}

function makeGridTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "#241c14"; g.fillRect(0, 0, 64, 64);
  g.strokeStyle = "#3a2d1e"; g.lineWidth = 2; g.strokeRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

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
  const head = new THREE.Mesh(new THREE.SphereGeometry(PLAYER_R * 0.7, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xf0c27a, roughness: 0.6 }));
  head.position.y = BODY_H + 4;
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
});
window.addEventListener("keyup", (e) => pressed.delete(e.code));
window.addEventListener("blur", () => pressed.clear());

// ---- HUD / overlays from state ---------------------------------------------
function onState(msg) {
  show("game");
  onResize();

  const lobby = msg.phase === "lobby";
  document.getElementById("lobbyHud").classList.toggle("hidden", !lobby);
  document.getElementById("hud").style.display = lobby ? "none" : "flex";
  document.getElementById("playHint").classList.toggle("hidden", msg.phase !== "playing");

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
    if (me.stalin) { roleEl.textContent = "You are STALIN — catch them all"; roleEl.className = "role stalin"; }
    else if (me.caught) { roleEl.textContent = "Caught! Spectating…"; roleEl.className = "role"; }
    else { roleEl.textContent = "RUN! Survive the timer"; roleEl.className = "role runner"; }
  }
  const timerEl = document.getElementById("timer");
  timerEl.textContent = Math.ceil(msg.timeLeft);
  timerEl.classList.toggle("low", msg.timeLeft <= 15);

  const runnersTotal = msg.players.filter((p) => !p.stalin).length;
  const runnersAlive = msg.players.filter((p) => !p.stalin && !p.caught).length;
  document.getElementById("alive").textContent = `Runners left: ${runnersAlive} / ${runnersTotal}`;

  // kill sound when the caught count grows during play
  if (msg.phase === "playing") {
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

  const k = Math.min(1, dt * 14);
  for (const a of avatars.values()) {
    if (!a.target) continue;
    a.render.x += (a.target.x - a.render.x) * k;
    a.render.y += (a.target.y - a.render.y) * k;
    a.render.face = lerpAngle(a.render.face, a.target.face || 0, k);
    a.group.position.set(a.render.x, 0, a.render.y);
    a.group.rotation.y = -a.render.face;
  }

  const me = avatars.get(myId);
  if (me) camera.position.set(me.render.x, EYE_H, me.render.y);
  else camera.position.set(latest.world.w / 2, 300, latest.world.h / 2);
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;

  renderer.render(scene, camera);
  drawRadar();
  updateWalkSound();
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
