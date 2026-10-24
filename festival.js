"use strict";

const ADMIN_ID = "ohzbell";
const ADMIN_PASSWORD_SHA256 = "467da2f448515085ff6bf87ff1971d917f7b797397326a2101f67130cfc69dca";
const SESSION_TTL = 8 * 60 * 60 * 1000;
const LOGIN_LOCK_MS = 30000;
const LOGIN_FAIL_LIMIT = 5;
const SESSION_KEY = "dure.admin.session.v1";
const LOGIN_LOCK_KEY = "dure.admin.lock.v1";
const CACHE_KEY = "pf.board.v1";

const PASTELS = ["#ffb7c5", "#ffe08a", "#9cf0c6", "#9fd4ff", "#d7c4ff", "#ffc7a8"];

const SEED = [
  {
    id: "good-news",
    name: "Good news",
    youtube: "https://www.youtube.com/watch?si=tUMabr6mKXRehDl5&v=JQbBSZ7Cl1M&feature=youtu.be",
    classes: ["Truth1", "Light3", "Truth3"]
  },
  {
    id: "power-a",
    name: "Power Shuffle - A",
    youtube: "https://www.youtube.com/watch?v=JNEAtmq6oTE&feature=shared",
    classes: ["Light 2", "savior4", "savior3"]
  },
  {
    id: "power-b",
    name: "Power Shuffle - B",
    youtube: "https://www.youtube.com/watch?v=JNEAtmq6oTE&feature=shared",
    classes: ["hope 1", "hope 2", "hope 3"]
  },
  {
    id: "believe",
    name: "I Believe in Jesus",
    youtube: "https://www.youtube.com/watch?v=eg6El6aHO5c&feature=shared",
    classes: ["love1", "love2", "savior1"]
  },
  {
    id: "armor-a",
    name: "Armor of God - A",
    youtube: "https://www.youtube.com/watch?v=3Ngbv7iUqMs&list=RD3Ngbv7iUqMs&start_radio=1",
    classes: ["Savior2", "truth2", "Hope3"]
  },
  {
    id: "armor-b",
    name: "Armor of God - B",
    youtube: "https://www.youtube.com/watch?v=3Ngbv7iUqMs&list=RD3Ngbv7iUqMs&start_radio=1",
    classes: ["Light1", "light4", "light5"]
  }
];

const state = {
  groups: SEED.map(cloneGroup),
  picked: [],
  winnerId: "",
  reveal: false,
  hotId: "",
  spinning: false,
  admin: false,
  adminOpen: false,
  saving: false,
  pendingPick: false,
  pendingReset: false,
  endpoint: "",
  key: "",
  player: null,
  playerFor: ""
};

let spinToken = 0;
let writeGen = 0;
let loginSum = 0;
let loginBusy = false;
let toastTimer = 0;
let polling = false;

function cloneGroup(group) {
  return {
    id: group.id,
    name: group.name,
    youtube: group.youtube,
    classes: group.classes.slice()
  };
}

function pageName() {
  return document.body.dataset.page || "home";
}

function groupId() {
  return new URLSearchParams(location.search).get("id") || "";
}

function currentGroup() {
  const id = groupId();
  return state.groups.find((group) => group.id === id) || null;
}

function pastel(index) {
  return PASTELS[index % PASTELS.length];
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  Object.keys(attrs || {}).forEach((key) => {
    const value = attrs[key];
    if (value == null || value === false) return;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, String(value));
  });
  (children || []).forEach((child) => {
    if (child) node.append(child);
  });
  return node;
}

function videoId(url) {
  const text = String(url || "").trim();
  if (!text) return "";
  try {
    const parsed = new URL(text);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return parsed.pathname.split("/").filter(Boolean)[0] || "";
    const watch = parsed.searchParams.get("v");
    if (watch) return watch;
    const match = parsed.pathname.match(/\/(?:embed|shorts)\/([^/?]+)/);
    if (match) return match[1];
  } catch (error) { /* plain text */ }
  const fallback = text.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{6,})/);
  return fallback ? fallback[1] : "";
}

