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
let lobbyPlayers = [];

const screens = {
  home: document.getElementById("home"),
  lobby: document.getElementById("lobby"),
  wheel: document.getElementById("wheelScreen"),
  game: document.getElementById("game"),
};
function show(name) {
  for (const k in screens) screens[k].classList.toggle("active", k === name);
}

// ---- networking ------------------------------------------------------------
function connect(onOpenMsg) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify(onOpenMsg));
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    if (myId) showHomeError("Disconnected from server.");
    myId = null;
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
      document.getElementById("codeDisplay").textContent = roomCode;
      show("lobby");
      break;
    case "lobby":
      lobbyPlayers = msg.players;
      isHost = msg.hostId === myId;
      renderLobby();
      show("lobby");
      break;
    case "wheel": runWheel(msg.players, msg.winnerId); break;
    case "state": latest = msg; onState(msg); break;
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

// ---- lobby -----------------------------------------------------------------
function renderLobby() {
  const ul = document.getElementById("playerList");
  ul.innerHTML = "";
  lobbyPlayers.forEach((p) => {
    const li = document.createElement("li");
    const nm = document.createElement("span");
    nm.textContent = p.name + (p.id === myId ? " (you)" : "");
    li.appendChild(nm);
    if (p.isHost) { const h = document.createElement("span"); h.className = "host"; h.textContent = "HOST"; li.appendChild(h); }
    ul.appendChild(li);
  });
  const spin = document.getElementById("spinBtn");
  const hint = document.getElementById("lobbyHint");
  spin.style.display = isHost ? "block" : "none";
  if (isHost) {
    const enough = lobbyPlayers.length >= 2;
    spin.disabled = !enough;
    hint.textContent = enough ? "" : "Need at least 2 players to spin.";
  } else {
    hint.textContent = "Waiting for the host to spin the wheel…";
  }
}
document.getElementById("spinBtn").onclick = () => send({ type: "spin" });

// ---- the wheel (still 2D) --------------------------------------------------
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
  const finalRot = (Math.PI * 2 * 6) + (-Math.PI / 2 - targetMid);
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
  const key = s.world.w + "x" + s.world.h + ":" + (s.walls ? s.walls.length : 0);
  if (key === builtWorldKey) return;
  builtWorldKey = key;

  if (floor) { scene.remove(floor); floor.geometry.dispose(); floor.material.dispose(); }
  const tex = makeGridTexture();
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(s.world.w / 80, s.world.h / 80);
  floor = new THREE.Mesh(
    new THREE.PlaneGeometry(s.world.w, s.world.h),
    new THREE.MeshStandardMaterial({ map: tex, color: 0x6b5a3f, roughness: 1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(s.world.w / 2, 0, s.world.h / 2);
  scene.add(floor);

  wallGroup.clear();
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.9 });
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
  g.strokeStyle = "#3a2d1e"; g.lineWidth = 2;
  g.strokeRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function makeNameSprite(text) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const g = c.getContext("2d");
  g.font = "bold 30px Segoe UI, sans-serif";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.lineWidth = 6; g.strokeStyle = "rgba(0,0,0,.85)";
  g.strokeText(text, 128, 32);
  g.fillStyle = "#f3e9d8";
  g.fillText(text, 128, 32);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: true }));
  spr.scale.set(120, 30, 1);
  return spr;
}

// player avatars keyed by id
const avatars = new Map();   // id -> { group, body, head, label, render:{x,y,face} }

function makeAvatar(p) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xd4a017, roughness: 0.6 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(PLAYER_R, BODY_H - PLAYER_R * 2, 4, 10), mat);
  body.position.y = BODY_H / 2;
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(PLAYER_R * 0.7, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xf0c27a, roughness: 0.6 })
  );
  head.position.y = BODY_H + 4;
  // little nose so you can read facing direction
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

renderer.domElement.addEventListener("click", () => {
  if (latest && (latest.phase === "playing" || latest.phase === "countdown"))
    renderer.domElement.requestPointerLock();
});
document.getElementById("lockPrompt").addEventListener("click", () => renderer.domElement.requestPointerLock());

