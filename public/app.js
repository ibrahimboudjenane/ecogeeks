const API = "/api";
const $ = (sel) => document.querySelector(sel);

const session = {
  get token() { try { return localStorage.getItem("ecg_token"); } catch { return null; } },
  set token(v) { try { v ? localStorage.setItem("ecg_token", v) : localStorage.removeItem("ecg_token"); } catch {} },
  get user() { try { return localStorage.getItem("ecg_user"); } catch { return null; } },
  set user(v) { try { v ? localStorage.setItem("ecg_user", v) : localStorage.removeItem("ecg_user"); } catch {} },
};
const adminToken = {
  get() { try { return sessionStorage.getItem("ecg_admin"); } catch { return null; } },
  set(v) { try { v ? sessionStorage.setItem("ecg_admin", v) : sessionStorage.removeItem("ecg_admin"); } catch {} },
};

async function api(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${API}/${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

function setMsg(el, text, ok = false) {
  el.textContent = text;
  el.className = "msg " + (text ? (ok ? "ok" : "err") : "");
}

// ---------- Tabs ----------
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === btn.dataset.tab));
    if (btn.dataset.tab === "admin" && adminToken.get()) loadAdmin();
    if (btn.dataset.tab === "leaderboard") loadLeaderboard();
  });
});

// ================= LEADERBOARD =================
async function loadLeaderboard() {
  const body = $("#leaderboard-body");
  try {
    const { rows } = await api("leaderboard");
    body.innerHTML = "";
    setMsg($("#leaderboard-msg"), "");
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="3" class="hint">No confirmed wins yet.</td></tr>';
      return;
    }
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      [r.place, r.name, r.points].forEach((v) => {
        const td = document.createElement("td");
        td.textContent = v;
        tr.append(td);
      });
      body.append(tr);
    });
  } catch (err) {
    setMsg($("#leaderboard-msg"), err.message);
  }
}
$("#refresh-leaderboard").addEventListener("click", loadLeaderboard);

// ================= VISITOR =================
function renderVisitor() {
  const loggedIn = !!session.token;
  $("#auth").hidden = loggedIn;
  $("#scanner-area").hidden = !loggedIn;
  $("#who").textContent = session.user || "";
}

$("#show-login").addEventListener("click", () => switchAuth("login"));
$("#show-register").addEventListener("click", () => switchAuth("register"));
function switchAuth(mode) {
  const login = mode === "login";
  $("#login-form").hidden = !login;
  $("#register-form").hidden = login;
  $("#show-login").classList.toggle("active", login);
  $("#show-register").classList.toggle("active", !login);
  setMsg($("#auth-msg"), "");
}

async function authSubmit(form, path, msgEl) {
  const fd = new FormData(form);
  try {
    const data = await api(path, {
      method: "POST",
      body: { username: fd.get("username"), password: fd.get("password") },
    });
    session.token = data.token;
    session.user = data.username;
    form.reset();
    renderVisitor();
  } catch (err) {
    setMsg(msgEl, err.message);
  }
}
$("#login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  authSubmit(e.target, "login", $("#auth-msg"));
});
$("#register-form").addEventListener("submit", (e) => {
  e.preventDefault();
  authSubmit(e.target, "register", $("#auth-msg"));
});

$("#logout").addEventListener("click", () => {
  stopCamera();
  session.token = null;
  session.user = null;
  renderVisitor();
});

// ================= FIRE SCENE =================
// Logic:
//   valid code   -> show scene, bucket pours water on the fire, tree grows
//   invalid code -> show scene, fire grows up
//   no submit    -> scene stays hidden (normal page)
const scene = $("#scene");
let sceneRun = 0; // each run gets an id; stale timers from an older run stop
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function resetScene() {
  sceneRun++;
  scene.classList.remove("pouring", "out", "steaming", "tree-on", "flare");
  void scene.offsetWidth; // restart CSS animations
}

async function sceneValid() {
  resetScene();
  const run = sceneRun;
  const alive = () => run === sceneRun;
  scene.hidden = false;           // fire is burning when the scene appears
  await wait(500);                // let it pop in before the water comes
  if (!alive()) return;
  scene.classList.add("pouring");
  await wait(1300);               // water reaches the fire
  if (!alive()) return;
  scene.classList.add("out", "steaming");
  await wait(900);                // bucket finishes tipping
  if (!alive()) return;
  scene.classList.remove("pouring");
  await wait(200);
  if (!alive()) return;
  scene.classList.add("tree-on");
  await wait(3500);
  if (alive()) scene.classList.remove("steaming");
}