function gridShape(count) {
  if (count <= 1) return [1, 1];
  if (count === 2) return [2, 1];
  if (count <= 4) return [2, 2];
  if (count <= 6) return [3, 2];
  if (count <= 8) return [4, 2];
  const cols = 4;
  return [cols, Math.ceil(count / cols)];
}

function viewKey() {
  const page = pageName();
  if (page === "play" || page === "group") {
    return JSON.stringify(currentGroup());
  }
  if (page === "draw") {
    return JSON.stringify({
      groups: state.groups.map((group) => [group.id, group.name]),
      picked: state.picked,
      winner: state.winnerId
    });
  }
  return JSON.stringify(state.groups.map((group) => [group.id, group.name]));
}

function render() {
  const page = pageName();
  if (page === "home") renderHome();
  else if (page === "group") renderGroup();
  else if (page === "play") renderPlay();
  else if (page === "draw") renderDraw();
  const key = document.getElementById("admin-open");
  if (key) key.classList.toggle("is-in", state.admin);
  if (pageName() === "draw" && !state.spinning) {
    setHint(state.reveal && state.winnerId ? "선택된 이름을 누르면 조 화면으로 갑니다" : "화면을 누르면 뽑습니다");
  }
}

function renderHome() {
  const stage = document.getElementById("stage");
  const shape = gridShape(state.groups.length);
  const grid = el("div", { class: "grid" });
  grid.style.gridTemplateColumns = "repeat(" + shape[0] + ", minmax(0, 1fr))";
  grid.style.gridTemplateRows = "repeat(" + shape[1] + ", minmax(0, 1fr))";
  state.groups.forEach((group, index) => {
    const card = el("a", {
      class: "card",
      href: "group.html?id=" + encodeURIComponent(group.id),
      style: "--c:" + pastel(index),
      text: group.name
    });
    grid.append(card);
  });
  stage.replaceChildren(
    el("header", { class: "mast" }, [
      el("h1", { text: "Globalry Kids 찬양 페스티벌" }),
      el("p", { text: "Praise Festival 2026 예선전" })
    ]),
    grid
  );
}

function renderGroup() {
  const stage = document.getElementById("stage");
  const group = currentGroup();
  if (!group) {
    stage.replaceChildren(el("p", { class: "missing" }, [
      el("a", { href: "go.html", text: "처음 화면으로" })
    ]));
    return;
  }
  document.title = group.name + " · Praise Festival 2026";
  const index = state.groups.findIndex((item) => item.id === group.id);
  const title = el("h1", { class: "group-title", text: group.name });
  title.style.setProperty("--c", pastel(Math.max(0, index)));
  const list = el("div", { class: "class-list" });
  const size = group.classes.length <= 3 ? "clamp(40px, 8vh, 96px)" : "clamp(26px, 5vh, 64px)";
  group.classes.forEach((name) => {
    const line = el("p", { class: "class-name", text: name });
    line.style.fontSize = size;
    list.append(line);
  });
  const play = videoId(group.youtube)
    ? el("a", {
      class: "play-link",
      href: "play.html?id=" + encodeURIComponent(group.id),
      target: "_parent",
      text: "영상 재생"
    })
    : el("p", { class: "class-name", text: "영상 주소가 없습니다" });
  stage.replaceChildren(title, list, play);
}

function renderPlay() {
  const stage = document.getElementById("stage");
  const group = currentGroup();
  if (!group || !videoId(group.youtube)) {
    stage.replaceChildren(el("p", { class: "missing" }, [
      el("a", { href: "go.html", text: "처음 화면으로" })
    ]));
    return;
  }
  if (state.playerFor === group.id && document.getElementById("player")) return;
  document.title = group.name + " · Praise Festival 2026";
  const index = Math.max(0, state.groups.findIndex((item) => item.id === group.id));
  const player = el("div", { class: "player" }, [
    el("div", { id: "player" }),
    el("button", { class: "play-fallback", id: "play-fallback", type: "button", text: "재생" })
  ]);
  const bar = el("div", { class: "class-bar" });
  group.classes.forEach((name, classIndex) => {
    const tab = el("button", {
      class: "class-tab",
      type: "button",
      "data-class-index": String(classIndex),
      style: "--c:" + pastel(index),
      text: name
    });
    bar.append(tab);
  });
  stage.replaceChildren(bar, player);
  state.playerFor = group.id;
  mountPlayer(videoId(group.youtube));
}