document.addEventListener("pointerlockchange", () => {
  locked = document.pointerLockElement === renderer.domElement;
  updateLockPrompt();
});
document.addEventListener("mousemove", (e) => {
  if (!locked) return;
  yaw -= e.movementX * sensitivity;
  pitch -= e.movementY * sensitivity;
  pitch = Math.max(-1.2, Math.min(1.2, pitch));
});
window.addEventListener("keydown", (e) => {
  if (["KeyW","KeyA","KeyS","KeyD","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.code)) {
    e.preventDefault(); pressed.add(e.code);
  }
});
window.addEventListener("keyup", (e) => pressed.delete(e.code));
window.addEventListener("blur", () => pressed.clear());

function updateLockPrompt() {
  const p = document.getElementById("lockPrompt");
  const inGame = latest && (latest.phase === "playing" || latest.phase === "countdown" || latest.phase === "gameover");
  const me = latest && latest.players.find((x) => x.id === myId);
  const show = inGame && !locked && !(latest.phase === "gameover") && !(me && me.caught && false);
  p.classList.toggle("hidden", !show);
  document.getElementById("lockTitle").textContent =
    latest && latest.phase === "countdown" ? "Get ready…" : "Click to play";
}

// ---- HUD / overlays from state ---------------------------------------------
function onState(msg) {
  if (msg.phase === "lobby") { document.exitPointerLock?.(); show("lobby"); return; }
  show("game");
  onResize();

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

  const co = document.getElementById("countdownOverlay");
  if (msg.phase === "countdown") { co.classList.remove("hidden"); co.textContent = msg.countdown > 0 ? msg.countdown : "GO!"; }
  else co.classList.add("hidden");

  const go = document.getElementById("gameoverOverlay");
  if (msg.phase === "gameover") {
    document.exitPointerLock?.();
    go.classList.remove("hidden");
    const t = document.getElementById("goText");
    if (msg.winner === "stalin") { t.textContent = `${msg.stalinName} caught everyone!`; t.className = "stalin"; }
    else { t.textContent = "The runners survived!"; t.className = "runners"; }
    document.getElementById("goSub").textContent = "Returning to lobby…";
    document.getElementById("againBtn").classList.toggle("hidden", !isHost);
  } else go.classList.add("hidden");

  syncAvatars(msg);
  updateLockPrompt();
}
document.getElementById("againBtn").onclick = () => send({ type: "restart" });

function syncAvatars(msg) {
  const seen = new Set();
  for (const p of msg.players) {
    seen.add(p.id);
    let a = avatars.get(p.id);
    if (!a) { a = makeAvatar(p); avatars.set(p.id, a); }
    a.target = p;                       // server truth, lerped each frame
    a.group.visible = p.id !== myId;    // don't render own body in first person
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

// ---- input send loop -------------------------------------------------------
let sendAccum = 0;
function sendInput(dt) {
  if (!latest || latest.phase !== "playing") return;
  sendAccum += dt;
  if (sendAccum < 0.04) return;        // ~25 Hz
  sendAccum = 0;
  const f = (pressed.has("KeyW") || pressed.has("ArrowUp") ? 1 : 0) - (pressed.has("KeyS") || pressed.has("ArrowDown") ? 1 : 0);
  const r = (pressed.has("KeyD") || pressed.has("ArrowRight") ? 1 : 0) - (pressed.has("KeyA") || pressed.has("ArrowLeft") ? 1 : 0);
  // forward / right on the ground plane from current yaw
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
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  if (!latest || !["playing", "countdown", "gameover"].includes(latest.phase)) return;

  buildWorld(latest);
  sendInput(dt);

  // interpolate avatars toward server positions
  const k = Math.min(1, dt * 14);
  for (const a of avatars.values()) {
    if (!a.target) continue;
    a.render.x += (a.target.x - a.render.x) * k;
    a.render.y += (a.target.y - a.render.y) * k;
    a.render.face = lerpAngle(a.render.face, a.target.face || 0, k);
    a.group.position.set(a.render.x, 0, a.render.y);
    a.group.rotation.y = -a.render.face;
  }

  // place camera at my avatar's eyes
  const me = avatars.get(myId);
  if (me) {
    camera.position.set(me.render.x, EYE_H, me.render.y);
  } else {
    camera.position.set(latest.world.w / 2, 300, latest.world.h / 2);
  }
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;

  renderer.render(scene, camera);
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