function sceneInvalid() {
  resetScene();                   // also cancels any running win sequence
  scene.hidden = false;
  scene.classList.add("flare");   // fire rises from the ground
}

// ---- Submitting a code ----
async function submitCode(code) {
  setMsg($("#scan-msg"), "Checking code…", true);
  let ok = false;
  let text = "";
  try {
    const data = await api("scan", {
      method: "POST",
      body: { code },
      headers: { Authorization: `Bearer ${session.token}` },
    });
    ok = true;
    text = data.message;
  } catch (err) {
    text = err.message;
    if (/log in/i.test(err.message)) {
      session.token = null;
      session.user = null;
      renderVisitor();
    }
  }
  // Valid code: no effect yet, the win waits for admin confirmation.
  // Invalid code: the fire goes up.
  if (!ok) sceneInvalid();
  setMsg($("#scan-msg"), text, ok);
}

// ---- Check own wins: the tree grows only for wins the admin confirmed ----
// Each outcome is shown once per visitor: confirmed wins grow the tree,
// rejected wins send the fire back up.
const seenKey = (kind) => `ecg_seen_${kind}`;
function seenIds(kind) {
  try { return JSON.parse(localStorage.getItem(seenKey(kind)) || "[]"); } catch { return []; }
}
function saveSeenIds(kind, ids) {
  try { localStorage.setItem(seenKey(kind), JSON.stringify(ids)); } catch {}
}

function newWins(wins, status) {
  const seen = seenIds(status);
  const fresh = wins.filter((w) => w.status === status && !seen.includes(w.id));
  if (fresh.length) saveSeenIds(status, [...seen, ...fresh.map((w) => w.id)]);
  return fresh;
}

$("#check-win").addEventListener("click", async () => {
  setMsg($("#scan-msg"), "Checking your wins…", true);
  try {
    const { wins } = await api("my-wins", { headers: { Authorization: `Bearer ${session.token}` } });
    const freshConfirmed = newWins(wins, "confirmed");
    const freshRejected = newWins(wins, "rejected");
    if (freshConfirmed.length) {
      setMsg($("#scan-msg"), `Confirmed! ${freshConfirmed.length} new win${freshConfirmed.length > 1 ? "s" : ""}.`, true);
      sceneValid();
    } else if (freshRejected.length) {
      setMsg($("#scan-msg"), `Not accepted: ${freshRejected.length} win${freshRejected.length > 1 ? "s were" : " was"} rejected.`);
      sceneInvalid();
    } else {
      const pending = wins.filter((w) => w.status === "pending").length;
      // Nothing new since the last check: the scene goes away.
      scene.hidden = true;
      setMsg($("#scan-msg"), pending ? `Still waiting for confirmation (${pending} pending).` : "No new confirmed wins yet.", true);
    }
  } catch (err) {
    if (/log in/i.test(err.message)) {
      session.token = null;
      session.user = null;
      renderVisitor();
    }
    setMsg($("#scan-msg"), err.message);
  }
});

$("#manual-submit").addEventListener("click", () => {
  const code = $("#manual-code").value.trim();
  if (code) submitCode(code);
});

// ---- Camera scanning ----
let stream = null;
let rafId = null;
let scanning = false;

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setMsg($("#scan-msg"), "Camera is not available here. Use the paste option below.");
    return;
  }
  if (typeof jsQR === "undefined") {
    setMsg($("#scan-msg"), "Scanner is still loading. Please try again in a moment.");
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
  } catch {
    setMsg($("#scan-msg"), "Camera permission was denied. Use the paste option below.");
    return;
  }
  const video = $("#video");
  video.srcObject = stream;
  await video.play();
  $(".video-wrap").hidden = false;
  $("#start-scan").hidden = true;
  setMsg($("#scan-msg"), "");
  scanning = true;
  tick();
}

function stopCamera() {
  scanning = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  const video = $("#video");
  if (video) video.srcObject = null;
  $(".video-wrap").hidden = true;
  $("#start-scan").hidden = false;
}

function tick() {
  if (!scanning) return;
  const video = $("#video");
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const found = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
    if (found && found.data) {
      stopCamera();
      submitCode(found.data);
      return;
    }
  }
  rafId = requestAnimationFrame(tick);
}

$("#start-scan").addEventListener("click", startCamera);
$("#stop-scan").addEventListener("click", stopCamera);

renderVisitor();