function renderDraw() {
  const stage = document.getElementById("stage");
  const shape = gridShape(state.groups.length);
  const grid = el("div", { class: "grid" });
  grid.style.gridTemplateColumns = "repeat(" + shape[0] + ", minmax(0, 1fr))";
  grid.style.gridTemplateRows = "repeat(" + shape[1] + ", minmax(0, 1fr))";
  grid.style.marginTop = "0";
  state.groups.forEach((group, index) => {
    const used = state.picked.includes(group.id);
    const winner = state.reveal && state.winnerId === group.id;
    const classes = ["card"];
    if (winner) classes.push("is-winner");
    else if (state.reveal) classes.push("is-dim");
    else if (used) classes.push("is-used");
    if (state.hotId === group.id) classes.push("is-hot");
    const attrs = {
      class: classes.join(" "),
      "data-group": group.id,
      style: "--c:" + pastel(index),
      text: group.name
    };
    const openGroup = winner || (used && !state.reveal);
    grid.append(openGroup
      ? el("a", Object.assign({ href: "group.html?id=" + encodeURIComponent(group.id) }, attrs))
      : el("button", Object.assign({ type: "button" }, attrs)));
  });
  stage.replaceChildren(grid);
}

function setHot(id) {
  state.hotId = id;
  document.querySelectorAll("[data-group]").forEach((node) => {
    node.classList.toggle("is-hot", node.getAttribute("data-group") === id);
  });
}

