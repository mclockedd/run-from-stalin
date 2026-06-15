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
    case "error":
      showHomeError(msg.message);
      break;
    case "joined":
      myId = msg.id;
      roomCode = msg.code;
      isHost = msg.isHost;
      document.getElementById("codeDisplay").textContent = roomCode;
      show("lobby");
      break;
    case "lobby":
      lobbyPlayers = msg.players;
      isHost = msg.hostId === myId;
      renderLobby();
      show("lobby");
      break;
    case "wheel":
      runWheel(msg.players, msg.winnerId);
      break;
    case "state":
      latest = msg;
      onState(msg);
      break;
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

document.getElementById("createBtn").onclick = () => {
  showHomeError("");
  connect({ type: "create", name: myName() });
};
document.getElementById("joinBtn").onclick = () => {
  const code = document.getElementById("codeInput").value.trim().toUpperCase();
  if (code.length < 4) { showHomeError("Enter a 4-letter code."); return; }
  showHomeError("");
  connect({ type: "join", name: myName(), code });
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
    if (p.isHost) {
      const h = document.createElement("span");
      h.className = "host";
      h.textContent = "HOST";
      li.appendChild(h);
    }
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

// ---- the wheel -------------------------------------------------------------
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

  // Land the winner's segment centre under the top pointer (-90deg).
  const targetMid = winnerIdx * seg + seg / 2;
  const finalRot = (Math.PI * 2 * 6) + (-Math.PI / 2 - targetMid);

  const dur = 4200;
  const start = performance.now();
  function frame(now) {
    const t = Math.min(1, (now - start) / dur);
    const ease = 1 - Math.pow(1 - t, 3); // easeOutCubic
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
    const a0 = rot + i * seg;
    const a1 = a0 + seg;
    wctx.beginPath();
    wctx.moveTo(cx, cy);
    wctx.arc(cx, cy, r, a0, a1);
    wctx.closePath();
    wctx.fillStyle = WHEEL_COLORS[i % WHEEL_COLORS.length];
    wctx.fill();
    wctx.strokeStyle = "rgba(0,0,0,.35)";
    wctx.lineWidth = 2;
    wctx.stroke();
    // label
    wctx.save();
    wctx.translate(cx, cy);
    wctx.rotate(a0 + seg / 2);
    wctx.fillStyle = "#fff";
    wctx.font = "bold 16px Segoe UI, sans-serif";
    wctx.textAlign = "right";
    wctx.textBaseline = "middle";
    wctx.fillText(p.name, r - 18, 0);
    wctx.restore();
  });
  // hub
  wctx.beginPath(); wctx.arc(cx, cy, 26, 0, Math.PI * 2);
  wctx.fillStyle = "#1d1712"; wctx.fill();
  wctx.strokeStyle = "#d4a017"; wctx.lineWidth = 3; wctx.stroke();
  // pointer
  wctx.beginPath();
  wctx.moveTo(cx - 16, 6); wctx.lineTo(cx + 16, 6); wctx.lineTo(cx, 40);
  wctx.closePath(); wctx.fillStyle = "#f3e9d8"; wctx.fill();
}

// ---- input -----------------------------------------------------------------
const keys = { up: false, down: false, left: false, right: false };
const KEYMAP = {
  ArrowUp: "up", KeyW: "up",
  ArrowDown: "down", KeyS: "down",
  ArrowLeft: "left", KeyA: "left",
  ArrowRight: "right", KeyD: "right",
};
function setKey(code, val) {
  const k = KEYMAP[code];
  if (!k) return;
  if (keys[k] !== val) { keys[k] = val; sendInput(); }
}
window.addEventListener("keydown", (e) => {
  if (KEYMAP[e.code]) { e.preventDefault(); setKey(e.code, true); }
});
window.addEventListener("keyup", (e) => {
  if (KEYMAP[e.code]) { e.preventDefault(); setKey(e.code, false); }
});
window.addEventListener("blur", () => {
  for (const k in keys) keys[k] = false;
  sendInput();
});
function sendInput() { send({ type: "input", ...keys }); }

// ---- game render -----------------------------------------------------------
const board = document.getElementById("board");
const ctx = board.getContext("2d");
function resize() { board.width = window.innerWidth; board.height = window.innerHeight; }
window.addEventListener("resize", resize);
resize();