// ================= ADMIN =================
$("#admin-login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const token = new FormData(e.target).get("token");
  setMsg($("#admin-login-msg"), "");
  try {
    await api("admin/challenges", { headers: { "X-Admin-Token": token } });
    adminToken.set(token);
    e.target.reset();
    loadAdmin();
  } catch (err) {
    setMsg($("#admin-login-msg"), err.message);
  }
});

$("#admin-logout").addEventListener("click", () => {
  adminToken.set(null);
  renderAdmin();
});

function renderAdmin() {
  const on = !!adminToken.get();
  $("#admin-login").hidden = on;
  $("#admin-area").hidden = !on;
}

function adminHeaders() {
  return { "X-Admin-Token": adminToken.get() };
}

async function loadAdmin() {
  renderAdmin();
  if (!adminToken.get()) return;
  await Promise.all([loadChallenges(), loadWins()]);
}

// ---- Challenges ----
$("#challenge-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  setMsg($("#challenge-msg"), "");
  try {
    await api("admin/challenges", {
      method: "POST",
      headers: adminHeaders(),
      body: { name: fd.get("name").trim(), points: Number(fd.get("points")) },
    });
    e.target.reset();
    setMsg($("#challenge-msg"), "Challenge added.", true);
    loadChallenges();
  } catch (err) {
    if (/token/i.test(err.message)) { adminToken.set(null); renderAdmin(); }
    setMsg($("#challenge-msg"), err.message);
  }
});

async function loadChallenges() {
  const list = $("#challenge-list");
  try {
    const { challenges } = await api("admin/challenges", { headers: adminHeaders() });
    list.innerHTML = "";
    if (!challenges.length) list.innerHTML = '<p class="hint">No challenges yet.</p>';
    challenges.forEach((c) => {
      const card = document.createElement("div");
      card.className = "qr-card";
      const img = document.createElement("img");
      img.alt = `QR code for ${c.name}`;
      img.width = 220;
      img.height = 220;
      const title = document.createElement("strong");
      title.textContent = c.name;
      const pts = document.createElement("small");
      pts.textContent = `${c.points} points`;
      const dl = document.createElement("button");
      dl.className = "btn small";
      dl.textContent = "Download QR";
      dl.addEventListener("click", () => {
        const a = document.createElement("a");
        a.download = `qr-${c.name.replace(/\W+/g, "-").toLowerCase()}.gif`;
        a.href = img.src;
        a.click();
      });
      card.append(img, title, pts, dl);
      list.append(card);
      const qr = qrcode(0, "M");
      qr.addData(c.payload);
      qr.make();
      img.src = qr.createDataURL(6, 4);
    });
  } catch (err) {
    list.innerHTML = "";
    setMsg($("#challenge-msg"), err.message);
  }
}

// ---- Wins ----
$("#win-filter").addEventListener("change", loadWins);

async function loadWins() {
  const status = $("#win-filter").value;
  const box = $("#win-list");
  try {
    const { wins } = await api(`admin/wins${status ? `?status=${status}` : ""}`, { headers: adminHeaders() });
    box.innerHTML = "";
    if (!wins.length) box.innerHTML = '<p class="hint">No wins here.</p>';
    wins.forEach((w) => box.append(winRow(w)));
  } catch (err) {
    box.innerHTML = "";
    setMsg($("#win-msg"), err.message);
  }
}

function winRow(w) {
  const row = document.createElement("div");
  row.className = "win";

  const info = document.createElement("div");
  const who = document.createElement("strong");
  who.textContent = w.username;
  const what = document.createElement("div");
  what.textContent = `${w.challenge} · ${w.points} pts`;
  const when = document.createElement("small");
  when.className = "hint";
  when.textContent = new Date(w.createdAt).toLocaleString();
  info.append(who, document.createElement("br"), what, when);

  const right = document.createElement("div");
  right.className = "win-actions";
  const badge = document.createElement("span");
  badge.className = `badge ${w.status}`;
  badge.textContent = w.status;
  right.append(badge);

  if (w.status === "pending") {
    right.append(
      actionBtn("Confirm", "confirmed", w.id),
      actionBtn("Reject", "rejected", w.id, true),
    );
  }
  row.append(info, right);
  return row;
}

function actionBtn(label, status, id, danger = false) {
  const b = document.createElement("button");
  b.className = "btn small" + (danger ? " secondary" : "");
  b.textContent = label;
  b.addEventListener("click", async () => {
    try {
      await api(`admin/wins/${id}`, { method: "POST", headers: adminHeaders(), body: { status } });
      loadWins();
    } catch (err) {
      setMsg($("#win-msg"), err.message);
    }
  });
  return b;
}

renderAdmin();
if (adminToken.get()) loadAdmin();