function setHint(text) {
  const hint = document.getElementById("draw-hint");
  if (hint) hint.textContent = text;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRace(pool, winnerId) {
  const ids = pool.map((group) => group.id);
  const seq = [];
  let cursor = 0;
  let elapsed = 0;
  const duration = 5000;
  while (elapsed < duration - 900) {
    const progress = elapsed / duration;
    const delay = Math.round(48 + Math.pow(progress, 2.5) * 460);
    seq.push({ id: ids[cursor % ids.length], delay: delay });
    elapsed += delay;
    cursor += 1;
  }
  let guard = 0;
  while (ids[cursor % ids.length] !== winnerId && guard < ids.length) {
    seq.push({ id: ids[cursor % ids.length], delay: 260 });
    cursor += 1;
    guard += 1;
  }
  seq.push({ id: winnerId, delay: 560 });
  return seq;
}

async function startDraw() {
  if (pageName() !== "draw" || state.spinning) return;
  const pool = state.groups.filter((group) => !state.picked.includes(group.id));
  if (!pool.length) {
    toast("뽑을 그룹이 없습니다. 초기화하면 다시 시작할 수 있습니다.");
    return;
  }
  state.spinning = true;
  state.reveal = false;
  state.winnerId = "";
  state.hotId = "";
  renderDraw();
  const token = ++spinToken;
  const winner = pool[Math.floor(Math.random() * pool.length)];
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const seq = reduce ? [{ id: winner.id, delay: 180 }] : buildRace(pool, winner.id);
  setHint("뽑는 중");
  for (let index = 0; index < seq.length; index += 1) {
    if (token !== spinToken) return;
    setHot(seq[index].id);
    await wait(seq[index].delay);
  }
  if (token !== spinToken) return;
  state.hotId = "";
  state.spinning = false;
  state.reveal = true;
  state.winnerId = winner.id;
  if (!state.picked.includes(winner.id)) state.picked.push(winner.id);
  state.pendingPick = true;
  saveCache();
  setHint("선택된 이름을 누르면 조 화면으로 갑니다");
  renderDraw();
  try {
    await sendPick();
  } catch (error) {
    toast("서버에 저장하지 못했습니다. 이 브라우저에는 남아 있습니다.");
  }
}

async function resetDraw() {
  if (!state.picked.length && !state.winnerId && !state.spinning) {
    toast("지울 뽑기 결과가 없습니다.");
    return;
  }
  if (!window.confirm("뽑기 결과를 지우고 처음부터 다시 할까요?")) return;
  spinToken += 1;
  state.spinning = false;
  state.reveal = false;
  state.hotId = "";
  state.winnerId = "";
  state.picked = [];
  state.pendingPick = false;
  state.pendingReset = true;
  saveCache();
  setHint("화면을 누르면 뽑습니다");
  renderDraw();
  try {
    await sendReset();
    toast("뽑기를 처음부터 다시 할 수 있습니다.");
  } catch (error) {
    toast("서버에서 지우지 못했습니다. 이 화면에서는 지워 두었습니다.");
  }
}

function mountPlayer(id) {
  const fallback = document.getElementById("play-fallback");
  const start = () => {
    if (state.player && typeof state.player.playVideo === "function") {
      state.player.playVideo();
    } else {
      const frame = el("iframe", {
        src: "https://www.youtube.com/embed/" + encodeURIComponent(id) + "?autoplay=1&rel=0&modestbranding=1&playsinline=1&fs=0",
        title: "영상",
        allow: "autoplay; encrypted-media; picture-in-picture",
        allowfullscreen: "false"
      });
      const host = document.getElementById("player");
      if (host) host.replaceWith(frame);
    }
    if (fallback) fallback.hidden = true;
  };
  if (fallback) fallback.addEventListener("click", start);
  window.onYouTubeIframeAPIReady = function () {
    if (!document.getElementById("player") || !window.YT || !window.YT.Player) return;
    state.player = new window.YT.Player("player", {
      videoId: id,
      playerVars: {
        autoplay: 1,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        fs: 0,
        controls: 1,
        iv_load_policy: 3
      },
      events: {
        onReady: (event) => {
          try { event.target.playVideo(); } catch (error) { /* gesture may be required */ }
        },
        onStateChange: (event) => {
          if (window.YT && event.data === window.YT.PlayerState.PLAYING && fallback) fallback.hidden = true;
        }
      }
    });
  };
  if (window.YT && window.YT.Player) window.onYouTubeIframeAPIReady();
  else if (!document.querySelector("script[data-yt-api]")) {
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.dataset.ytApi = "1";
    document.body.append(script);
  }
}

function toast(message) {
  let node = document.getElementById("toast");
  if (!node) {
    node = el("p", { id: "toast", class: "toast", role: "status" });
    document.body.append(node);
  }
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2800);
}

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      groups: state.groups,
      picked: state.picked,
      winnerId: state.winnerId
    }));
  } catch (error) { /* ignore */ }
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.groups) && data.groups.length) state.groups = data.groups.map(cloneGroup);
    if (Array.isArray(data.picked)) state.picked = data.picked.map(String);
  } catch (error) { /* ignore */ }
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function loadStore() {
  const response = await fetch("data/store.json", { cache: "no-store", signal: timeoutSignal(2500) });
  if (!response.ok) throw new Error("store");
  const store = await response.json();
  if (!store.endpoint || !store.key) throw new Error("store");
  state.endpoint = String(store.endpoint).replace(/[^/]+$/, "festival.php");
  state.key = store.key;
}

async function request(method, body) {
  if (!state.endpoint) await loadStore();
  const options = {
    method: method,
    cache: "no-store",
    signal: timeoutSignal(4000),
    headers: { "X-Board-Key": state.key }
  };
  if (body) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(state.endpoint, options);
  if (!response.ok) throw new Error("http");
  const doc = await response.json();
  if (!doc || doc.ok !== true || !Array.isArray(doc.groups) || !Array.isArray(doc.picked)) throw new Error("shape");
  return doc;
}

async function sendPick() {
  const gen = ++writeGen;
  const doc = await request("POST", { op: "pick", picked: state.picked });
  if (gen !== writeGen) return;
  state.pendingPick = false;
  state.picked = doc.picked;
  saveCache();
}

async function sendReset() {
  const gen = ++writeGen;
  const doc = await request("POST", { op: "reset" });
  if (gen !== writeGen) return;
  state.pendingReset = false;
  state.picked = doc.picked;
  if (!state.picked.includes(state.winnerId)) state.winnerId = "";
  saveCache();
  render();
}