const cam = { x: 0, y: 0 };

function onState(msg) {
  if (msg.phase === "lobby") { show("lobby"); return; }
  show("game");

  // HUD
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

  // countdown overlay
  const co = document.getElementById("countdownOverlay");
  if (msg.phase === "countdown") {
    co.classList.remove("hidden");
    co.textContent = msg.countdown > 0 ? msg.countdown : "GO!";
  } else {
    co.classList.add("hidden");
  }

  // gameover overlay
  const go = document.getElementById("gameoverOverlay");
  if (msg.phase === "gameover") {
    go.classList.remove("hidden");
    const t = document.getElementById("goText");
    if (msg.winner === "stalin") {
      t.textContent = `${msg.stalinName} caught everyone!`;
      t.className = "stalin";
    } else {
      t.textContent = "The runners survived!";
      t.className = "runners";
    }
    document.getElementById("goSub").textContent = "Returning to lobby…";
    const btn = document.getElementById("againBtn");
    btn.classList.toggle("hidden", !isHost);
  } else {
    go.classList.add("hidden");
  }
}

document.getElementById("againBtn").onclick = () => send({ type: "restart" });

function loop() {
  requestAnimationFrame(loop);
  if (!latest || (latest.phase !== "playing" && latest.phase !== "countdown" && latest.phase !== "gameover")) return;
  draw(latest);
}
requestAnimationFrame(loop);

function draw(s) {
  const W = board.width, H = board.height;
  ctx.clearRect(0, 0, W, H);

  // camera follows me (or world centre if spectating with no position)
  const me = s.players.find((p) => p.id === myId);
  const cx = me ? me.x : s.world.w / 2;
  const cy = me ? me.y : s.world.h / 2;
  cam.x = cx - W / 2;
  cam.y = cy - H / 2;
  cam.x = clamp(cam.x, 0, Math.max(0, s.world.w - W));
  cam.y = clamp(cam.y, 0, Math.max(0, s.world.h - H));
  if (s.world.w < W) cam.x = (s.world.w - W) / 2;
  if (s.world.h < H) cam.y = (s.world.h - H) / 2;

  ctx.save();
  ctx.translate(-cam.x, -cam.y);

  // ground grid
  ctx.fillStyle = "#15110c";
  ctx.fillRect(0, 0, s.world.w, s.world.h);
  ctx.strokeStyle = "#241c14";
  ctx.lineWidth = 1;
  for (let x = 0; x <= s.world.w; x += 80) line(x, 0, x, s.world.h);
  for (let y = 0; y <= s.world.h; y += 80) line(0, y, s.world.w, y);

  // walls
  if (s.walls) {
    for (const w of s.walls) {
      ctx.fillStyle = "#4a3a28";
      ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.strokeStyle = "#6e573e";
      ctx.lineWidth = 3;
      ctx.strokeRect(w.x, w.y, w.w, w.h);
    }
  }

  // players
  for (const p of s.players) {
    drawPlayer(p, p.id === myId);
  }

  ctx.restore();
}

function drawPlayer(p, isMe) {
  const r = 18;
  ctx.globalAlpha = p.caught ? 0.35 : 1;

  // body
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = p.stalin ? "#c0392b" : (p.caught ? "#555" : "#d4a017");
  ctx.fill();
  ctx.lineWidth = isMe ? 4 : 2;
  ctx.strokeStyle = isMe ? "#fff" : "rgba(0,0,0,.4)";
  ctx.stroke();

  // stalin gets a little hat/star
  if (p.stalin) {
    ctx.fillStyle = "#fff";
    ctx.font = "bold 18px Segoe UI";
    ctx.textAlign = "center";
    ctx.fillText("★", p.x, p.y + 6);
  }

  ctx.globalAlpha = 1;
  // name
  ctx.fillStyle = "#f3e9d8";
  ctx.font = "13px Segoe UI";
  ctx.textAlign = "center";
  ctx.fillText(p.name + (p.caught ? " 💀" : ""), p.x, p.y - r - 6);
}

// ---- helpers ---------------------------------------------------------------
function line(x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