async function refresh() {
  if (state.spinning || state.adminOpen || state.saving) return;
  if (state.pendingReset) {
    await sendReset();
    return;
  }
  if (state.pendingPick) {
    await sendPick();
  }
  const before = viewKey();
  const gen = writeGen;
  const doc = await request("GET");
  if (gen !== writeGen || state.spinning || state.adminOpen || state.pendingPick || state.pendingReset) return;
  state.groups = doc.groups.map(cloneGroup);
  state.picked = doc.picked.map(String);
  if (state.winnerId && !state.picked.includes(state.winnerId)) state.winnerId = "";
  saveCache();
  if (viewKey() !== before) render();
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(leftText, rightText) {
  const left = String(leftText);
  const right = String(rightText);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return diff === 0;
}

function readJson(key) {
  try { return JSON.parse(sessionStorage.getItem(key) || ""); } catch (error) { return null; }
}

async function readSession() {
  const data = readJson(SESSION_KEY);
  if (!data || data.id !== ADMIN_ID || typeof data.exp !== "number" || data.exp < Date.now() || typeof data.token !== "string") {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (error) { /* ignore */ }
    return false;
  }
  const expected = await sha256(data.id + "|" + data.exp + "|" + ADMIN_PASSWORD_SHA256);
  if (!safeEqual(expected, data.token)) {
    sessionStorage.removeItem(SESSION_KEY);
    return false;
  }
  return true;
}

async function issueSession() {
  const exp = Date.now() + SESSION_TTL;
  const token = await sha256(ADMIN_ID + "|" + exp + "|" + ADMIN_PASSWORD_SHA256);
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id: ADMIN_ID, exp: exp, token: token }));
}

function loginLockRemaining() {
  const data = readJson(LOGIN_LOCK_KEY);
  if (!data || !data.until) return 0;
  return Math.max(0, Number(data.until) - Date.now());
}

function registerLoginFailure() {
  const data = readJson(LOGIN_LOCK_KEY) || { count: 0, until: 0 };
  if (data.until && data.until > Date.now()) return;
  data.count = Number(data.count || 0) + 1;
  if (data.count >= LOGIN_FAIL_LIMIT) {
    data.count = 0;
    data.until = Date.now() + LOGIN_LOCK_MS;
  }
  sessionStorage.setItem(LOGIN_LOCK_KEY, JSON.stringify(data));
}

function ensureModal() {
  if (document.getElementById("admin-modal")) return;
  const login = el("form", { class: "login", id: "login-form" }, [
    el("h2", { text: "관리자" }),
    el("label", { for: "login-id", text: "아이디" }),
    el("input", { id: "login-id", name: "username", autocomplete: "username", maxlength: "80" }),
    el("label", { for: "login-password", text: "비밀번호" }),
    el("input", { id: "login-password", name: "password", type: "password", autocomplete: "current-password", maxlength: "200" }),
    el("label", { for: "login-captcha", id: "login-captcha-label", text: "덧셈" }),
    el("input", { id: "login-captcha", inputmode: "numeric", maxlength: "3" }),
    el("input", { class: "hp", id: "fax_number", name: "fax_number", tabindex: "-1", autocomplete: "off" }),
    el("div", { class: "actions" }, [
      el("button", { class: "primary", type: "submit", text: "들어가기" }),
      el("button", { type: "button", id: "login-close", text: "닫기" })
    ])
  ]);
  const editor = el("form", { class: "editor", id: "editor-form", hidden: "hidden" }, [
    el("h2", { text: "그룹 · 반 · 영상" }),
    el("div", { id: "admin-groups" }),
    el("div", { class: "actions" }, [
      el("button", { type: "button", id: "add-group", text: "그룹 추가" }),
      el("button", { class: "primary", type: "submit", text: "저장" }),
      el("button", { type: "button", id: "admin-logout", text: "로그아웃" }),
      el("button", { type: "button", id: "editor-close", text: "닫기" })
    ])
  ]);
  const modal = el("div", { class: "modal", id: "admin-modal", hidden: "hidden" }, [
    el("div", { class: "sheet" }, [login, editor])
  ]);
  document.body.append(modal);
  document.getElementById("login-form").addEventListener("submit", submitLogin);
  document.getElementById("login-close").addEventListener("click", closeAdmin);
  document.getElementById("editor-form").addEventListener("submit", saveEditor);
  document.getElementById("editor-close").addEventListener("click", closeAdmin);
  document.getElementById("admin-logout").addEventListener("click", logout);
  document.getElementById("add-group").addEventListener("click", () => {
    document.getElementById("admin-groups").append(groupEditor({
      id: "g" + Date.now().toString(36),
      name: "",
      youtube: "",
      classes: [""]
    }, document.querySelectorAll("#admin-groups fieldset").length + 1));
  });
  document.getElementById("admin-groups").addEventListener("click", onEditorClick);
}

function fillCaptcha() {
  const left = 2 + Math.floor(Math.random() * 8);
  const right = 2 + Math.floor(Math.random() * 8);
  loginSum = left + right;
  document.getElementById("login-captcha-label").textContent = left + " + " + right;
}

function showEditor(show) {
  document.getElementById("login-form").hidden = show;
  document.getElementById("editor-form").hidden = !show;
}

async function openAdmin() {
  ensureModal();
  state.adminOpen = true;
  document.getElementById("admin-modal").hidden = false;
  try {
    state.admin = await readSession();
  } catch (error) {
    state.admin = false;
  }
  if (!state.admin) {
    showEditor(false);
    document.getElementById("login-form").reset();
    fillCaptcha();
    document.getElementById("login-id").focus();
    return;
  }
  showEditor(true);
  paintEditor();
}

function closeAdmin() {
  const modal = document.getElementById("admin-modal");
  if (modal) modal.hidden = true;
  state.adminOpen = false;
  render();
}

async function submitLogin(event) {
  event.preventDefault();
  if (loginBusy) return;
  const lockLeft = loginLockRemaining();
  if (lockLeft > 0) {
    toast("로그인이 잠시 잠겼습니다. " + Math.ceil(lockLeft / 1000) + "초 후에 다시 시도해 주세요.");
    return;
  }
  const fax = document.getElementById("fax_number");
  if (fax && fax.value.trim()) {
    toast("들어가지 못했습니다.");
    return;
  }
  const id = document.getElementById("login-id").value.trim();
  const password = document.getElementById("login-password").value;
  const captcha = document.getElementById("login-captcha").value.trim();
  loginBusy = true;
  try {
    const hash = await sha256(password);
    const captchaOk = captcha !== "" && Number(captcha) === loginSum;
    if (!(id === ADMIN_ID && safeEqual(hash, ADMIN_PASSWORD_SHA256) && captchaOk)) {
      registerLoginFailure();
      document.getElementById("login-password").value = "";
      fillCaptcha();
      document.getElementById("login-captcha").value = "";
      toast("아이디, 비밀번호 또는 덧셈 결과를 다시 확인해 주세요.");
      return;
    }
    try { sessionStorage.removeItem(LOGIN_LOCK_KEY); } catch (error) { /* ignore */ }
    await issueSession();
    state.admin = true;
    document.getElementById("login-password").value = "";
    showEditor(true);
    paintEditor();
    render();
  } catch (error) {
    toast("이 페이지는 https 또는 localhost에서 열어 주세요.");
  } finally {
    loginBusy = false;
  }
}

function logout() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch (error) { /* ignore */ }
  state.admin = false;
  closeAdmin();
}

function groupEditor(group, number) {
  const classes = el("div", { class: "classes" });
  (group.classes.length ? group.classes : [""]).forEach((name) => classes.append(classRow(name)));
  return el("fieldset", { class: "group-edit", "data-id": group.id }, [
    el("legend", { text: "그룹 " + number }),
    el("span", { class: "row-label", text: "그룹명" }),
    el("input", { name: "name", maxlength: "80", value: group.name }),
    el("span", { class: "row-label", text: "유튜브 주소" }),
    el("input", { name: "youtube", maxlength: "500", value: group.youtube }),
    el("span", { class: "row-label", text: "반 이름" }),
    classes,
    el("div", { class: "group-tools" }, [
      el("button", { type: "button", "data-act": "add-class", text: "반 추가" }),
      el("button", { type: "button", "data-act": "up", text: "위로" }),
      el("button", { type: "button", "data-act": "down", text: "아래로" }),
      el("button", { type: "button", "data-act": "del-group", text: "그룹 삭제" })
    ])
  ]);
}

function classRow(name) {
  return el("div", { class: "class-row" }, [
    el("input", { name: "class", maxlength: "40", value: name }),
    el("button", { type: "button", "data-act": "up-class", text: "위" }),
    el("button", { type: "button", "data-act": "down-class", text: "아래" }),
    el("button", { type: "button", "data-act": "del-class", text: "삭제" })
  ]);
}

function paintEditor() {
  const root = document.getElementById("admin-groups");
  root.replaceChildren();
  state.groups.forEach((group, index) => root.append(groupEditor(group, index + 1)));
}

function moveNode(node, direction) {
  const sibling = direction < 0 ? node.previousElementSibling : node.nextElementSibling;
  if (!sibling) return;
  if (direction < 0) node.parentNode.insertBefore(node, sibling);
  else node.parentNode.insertBefore(sibling, node);
}

function onEditorClick(event) {
  const button = event.target.closest("[data-act]");
  if (!button) return;
  const act = button.getAttribute("data-act");
  if (act === "add-class") {
    button.closest("fieldset").querySelector(".classes").append(classRow(""));
    return;
  }
  if (act === "del-class") {
    const row = button.closest(".class-row");
    const list = row.parentNode;
    if (list.children.length === 1) row.querySelector("input").value = "";
    else row.remove();
    return;
  }
  if (act === "up-class" || act === "down-class") {
    moveNode(button.closest(".class-row"), act === "up-class" ? -1 : 1);
    return;
  }
  const field = button.closest("fieldset");
  if (act === "up" || act === "down") moveNode(field, act === "up" ? -1 : 1);
  if (act === "del-group") {
    if (window.confirm("이 그룹을 목록에서 뺄까요? 저장해야 반영됩니다.")) field.remove();
  }
}

function readEditor() {
  return Array.from(document.querySelectorAll("#admin-groups fieldset")).map((field) => ({
    id: field.getAttribute("data-id"),
    name: field.querySelector("[name=name]").value.trim(),
    youtube: field.querySelector("[name=youtube]").value.trim(),
    classes: Array.from(field.querySelectorAll("[name=class]")).map((input) => input.value.trim()).filter(Boolean)
  }));
}

async function saveEditor(event) {
  event.preventDefault();
  if (state.saving) return;
  const groups = readEditor();
  if (!groups.length || groups.some((group) => !group.name)) {
    toast("그룹명을 입력해 주세요.");
    return;
  }
  if (groups.some((group) => group.youtube && !videoId(group.youtube))) {
    toast("유튜브 주소에서 영상 번호를 찾지 못했습니다.");
    return;
  }
  state.saving = true;
  try {
    const gen = ++writeGen;
    const doc = await request("POST", { op: "groups", groups: groups });
    if (gen === writeGen) {
      state.groups = doc.groups.map(cloneGroup);
      state.picked = doc.picked.map(String);
      if (state.winnerId && !state.picked.includes(state.winnerId)) state.winnerId = "";
      saveCache();
    }
    toast("저장했습니다.");
    closeAdmin();
  } catch (error) {
    toast("서버에 저장하지 못했습니다.");
  } finally {
    state.saving = false;
  }
}

function onStageClick(event) {
  const tab = event.target.closest("[data-class-index]");
  if (tab) {
    tab.parentNode.querySelectorAll(".class-tab").forEach((node) => node.classList.toggle("is-on", node === tab));
    return;
  }
  if (pageName() !== "draw" || state.spinning) return;
  if (event.target.closest("a")) return;
  startDraw();
}

function bind() {
  document.getElementById("stage").addEventListener("click", onStageClick);
  document.getElementById("admin-open").addEventListener("click", openAdmin);
  const reset = document.getElementById("reset-draw");
  if (reset) reset.addEventListener("click", resetDraw);
  const back = document.getElementById("go-back");
  if (back) back.addEventListener("click", () => {
    if (history.length > 1) history.back();
    else location.href = "go.html";
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.adminOpen) closeAdmin();
  });
}

async function boot() {
  loadCache();
  render();
  bind();
  try { state.admin = await readSession(); } catch (error) { state.admin = false; }
  render();
  const tick = async () => {
    if (polling || document.hidden) return;
    polling = true;
    try { await refresh(); } catch (error) { /* keep the screen that is already up */ }
    polling = false;
  };
  tick();
  setInterval(tick, 5000);
}

boot();
