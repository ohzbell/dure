"use strict";

const ADMIN_ID = "ohzbell";
const ADMIN_PASSWORD_SHA256 = "467da2f448515085ff6bf87ff1971d917f7b797397326a2101f67130cfc69dca";
const SESSION_TTL = 8 * 60 * 60 * 1000;
const LOGIN_LOCK_MS = 30000;
const LOGIN_FAIL_LIMIT = 5;
const SESSION_KEY = "dure.admin.session.v1";
const LOGIN_LOCK_KEY = "dure.admin.lock.v1";

const PAGES = [
  { id: "random", title: "찬양 랜덤플레이" },
  { id: "grade", title: "학년별 찬양" },
  { id: "teacher", title: "선생님 축하공연" },
  { id: "guess", title: "찬양 맞추기" },
  { id: "lyrics", title: "가사 맞추기" },
  { id: "popular", title: "찬양 페스티벌 인기상" },
  { id: "final", title: "찬양 페스티벌 결승" }
];

const PAGE_LISTS = ["random", "teacher", "guess", "lyrics", "popular", "final"];

const state = {
  desk: new URLSearchParams(location.search).get("desk") === "1",
  page: 0,
  clip: 0,
  revealed: false,
  lyricsShown: false,
  videoVisible: true,
  listOpen: false,
  counting: false,
  randomPhase: "start",
  loadedId: "",
  needRestart: true,
  dragging: false,
  saving: false,
  admin: false,
  deskTab: "videos",
  doc: emptyDoc(),
  endpoint: "",
  key: ""
};

let player = null;
let standby = null;
let standbyClipId = "";
let standbyReady = false;
let standbyGen = 0;
let playerPromise = null;
let playerReady = Promise.resolve();
let playGen = 0;
let armEnd = false;
let docKey = "";
let ackedKey = "";
let saveVersion = 0;
let saveChain = Promise.resolve();
let toastTimer = 0;
let loginBusy = false;
let shownKey = "";
let markTimers = [];
let seeking = false;
let seekTimer = 0;

function emptyDoc() {
  return {
    videos: [],
    cueOff: false,
    cueRev: 0,
    cueName: "",
    cueCustom: false,
    pages: {
      random: [],
      teacher: [],
      guess: [],
      lyrics: [],
      popular: [],
      final: []
    },
    grades: [],
    tabOrder: [],
    playSeconds: null
  };
}

function uid() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

function youtubeId(url) {
  const text = String(url || "").trim();
  if (!text) return "";
  try {
    const parsed = new URL(text);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return parsed.pathname.split("/").filter(Boolean)[0] || "";
    if (host !== "youtube.com" && host !== "m.youtube.com" && host !== "music.youtube.com") return "";
    const watch = parsed.searchParams.get("v");
    if (watch) return watch;
    const match = parsed.pathname.match(/\/(?:embed|shorts)\/([^/?]+)/);
    if (match) return match[1];
  } catch (error) { /* plain text */ }
  return "";
}

function parseTime(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return clampSec(Number(raw));
  const parts = raw.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.some((part) => !/^\d{1,2}$/.test(part) && !/^\d+$/.test(part))) return null;
  if (parts.some((part) => !/^\d+$/.test(part))) return null;
  const nums = parts.map(Number);
  if (parts.length === 2 && nums[1] > 59) return null;
  if (parts.length === 3 && (nums[1] > 59 || nums[2] > 59)) return null;
  const seconds = parts.length === 2 ? nums[0] * 60 + nums[1] : nums[0] * 3600 + nums[1] * 60 + nums[2];
  return clampSec(seconds);
}

function clampSec(number) {
  if (!Number.isFinite(number) || number < 0 || number > 86400) return null;
  return Math.round(number);
}

function formatTime(value) {
  if (value == null || value === "") return "";
  const total = Number(value);
  if (!Number.isFinite(total)) return "";
  const seconds = Math.max(0, Math.round(total));
  const hour = Math.floor(seconds / 3600);
  const minute = Math.floor((seconds % 3600) / 60);
  const second = seconds % 60;
  if (hour) return hour + ":" + String(minute).padStart(2, "0") + ":" + String(second).padStart(2, "0");
  return minute + ":" + String(second).padStart(2, "0");
}

function pageOrder() {
  const saved = Array.isArray(state.doc.tabOrder) ? state.doc.tabOrder : [];
  const pages = [];
  saved.forEach((id) => {
    const page = PAGES.find((item) => item.id === id);
    if (page && !pages.includes(page)) pages.push(page);
  });
  PAGES.forEach((page) => {
    if (!pages.includes(page)) pages.push(page);
  });
  return pages;
}

function pageId() {
  return pageOrder()[state.page].id;
}

function findVideo(id) {
  return state.doc.videos.find((video) => video.id === id) || null;
}

function clipsForPage() {
  const id = pageId();
  if (id === "grade") {
    const rows = [];
    state.doc.grades.forEach((grade) => {
      const clip = grade.items[0];
      const video = clip && findVideo(clip.video);
      if (video) rows.push(viewClip(clip, video, grade));
    });
    return rows;
  }
  return (state.doc.pages[id] || []).map((clip) => {
    const video = findVideo(clip.video);
    return video ? viewClip(clip, video, null) : null;
  }).filter(Boolean);
}

function viewClip(clip, video, grade) {
  return {
    clipId: clip.id,
    title: video.title,
    url: video.url,
    start: clip.start == null ? null : Number(clip.start),
    end: clip.end == null ? null : Number(clip.end),
    lyrics: clip.lyrics || "",
    gradeName: grade ? grade.name : "",
    gradeId: grade ? grade.id : ""
  };
}

function currentClip() {
  return clipsForPage()[state.clip] || null;
}

function rangeLabel(clip) {
  if (clip.start == null && clip.end == null) return "";
  return formatTime(clip.start || 0) + " – " + (clip.end == null ? "끝" : formatTime(clip.end));
}

function toast(message) {
  let node = document.getElementById("toast");
  if (!node) {
    node = el("p", { id: "toast", class: "toast" });
    document.body.append(node);
  }
  node.hidden = false;
  node.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2600);
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
  state.endpoint = String(store.endpoint).replace(/[^/]+$/, "live.php");
  state.key = store.key;
}

async function request(method, body) {
  if (!state.endpoint) await loadStore();
  const options = {
    method: method,
    cache: "no-store",
    signal: timeoutSignal(body && body.op === "cue" ? 20000 : 8000),
    headers: { "X-Board-Key": state.key }
  };
  if (body) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(state.endpoint, options);
  if (!response.ok) throw new Error("http");
  const doc = await response.json();
  if (!doc || doc.ok !== true || !Array.isArray(doc.videos) || !doc.pages) throw new Error("shape");
  return doc;
}

function docKeyFrom(doc) {
  return JSON.stringify([
    (doc.videos || []).map((video) => ({ id: video.id, title: video.title, url: video.url })),
    doc.pages,
    doc.grades,
    !!doc.cueOff,
    doc.tabOrder || [],
    doc.playSeconds || null
  ]);
}

function snapshotDoc() {
  return {
    op: "doc",
    videos: state.doc.videos.map((video) => ({ id: video.id, title: video.title, url: video.url })),
    cueOff: !!state.doc.cueOff,
    pages: JSON.parse(JSON.stringify(state.doc.pages)),
    grades: JSON.parse(JSON.stringify(state.doc.grades)),
    tabOrder: (state.doc.tabOrder || []).slice(),
    playSeconds: state.doc.playSeconds || null
  };
}

function localDirty() {
  if (!ackedKey) return false;
  return docKeyFrom(snapshotDoc()) !== ackedKey;
}

function applyDoc(doc, force) {
  if (!force && localDirty()) return;
  const key = JSON.stringify([doc.videos, doc.pages, doc.grades, doc.cueOff, doc.cueRev, doc.cueName, doc.cueCustom, doc.tabOrder, doc.playSeconds]);
  const changed = key !== docKey;
  docKey = key;
  if (!changed) {
    ackedKey = docKeyFrom(state.doc);
    return;
  }
  const keepId = pageOrder()[state.page] ? pageOrder()[state.page].id : "";
  const previous = currentClip();
  state.doc = doc;
  ackedKey = docKeyFrom(state.doc);
  const kept = pageOrder().findIndex((page) => page.id === keepId);
  if (kept >= 0) state.page = kept;
  const clips = clipsForPage();
  if (previous) {
    const index = clips.findIndex((clip) => clip.clipId === previous.clipId);
    if (index >= 0) state.clip = index;
    else {
      state.clip = 0;
      state.revealed = false;
      state.lyricsShown = false;
      stopVideo();
    }
  } else if (state.clip >= clips.length) {
    state.clip = 0;
  }
  if (state.desk) {
    if (!state.dragging && !deskBusy()) renderDesk();
  } else {
    paint();
  }
}

function queueSave() {
  const version = ++saveVersion;
  const payload = snapshotDoc();
  saveChain = saveChain.then(() => sendDoc(payload, version), () => sendDoc(payload, version));
  return saveChain;
}

async function sendDoc(payload, version) {
  state.saving = true;
  try {
    const doc = await request("POST", payload);
    state.saving = false;
    if (version !== saveVersion) return true;
    applyDoc(doc, true);
    if (flushVideoEdits()) queueSave();
    return true;
  } catch (error) {
    state.saving = false;
    if (version === saveVersion) toast("저장하지 못했습니다.");
    return false;
  }
}

function flushVideoEdits() {
  let changed = false;
  document.querySelectorAll(".video-row").forEach((row) => {
    const current = state.doc.videos.find((item) => item.id === row.getAttribute("data-id"));
    const inputs = row.querySelectorAll("input");
    if (!current || inputs.length < 2) return;
    const nextTitle = inputs[0].value.trim();
    const nextUrl = inputs[1].value.trim();
    if (!nextTitle || !youtubeId(nextUrl)) return;
    if (current.title === nextTitle && current.url === nextUrl) return;
    current.title = nextTitle;
    current.url = nextUrl;
    changed = true;
  });
  return changed;
}

function saveOnLeave() {
  if (!state.admin || !state.endpoint || !state.key) return;
  flushVideoEdits();
  if (!localDirty()) return;
  const body = JSON.stringify(snapshotDoc());
  if (body.length > 60000) return;
  try {
    fetch(state.endpoint, {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        "X-Board-Key": state.key
      },
      body: body
    });
  } catch (error) { /* the page is already leaving */ }
}

function cueSrc() {
  if (state.doc.cueCustom && state.endpoint && state.key) {
    return state.endpoint + "?cue=1&k=" + encodeURIComponent(state.key) + "&v=" + encodeURIComponent(state.doc.cueRev || 0);
  }
  return "live-beep.wav?v=5";
}

function loadYouTube() {
  playerReady = new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => resolve();
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.append(script);
  });
}

function playerOptions(onReady) {
  return {
    width: "100%",
    height: "100%",
    playerVars: {
      autoplay: 0,
      controls: 0,
      rel: 0,
      modestbranding: 1,
      playsinline: 1,
      fs: 0,
      disablekb: 1,
      iv_load_policy: 3,
      origin: location.origin
    },
    events: {
      onReady: onReady,
      onStateChange: onPlayerState,
      onError: (event) => {
        if (event && event.target === player) toast("영상을 재생하지 못했습니다.");
      }
    }
  };
}

function slotFrame(item) {
  try { return item && item.getIframe ? item.getIframe() : null; } catch (error) { return null; }
}

function markSlots() {
  const live = slotFrame(player);
  const idle = slotFrame(standby);
  if (live) {
    live.classList.add("is-live");
    live.classList.remove("is-idle");
  }
  if (idle) {
    idle.classList.add("is-idle");
    idle.classList.remove("is-live");
  }
}

function hush(item) {
  try { if (item) item.mute(); } catch (error) { /* not ready */ }
}

function speak(item) {
  try {
    if (!item) return;
    item.unMute();
    item.setVolume(100);
  } catch (error) { /* not ready */ }
}

function ensurePlayer() {
  if (!playerPromise) {
    playerPromise = playerReady.then(() => Promise.all([
      new Promise((resolve) => { new YT.Player("yt", playerOptions((event) => resolve(event.target))); }),
      new Promise((resolve) => { new YT.Player("yt-next", playerOptions((event) => resolve(event.target))); })
    ])).then((pair) => {
      player = pair[0];
      standby = pair[1];
      hush(standby);
      markSlots();
      return player;
    });
  }
  return playerPromise;
}

function onPlayerState(event) {
  if (!event) return;
  if (standby && event.target === standby) {
    if (!standbyClipId) return;
    if (event.data === 1) {
      try { standby.pauseVideo(); } catch (error) { /* keep the cue quiet */ }
      hush(standby);
      standbyReady = true;
      return;
    }
    if (event.data === 5) standbyReady = true;
    return;
  }
  if (!player || event.target !== player) return;
  if (event.data === 1) {
    armEnd = true;
    primeNext();
  }
  if (event.data !== 0 || !armEnd) return;
  armEnd = false;
  if (state.counting || state.desk) return;
  const clips = clipsForPage();
  const current = clips[state.clip];
  if (!current || current.clipId !== state.loadedId) return;
  state.loadedId = "";
  state.needRestart = true;
  if (pageId() === "random") {
    if (state.randomPhase !== "play") return;
    if (state.clip >= clips.length - 1) {
      finishRandom();
      return;
    }
    state.clip += 1;
    countdownThenPlay(playGen);
    return;
  }
  if (state.clip < clips.length - 1) {
    state.clip += 1;
    state.revealed = false;
    state.lyricsShown = false;
    state.videoVisible = true;
  }
  const kept = currentClip();
  stopVideo(kept && kept.clipId);
  paint();
}

function startRandom() {
  if (!clipsForPage().length) {
    toast("이 화면에 넣은 영상이 없습니다.");
    return;
  }
  stopCue();
  stopVideo();
  state.randomPhase = "play";
  state.clip = 0;
  state.revealed = false;
  state.lyricsShown = false;
  state.needRestart = true;
  countdownThenPlay(playGen);
}

function finishRandom() {
  stopCue();
  stopVideo();
  state.randomPhase = "finish";
  paint();
}

function clipArgs(clip) {
  const id = youtubeId(clip.url);
  if (!id) return null;
  const args = { videoId: id, startSeconds: clip.start || 0 };
  if (clip.end) args.endSeconds = clip.end;
  return args;
}

function primeNext() {
  if (!standby || state.desk) return;
  const clip = clipsForPage()[state.clip + 1];
  if (!clip) {
    standbyClipId = "";
    standbyReady = false;
    standbyGen = 0;
    return;
  }
  if (standbyClipId === clip.clipId) return;
  const args = clipArgs(clip);
  if (!args) return;
  standbyGen += 1;
  standbyClipId = clip.clipId;
  standbyReady = false;
  hush(standby);
  try { standby.cueVideoById(args); } catch (error) {
    standbyClipId = "";
    standbyGen = 0;
  }
}

function takePreload(clip) {
  if (!standby || standbyClipId !== clip.clipId || !standbyReady) return false;
  const previous = player;
  player = standby;
  standby = previous;
  standbyClipId = "";
  standbyReady = false;
  standbyGen = 0;
  markSlots();
  armEnd = false;
  state.loadedId = clip.clipId;
  state.needRestart = false;
  speak(player);
  try { player.playVideo(); } catch (error) { /* the cue will load it */ }
  hush(standby);
  try { standby.stopVideo(); } catch (error) { /* already quiet */ }
  primeNext();
  return true;
}

function loadClip(clip, autoplay) {
  const args = clipArgs(clip);
  if (!args || !player) return;
  armEnd = false;
  state.loadedId = clip.clipId;
  state.needRestart = false;
  speak(player);
  if (autoplay) player.loadVideoById(args);
  else player.cueVideoById(args);
  primeNext();
}

function playCurrent() {
  const clip = currentClip();
  if (!clip) {
    toast("이 화면에 넣은 영상이 없습니다.");
    return;
  }
  if (pageId() === "guess" && !state.revealed) return;
  if (state.lyricsShown) {
    state.lyricsShown = false;
    paint();
  }
  syncVeil();
  ensurePlayer().then(() => {
    const same = state.loadedId === clip.clipId && !state.needRestart;
    let paused = false;
    try { paused = player.getPlayerState() === 2; } catch (error) { paused = false; }
    if (same && paused) {
      player.playVideo();
      syncVeil();
      return;
    }
    if (!takePreload(clip)) loadClip(clip, true);
    syncVeil();
  }).catch(() => toast("영상 재생기를 준비하지 못했습니다."));
}

function stopVideo(keepClipId) {
  armEnd = false;
  state.loadedId = "";
  state.needRestart = true;
  try { if (player && player.stopVideo) player.stopVideo(); } catch (error) { /* not ready */ }
  if (!keepClipId || keepClipId !== standbyClipId) {
    standbyClipId = "";
    standbyReady = false;
    standbyGen = 0;
    hush(standby);
    try { if (standby && standby.stopVideo) standby.stopVideo(); } catch (error) { /* not ready */ }
  }
  syncVeil();
}

function stopCue() {
  playGen += 1;
  state.counting = false;
  clearMarks();
  const audio = document.getElementById("cue");
  audio.onended = null;
  audio.pause();
  try { audio.currentTime = 0; } catch (error) { /* ignore */ }
  const count = document.getElementById("count");
  count.hidden = true;
  count.textContent = "";
}

function clearMarks() {
  markTimers.forEach((id) => clearTimeout(id));
  markTimers = [];
}

function showMarks() {
  clearMarks();
  if (state.doc.cueCustom) return;
  const count = document.getElementById("count");
  [[0, "3"], [1000, "2"], [2000, "1"], [3000, ""]].forEach(([at, text]) => {
    markTimers.push(setTimeout(() => {
      if (state.counting === false) return;
      if (!text) {
        count.hidden = true;
        count.textContent = "";
        return;
      }
      count.hidden = false;
      count.textContent = text;
    }, at));
  });
}

function countdownThenPlay(gen) {
  const finish = () => {
    if (gen !== playGen || pageId() !== "random") return;
    state.counting = false;
    clearMarks();
    const count = document.getElementById("count");
    count.hidden = true;
    count.textContent = "";
    paint();
    playCurrent();
  };
  if (state.doc.cueOff) {
    state.counting = true;
    paint();
    setTimeout(finish, 350);
    return;
  }
  const audio = document.getElementById("cue");
  audio.src = cueSrc();
  audio.currentTime = 0;
  state.counting = true;
  paint();
  showMarks();
  audio.onended = finish;
  audio.play().catch(finish);
}

function nextTrack() {
  const clips = clipsForPage();
  if (!clips.length) {
    toast("이 화면에 넣은 영상이 없습니다.");
    return;
  }
  const random = pageId() === "random";
  if (random && state.randomPhase !== "play") {
    stopVideo();
    stopCue();
    return;
  }
  if (random && state.clip >= clips.length - 1) {
    finishRandom();
    return;
  }
  const nextIndex = random ? state.clip + 1 : (state.clip + 1) % clips.length;
  const next = clips[nextIndex];
  stopVideo(next && next.clipId);
  stopCue();
  const gen = playGen;
  state.revealed = false;
  state.lyricsShown = false;
  if (!random) state.videoVisible = true;
  state.needRestart = true;
  state.clip = nextIndex;
  paint();
  if (random) countdownThenPlay(gen);
}

function jumpTo(index) {
  const target = clipsForPage()[index];
  stopCue();
  stopVideo(target && target.clipId);
  state.clip = index;
  state.revealed = false;
  state.lyricsShown = false;
  if (pageId() !== "random") state.videoVisible = true;
  state.needRestart = true;
  if (pageId() === "random") {
    state.randomPhase = "play";
    paint();
    playCurrent();
    return;
  }
  paint();
}

function goNextPage() {
  if (state.page >= pageOrder().length - 1) setPage(0);
  else setPage(state.page + 1);
}

function returnIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  ["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 1 1 0 11H12"].forEach((d) => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  });
  return svg;
}

let navMode = "";

function paintNav() {
  const back = state.page >= pageOrder().length - 1;
  const mode = back ? "back" : "next";
  if (mode === navMode) return;
  navMode = mode;
  const next = document.getElementById("page-next");
  next.setAttribute("aria-label", back ? "첫 화면" : "다음 페이지");
  next.replaceChildren(back ? returnIcon() : document.createTextNode("›"));
}

function setPage(index) {
  stopCue();
  stopVideo();
  const pages = pageOrder();
  state.page = (index + pages.length) % pages.length;
  state.clip = 0;
  state.revealed = false;
  state.lyricsShown = false;
  state.videoVisible = true;
  if (pages[state.page].id === "random") state.randomPhase = "start";
  history.replaceState(null, "", "#" + pages[state.page].id);
  paint();
}

function syncVeil() {
  const clip = currentClip();
  let open = false;
  if (clip && !state.counting && !state.desk) {
    if (pageId() === "guess") open = state.revealed && state.loadedId === clip.clipId;
    else if (pageId() === "lyrics" || pageId() === "random") open = state.videoVisible && state.loadedId === clip.clipId;
    else open = state.loadedId === clip.clipId;
  }
  document.body.classList.toggle("is-open", open);
}

function subtitle() {
  const clip = currentClip();
  if (!clip || state.counting) return "";
  if (pageId() === "random") return "";
  const id = pageId();
  if (id === "guess" || id === "lyrics") return "";
  if (clip.gradeName) return clip.gradeName + " · " + clip.title;
  return clip.title;
}

function stageKey() {
  const clip = currentClip();
  return JSON.stringify({
    page: pageId(),
    clip: clip && clip.clipId,
    title: clip && clip.title,
    lyrics: clip && clip.lyrics,
    revealed: state.revealed,
    lyricsShown: state.lyricsShown,
    video: state.videoVisible,
    counting: state.counting,
    random: state.randomPhase
  });
}

function paint() {
  const page = pageOrder()[state.page];
  document.getElementById("page-title").textContent = page.title;
  document.getElementById("page-sub").textContent = subtitle();
  paintNav();
  if (!state.desk) document.title = page.title;
  syncVeil();
  paintSeek();
  const key = stageKey();
  if (key !== shownKey) {
    shownKey = key;
    paintStage();
  }
  if (state.listOpen) paintList();
}

function paintStage() {
  const stage = document.getElementById("stage");
  stage.replaceChildren();
  const id = pageId();
  const clip = currentClip();
  if (id === "random" && state.randomPhase === "start") {
    const button = el("button", { type: "button", class: "answer", text: "Start" });
    button.addEventListener("click", startRandom);
    stage.append(button);
    return;
  }
  if (id === "random" && state.randomPhase === "finish") {
    stage.append(el("p", { class: "finish-show", text: "Finish!" }));
    return;
  }
  if (id === "random" && state.randomPhase === "play") {
    stage.append(el("div", { class: "lyrics-tools is-inline" }, [videoToggleButton()]));
    if (clip && !state.counting) stage.append(el("p", { class: "random-title", text: clip.title }));
    return;
  }
  if (id === "guess" && !state.revealed) {
    const button = el("button", { type: "button", class: "answer", text: "정답" });
    button.addEventListener("click", () => {
      state.revealed = true;
      state.needRestart = true;
      paint();
      playCurrent();
    });
    stage.append(button);
    return;
  }
  if (id === "guess" && state.revealed && clip) {
    stage.append(el("p", { class: "answer-title", text: clip.title }));
    return;
  }
  if (id !== "lyrics") return;
  const tools = el("div", { class: "lyrics-tools" });
  const toggle = videoToggleButton();
  const answer = el("button", { type: "button", class: "overlay-btn", text: "정답" });
  answer.addEventListener("click", () => {
    state.lyricsShown = true;
    try { if (player) player.pauseVideo(); } catch (error) { /* ignore */ }
    paint();
  });
  tools.append(toggle, answer);
  stage.append(tools);
  if (state.lyricsShown && clip) {
    stage.append(el("p", { class: "lyrics", text: clip.lyrics || "입력된 가사가 없습니다." }));
  }
}

function videoToggleButton() {
  const button = el("button", {
    type: "button",
    class: "overlay-btn",
    text: state.videoVisible ? "영상 가리기" : "영상 보이기"
  });
  button.addEventListener("click", () => {
    state.videoVisible = !state.videoVisible;
    paint();
  });
  return button;
}

function paintList() {
  const box = document.getElementById("playlist");
  const clips = clipsForPage();
  box.replaceChildren();
  if (!clips.length) {
    box.append(el("p", { class: "empty", text: "이 화면에 넣은 영상이 없습니다." }));
    return;
  }
  let grade = "";
  clips.forEach((clip, index) => {
    if (clip.gradeName && clip.gradeName !== grade) {
      grade = clip.gradeName;
      box.append(el("p", { class: "grade-label", text: grade }));
    }
    const button = el("button", { type: "button", class: "track" + (index === state.clip ? " is-on" : "") });
    button.append(document.createTextNode(clip.title));
    const when = rangeLabel(clip);
    if (when) button.append(el("small", { text: when }));
    button.addEventListener("click", () => jumpTo(index));
    box.append(button);
  });
}

function toggleList() {
  state.listOpen = !state.listOpen;
  const box = document.getElementById("playlist");
  box.hidden = !state.listOpen;
  document.getElementById("list-toggle").setAttribute("aria-expanded", state.listOpen ? "true" : "false");
  if (state.listOpen) paintList();
}

function deskBusy() {
  if (!state.desk) return false;
  const node = document.activeElement;
  if (!node) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA";
}

function renderDesk() {
  if (!state.desk) return;
  document.title = "찬양 진행 관리";
  const desk = document.getElementById("desk");
  if (!state.admin) {
    document.body.classList.remove("desk-open");
    desk.replaceChildren(loginCard());
    document.getElementById("login-form").addEventListener("submit", submitLogin);
    return;
  }
  desk.replaceChildren(editorCard());
  bindEditor();
  requestAnimationFrame(markLongTitles);
}

function deskTabs() {
  return [{ id: "videos", title: "유튜브 영상", fixed: true }, { id: "cue", title: "사이 음향", fixed: true }].concat(pageOrder());
}

function deskSection(id) {
  if (id === "videos") return videoBlock();
  if (id === "cue") return cueBlock();
  return pageBlock(PAGES.find((page) => page.id === id));
}

function loginCard() {
  return el("form", { class: "login desk desk-block", id: "login-form" }, [
    el("h2", { text: "관리자" }),
    el("label", { for: "login-id", text: "아이디" }),
    el("input", { id: "login-id", name: "username", autocomplete: "username", maxlength: "80" }),
    el("label", { for: "login-password", text: "비밀번호" }),
    el("input", { id: "login-password", name: "password", type: "password", autocomplete: "current-password", maxlength: "200" }),
    el("input", { class: "hp", id: "fax_number", name: "fax_number", tabindex: "-1", autocomplete: "off" }),
    el("div", { class: "actions" }, [
      el("button", { class: "ghost", type: "submit", text: "들어가기" }),
      el("a", { class: "text-link", href: "now.html", text: "진행 화면" })
    ])
  ]);
}

function editorCard() {
  const tabs = deskTabs();
  if (!tabs.some((tab) => tab.id === state.deskTab)) state.deskTab = "videos";
  const current = tabs.find((tab) => tab.id === state.deskTab);
  const nav = el("nav", { class: "desk-nav", id: "desk-nav", "aria-label": "관리 섹션" });
  const movable = el("div", { class: "desk-page-tabs" });
  tabs.forEach((tab) => {
    const button = el("button", {
      type: "button",
      class: "desk-tab" + (tab.id === state.deskTab ? " is-on" : ""),
      text: tab.title
    });
    button.addEventListener("click", () => {
      state.deskTab = tab.id;
      document.body.classList.remove("desk-open");
      renderDesk();
    });
    const row = el("div", { class: "desk-tab-row" + (tab.fixed ? " is-fixed" : "") });
    row.setAttribute("data-id", tab.id);
    if (!tab.fixed) row.append(grip());
    row.append(button);
    (tab.fixed ? nav : movable).append(row);
  });
  nav.append(movable);
  enableTabDrag(movable);
  const main = el("div", { class: "desk-main" }, [
    el("div", { class: "desk-head" }, [
      el("h1", { text: current.title }),
      el("div", { class: "actions" }, [
        el("a", { class: "text-link", href: "now.html", target: "_blank", rel: "noopener", text: "진행 화면" }),
        el("button", { type: "button", class: "ghost", id: "logout", text: "로그아웃" })
      ])
    ]),
    deskSection(state.deskTab)
  ]);
  return el("div", { class: "desk desk-app" }, [
    el("button", { type: "button", class: "desk-menu ghost", id: "desk-menu", text: "메뉴" }),
    nav,
    el("div", { class: "desk-scrim", id: "desk-scrim" }),
    main
  ]);
}

function videoBlock() {
  const block = el("section", { class: "desk-block" }, [
    el("h2", { class: "video-head" }, [
      document.createTextNode("유튜브 영상"),
      el("span", { class: "video-count", text: "전체 " + state.doc.videos.length })
    ]),
    el("p", { class: "desk-note", text: "제목과 주소를 저장해 두면 각 페이지에서 제목으로 찾아 넣습니다." })
  ]);
  state.doc.videos.forEach((video, index) => {
    const title = el("input", { value: video.title, maxlength: "80", "aria-label": "영상 제목" });
    const url = el("input", { value: video.url, maxlength: "400", "aria-label": "유튜브 주소" });
    const save = () => {
      const current = state.doc.videos.find((item) => item.id === video.id);
      if (!current) return;
      const nextTitle = title.value.trim();
      const nextUrl = url.value.trim();
      if (nextTitle === current.title && nextUrl === current.url) return;
      if (!nextTitle || !youtubeId(nextUrl)) {
        toast("영상 제목과 유튜브 주소를 확인해 주세요.");
        title.value = current.title;
        url.value = current.url;
        return;
      }
      current.title = nextTitle;
      current.url = nextUrl;
      queueSave();
    };
    title.addEventListener("change", save);
    title.addEventListener("blur", () => window.setTimeout(save, 0));
    url.addEventListener("change", save);
    url.addEventListener("blur", () => window.setTimeout(save, 0));
    const watch = watchButton(() => ({
      title: title.value.trim() || video.title,
      url: url.value.trim()
    }));
    const remove = el("button", { type: "button", class: "ghost mark", text: "−", "aria-label": "삭제" });
    remove.addEventListener("click", () => {
      if (!window.confirm("이 영상을 목록에서 지울까요?")) return;
      state.doc.videos = state.doc.videos.filter((item) => item.id !== video.id);
      PAGE_LISTS.forEach((id) => {
        state.doc.pages[id] = state.doc.pages[id].filter((clip) => clip.video !== video.id);
      });
      state.doc.grades.forEach((grade) => {
        grade.items = grade.items.filter((clip) => clip.video !== video.id);
      });
      queueSave();
      renderDesk();
    });
    const row = el("div", { class: "video-row" }, [
      el("span", { class: "video-no", text: "No. " + (index + 1) }),
      title,
      url,
      watch,
      remove
    ]);
    row.setAttribute("data-id", video.id);
    block.append(row);
  });
  const title = el("input", { id: "new-title", placeholder: "제목", maxlength: "80" });
  const url = el("input", { id: "new-url", placeholder: "유튜브 주소", maxlength: "400" });
  const add = el("button", { type: "button", class: "mark", text: "+", "aria-label": "추가" });
  add.addEventListener("click", () => {
    const nextTitle = title.value.trim();
    const nextUrl = url.value.trim();
    if (!nextTitle || !youtubeId(nextUrl)) {
      toast("영상 제목과 유튜브 주소를 확인해 주세요.");
      return;
    }
    state.doc.videos.push({ id: uid(), title: nextTitle, url: nextUrl });
    queueSave();
    renderDesk();
  });
  block.append(el("div", { class: "line" }, [
    el("span", { class: "video-no", "aria-hidden": "true" }),
    title,
    url,
    add
  ]));
  return block;
}

function cueBlock() {
  const name = state.doc.cueCustom ? (state.doc.cueName || "올린 음향") : "기본 음향";
  const block = el("section", { class: "desk-block" }, [
    el("h2", { text: "랜덤플레이 사이 음향" }),
    el("p", { class: "desk-note", text: "기본 음향은 짧은 소리 세 번 뒤에 조금 높은 긴 소리입니다. 다른 파일을 올리면 그 소리로 바뀌고, 기본 음향일 때만 화면에 3, 2, 1이 나옵니다." }),
    el("p", { class: "desk-note", text: "지금 소리: " + name })
  ]);
  const use = el("input", { type: "checkbox", id: "cue-on" });
  use.checked = !state.doc.cueOff;
  use.addEventListener("change", () => {
    state.doc.cueOff = !use.checked;
    queueSave();
  });
  const file = el("input", { type: "file", accept: "audio/*", hidden: "hidden" });
  file.addEventListener("change", () => {
    const picked = file.files && file.files[0];
    file.value = "";
    if (picked) uploadCue(picked);
  });
  const pick = el("button", { type: "button", class: "ghost", text: "음향 올리기" });
  pick.addEventListener("click", () => file.click());
  const preview = el("button", { type: "button", class: "ghost", text: "들어보기" });
  preview.addEventListener("click", () => {
    const audio = document.getElementById("cue");
    audio.src = cueSrc();
    audio.currentTime = 0;
    audio.play().catch(() => toast("소리를 재생하지 못했습니다."));
  });
  const clear = el("button", { type: "button", class: "ghost", text: "올린 음향 삭제" });
  clear.disabled = !state.doc.cueCustom;
  clear.addEventListener("click", async () => {
    if (!state.doc.cueCustom) return;
    if (!window.confirm("올린 음향을 지우고 기본 소리로 돌릴까요?")) return;
    try {
      applyDoc(await request("POST", { op: "cue-clear" }));
      toast("기본 음향으로 돌렸습니다.");
    } catch (error) {
      toast("음향을 지우지 못했습니다.");
    }
  });
  block.append(el("label", { class: "field", text: "영상 사이에 음향 사용" }, [use]));
  block.append(file, el("div", { class: "actions" }, [pick, preview, clear]));
  return block;
}

async function uploadCue(file) {
  if (file.size > 1500000) {
    toast("음향 파일은 1.5MB까지 올릴 수 있습니다.");
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(index, index + 8192)));
  }
  try {
    applyDoc(await request("POST", {
      op: "cue",
      name: file.name,
      data: btoa(binary)
    }));
    toast("음향을 저장했습니다.");
  } catch (error) {
    toast("음향을 저장하지 못했습니다.");
  }
}

function pageBlock(page) {
  const block = el("section", { class: "desk-block" }, [
    el("h2", { text: page.title })
  ]);
  if (page.id === "grade") {
    block.append(el("p", { class: "desk-note", text: "아래 칸에 학년, 영상, 시작, 끝을 입력하고 +를 누르면 한 곡이 추가됩니다. 순서는 왼쪽 핸들을 끌어 바꿉니다." }));
    const list = el("div", { class: "grades" });
    state.doc.grades.forEach((grade) => list.append(gradeBlock(grade)));
    block.append(list);
    enableGradeDrag(list);
    block.append(gradeAddForm());
    return block;
  }
  const note = page.id === "random"
    ? "목록 순서대로 재생하고, 곡과 곡 사이에 음향이 나갑니다. 플레이시간을 전체적용하면 끝은 시작 시간에 그 초를 더한 값이 됩니다."
    : page.id === "lyrics"
      ? "영상 제목을 고르고 가사를 입력합니다. 시작·끝은 비워 두면 처음부터 끝까지입니다."
      : "영상 제목을 검색해 넣습니다. 시작·끝은 비워 두면 처음부터 끝까지입니다.";
  block.append(el("p", { class: "desk-note", text: note }));
  if (page.id === "random") block.append(playSpanBar());
  const sectionId = page.id;
  mountClips(block, () => state.doc.pages[sectionId], page.id === "lyrics", page.id === "random" ? state.doc.playSeconds : 0);
  return block;
}

function gradeBlock(grade) {
  const row = el("div", { class: "grade-row" });
  row.setAttribute("data-id", grade.id);
  const name = el("input", { class: "grade-name", value: grade.name, maxlength: "40", "aria-label": "학년 이름" });
  name.addEventListener("change", () => {
    const next = name.value.trim();
    if (!next) {
      name.value = grade.name;
      toast("학년 이름을 입력해 주세요.");
      return;
    }
    grade.name = next;
    queueSave();
  });
  const remove = el("button", { type: "button", class: "ghost grade-delete", text: "학년 삭제" });
  remove.addEventListener("click", () => {
    if (!window.confirm("이 학년을 지울까요?")) return;
    state.doc.grades = state.doc.grades.filter((item) => item.id !== grade.id);
    queueSave();
    renderDesk();
  });
  row.append(grip(), name);
  const item = grade.items[0];
  if (item) gradeSong(row, grade, item);
  row.append(remove);
  return row;
}

function gradeSong(row, grade, item) {
  const video = findVideo(item.video);
  const start = el("input", { class: "time", value: formatTime(item.start), placeholder: "시작", "aria-label": "시작 시간" });
  const end = el("input", { class: "time", value: formatTime(item.end), placeholder: "끝", "aria-label": "종료 시간" });
  const applyTime = () => {
    const nextStart = readTime(start, item.start);
    const nextEnd = readTime(end, item.end);
    if (nextStart === false || nextEnd === false) return;
    if (nextStart != null && nextEnd != null && nextEnd <= nextStart) {
      toast("끝나는 시간은 시작보다 뒤여야 합니다.");
      start.value = formatTime(item.start);
      end.value = formatTime(item.end);
      return;
    }
    item.start = nextStart;
    item.end = nextEnd;
    queueSave();
  };
  start.addEventListener("change", applyTime);
  end.addEventListener("change", applyTime);
  const watch = watchButton(
    () => findVideo(item.video),
    () => ({
      start: quietTime(start.value, item.start),
      end: quietTime(end.value, item.end)
    })
  );
  const clear = el("button", { type: "button", class: "ghost mark", text: "−", "aria-label": "영상 삭제" });
  clear.addEventListener("click", () => {
    const index = grade.items.findIndex((clip) => clip.id === item.id);
    if (index >= 0) grade.items.splice(index, 1);
    queueSave();
    renderDesk();
  });
  row.append(
    el("div", { class: "grow" }, [el("strong", { text: video ? video.title : "지워진 영상" })]),
    start,
    end,
    watch,
    clear
  );
}

function gradeAddForm() {
  const row = el("div", { class: "grade-row grade-add" });
  const name = el("input", { class: "grade-name", maxlength: "40", placeholder: "학년", "aria-label": "학년 이름" });
  const input = el("input", { type: "text", placeholder: "영상 제목 검색", autocomplete: "off", "aria-label": "영상" });
  const matches = el("ul");
  let picked = "";
  const choose = (video) => {
    picked = video.id;
    input.value = video.title;
    matches.replaceChildren();
  };
  const paintMatches = (query) => {
    const needle = query.trim().toLowerCase();
    matches.replaceChildren();
    state.doc.videos.filter((video) => !needle || video.title.toLowerCase().includes(needle)).forEach((video) => {
      const button = el("button", { type: "button", text: video.title });
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        choose(video);
      });
      matches.append(el("li", {}, [button]));
    });
  };
  matches.addEventListener("mousedown", (event) => event.preventDefault());
  const showAll = () => paintMatches("");
  input.addEventListener("focus", showAll);
  input.addEventListener("pointerdown", showAll);
  input.addEventListener("input", () => {
    picked = "";
    paintMatches(input.value);
  });
  input.addEventListener("blur", () => matches.replaceChildren());
  const start = el("input", { class: "time", placeholder: "시작", "aria-label": "시작 시간" });
  const end = el("input", { class: "time", placeholder: "끝", "aria-label": "종료 시간" });
  const add = el("button", { type: "button", class: "mark", text: "+", "aria-label": "추가" });
  add.addEventListener("click", () => {
    const gradeName = name.value.trim();
    if (!gradeName) {
      toast("학년 이름을 입력해 주세요.");
      return;
    }
    const video = state.doc.videos.find((item) => item.id === picked) || state.doc.videos.find((item) => item.title === input.value.trim());
    if (!video) {
      toast("목록에 있는 영상 제목을 선택해 주세요.");
      return;
    }
    const nextStart = readTime(start, null);
    const nextEnd = readTime(end, null);
    if (nextStart === false || nextEnd === false) return;
    if (nextStart != null && nextEnd != null && nextEnd <= nextStart) {
      toast("끝나는 시간은 시작보다 뒤여야 합니다.");
      return;
    }
    state.doc.grades.push({
      id: uid(),
      name: gradeName,
      items: [{ id: uid(), video: video.id, start: nextStart, end: nextEnd }]
    });
    queueSave();
    renderDesk();
  });
  row.append(
    el("span", { class: "grade-pad", "aria-hidden": "true" }),
    name,
    el("div", { class: "suggest" }, [input, matches]),
    start,
    end,
    add
  );
  return row;
}

function enableGradeDrag(list) {
  list.querySelectorAll(".grade-row > .handle").forEach((handle) => {
    bindRowDrag(handle, ".grade-row", list, () => {
      const order = Array.from(list.querySelectorAll(".grade-row")).map((item) => item.getAttribute("data-id"));
      const next = order.map((id) => state.doc.grades.find((grade) => grade.id === id)).filter(Boolean);
      state.doc.grades.splice(0, state.doc.grades.length, ...next);
      queueSave();
    });
  });
}

function mountClips(container, getItems, withLyrics, playSeconds) {
  const span = playSeconds || 0;
  const list = el("div", { class: "clips" });
  getItems().forEach((item) => list.append(clipRow(item, getItems, withLyrics, span)));
  container.append(list);
  enableDrag(list, getItems);
  container.append(adder(getItems, withLyrics, span));
}

function playSpanBar() {
  const input = el("input", {
    class: "time",
    inputmode: "numeric",
    maxlength: "4",
    placeholder: "00",
    "aria-label": "플레이시간(초)"
  });
  if (state.doc.playSeconds) input.value = String(state.doc.playSeconds);
  const apply = el("button", { type: "button", class: "ghost", text: "전체적용" });
  apply.addEventListener("click", () => {
    const seconds = readSeconds(input.value);
    if (!seconds) {
      toast("플레이 시간은 초 단위로 입력해 주세요.");
      input.value = state.doc.playSeconds ? String(state.doc.playSeconds) : "";
      return;
    }
    state.doc.playSeconds = seconds;
    state.doc.pages.random.forEach((clip) => {
      clip.end = clampSec((clip.start || 0) + seconds);
    });
    queueSave();
    renderDesk();
  });
  return el("div", { class: "play-span" }, [
    el("span", { class: "play-span-label", text: "플레이시간" }),
    input,
    el("span", { text: "초" }),
    apply
  ]);
}

function readSeconds(text) {
  const raw = String(text || "").trim();
  if (!/^\d+$/.test(raw)) return null;
  return clampSec(Number(raw));
}

function clipRow(item, getItems, withLyrics, playSeconds) {
  const video = findVideo(item.video);
  const row = el("div", { class: "clip" });
  row.setAttribute("data-id", item.id);
  const handle = grip();
  const grow = el("div", { class: "grow" }, [
    el("strong", { text: video ? video.title : "지워진 영상" })
  ]);
  const start = el("input", { class: "time", value: formatTime(item.start), placeholder: "시작", "aria-label": "시작 시간" });
  const end = el("input", { class: "time", value: formatTime(item.end), placeholder: "끝", "aria-label": "종료 시간" });
  const applyTime = (source) => {
    const nextStart = readTime(start, item.start);
    const nextEnd = readTime(end, item.end);
    if (nextStart === false || nextEnd === false) return;
    let endValue = nextEnd;
    if (source === "start" && playSeconds) endValue = clampSec((nextStart || 0) + playSeconds);
    if (nextStart != null && endValue != null && endValue <= nextStart) {
      toast("끝나는 시간은 시작보다 뒤여야 합니다.");
      start.value = formatTime(item.start);
      end.value = formatTime(item.end);
      return;
    }
    item.start = nextStart;
    item.end = endValue;
    end.value = formatTime(item.end);
    queueSave();
  };
  start.addEventListener("change", () => applyTime("start"));
  end.addEventListener("change", () => applyTime("end"));
  const watch = watchButton(
    () => findVideo(item.video),
    () => ({
      start: quietTime(start.value, item.start),
      end: quietTime(end.value, item.end)
    })
  );
  const remove = el("button", { type: "button", class: "ghost mark", text: "−", "aria-label": "삭제" });
  remove.addEventListener("click", () => {
    const items = getItems();
    const index = items.findIndex((clip) => clip.id === item.id);
    if (index >= 0) items.splice(index, 1);
    queueSave();
    renderDesk();
  });
  row.append(handle, grow, start, end, watch, remove);
  if (withLyrics) {
    row.classList.add("has-lyrics");
    const lyrics = el("textarea", { class: "lyrics-field", rows: "2", placeholder: "가사", maxlength: "4000" });
    lyrics.value = item.lyrics || "";
    lyrics.addEventListener("change", () => {
      item.lyrics = lyrics.value.trim();
      queueSave();
    });
    row.append(lyrics);
  }
  return row;
}

function quietTime(text, fallback) {
  if (!String(text || "").trim()) return fallback;
  const value = parseTime(text);
  return value == null ? fallback : value;
}

function playGlyph() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M8 5.5v13l11-6.5z");
  svg.append(path);
  return svg;
}

function watchButton(videoSource, rangeSource) {
  const button = el("button", { type: "button", class: "ghost mark play", "aria-label": "재생" });
  button.append(playGlyph());
  button.addEventListener("click", () => {
    const video = videoSource();
    const id = video ? youtubeId(video.url) : "";
    if (!id) {
      toast("재생할 유튜브 영상을 찾지 못했습니다.");
      return;
    }
    const range = rangeSource ? rangeSource() : {};
    openWatch(id, video.title || "영상", range.start, range.end, button);
  });
  return button;
}

let watchKeyHandler = null;

function closeWatch() {
  const node = document.getElementById("watch");
  if (node) {
    const frame = node.querySelector("iframe");
    if (frame) frame.src = "";
    node.remove();
  }
  document.body.classList.remove("watch-open");
  if (watchKeyHandler) {
    document.removeEventListener("keydown", watchKeyHandler);
    watchKeyHandler = null;
  }
}

function openWatch(id, title, start, end, opener) {
  closeWatch();
  const params = new URLSearchParams({
    autoplay: "1",
    rel: "0",
    modestbranding: "1",
    playsinline: "1"
  });
  if (start) params.set("start", String(start));
  if (end && (!start || end > start)) params.set("end", String(end));
  const frame = document.createElement("iframe");
  frame.src = "https://www.youtube.com/embed/" + id + "?" + params.toString();
  frame.title = title;
  frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
  frame.setAttribute("allowfullscreen", "");
  const finish = () => {
    closeWatch();
    if (opener && opener.isConnected) opener.focus();
  };
  const close = el("button", { type: "button", text: "닫기" });
  close.addEventListener("click", finish);
  const scrim = el("button", { type: "button", class: "watch-scrim", "aria-label": "닫기" });
  scrim.addEventListener("click", finish);
  const dialog = el("div", {
    class: "watch",
    id: "watch",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": title
  }, [
    scrim,
    el("div", { class: "watch-card" }, [
      el("div", { class: "watch-head" }, [
        el("strong", { text: title }),
        close
      ]),
      el("div", { class: "watch-frame" }, [frame])
    ])
  ]);
  document.body.append(dialog);
  document.body.classList.add("watch-open");
  watchKeyHandler = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    finish();
  };
  document.addEventListener("keydown", watchKeyHandler);
  close.focus();
}

function readTime(input, previous) {
  if (!input.value.trim()) return null;
  const value = parseTime(input.value);
  if (value == null) {
    toast("시간은 1:30 또는 초 단위로 입력해 주세요.");
    input.value = formatTime(previous);
    return false;
  }
  return value;
}

function adder(getItems, withLyrics, playSeconds) {
  const wrap = el("div", { class: "adder" });
  const input = el("input", { type: "text", placeholder: "영상 제목 검색", autocomplete: "off" });
  const matches = el("ul");
  let picked = "";
  const choose = (video) => {
    picked = video.id;
    input.value = video.title;
    matches.replaceChildren();
  };
  const paintMatches = (query) => {
    const needle = query.trim().toLowerCase();
    matches.replaceChildren();
    state.doc.videos.filter((video) => !needle || video.title.toLowerCase().includes(needle)).forEach((video) => {
      const button = el("button", { type: "button", text: video.title });
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        choose(video);
      });
      matches.append(el("li", {}, [button]));
    });
  };
  matches.addEventListener("mousedown", (event) => event.preventDefault());
  const showAll = () => paintMatches("");
  input.addEventListener("focus", showAll);
  input.addEventListener("pointerdown", showAll);
  input.addEventListener("input", () => {
    picked = "";
    paintMatches(input.value);
  });
  input.addEventListener("blur", () => matches.replaceChildren());
  const start = el("input", { class: "time", placeholder: "시작", "aria-label": "시작 시간" });
  const end = el("input", { class: "time", placeholder: "끝", "aria-label": "종료 시간" });
  const lyrics = withLyrics ? el("textarea", { class: "lyrics-field", rows: "2", placeholder: "가사", maxlength: "4000" }) : null;
  const add = el("button", { type: "button", class: "mark", text: "+", "aria-label": "추가" });
  add.addEventListener("click", () => {
    const video = state.doc.videos.find((item) => item.id === picked) || state.doc.videos.find((item) => item.title === input.value.trim());
    if (!video) {
      toast("목록에 있는 영상 제목을 선택해 주세요.");
      return;
    }
    const nextStart = readTime(start, null);
    let nextEnd = readTime(end, null);
    if (nextStart === false || nextEnd === false) return;
    if (nextEnd == null && playSeconds) nextEnd = clampSec((nextStart || 0) + playSeconds);
    if (nextStart != null && nextEnd != null && nextEnd <= nextStart) {
      toast("끝나는 시간은 시작보다 뒤여야 합니다.");
      return;
    }
    const clip = { id: uid(), video: video.id, start: nextStart, end: nextEnd };
    if (withLyrics) clip.lyrics = lyrics.value.trim();
    getItems().push(clip);
    queueSave();
    renderDesk();
  });
  wrap.append(el("div", { class: "suggest" }, [input, matches]), start, end, add);
  if (lyrics) wrap.append(lyrics);
  return wrap;
}

function grip() {
  const handle = el("span", { class: "handle", role: "button", tabindex: "0", "aria-label": "순서 변경" });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 12");
  svg.setAttribute("aria-hidden", "true");
  [1, 5.2, 9.4].forEach((y) => {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    line.setAttribute("x", "1");
    line.setAttribute("y", String(y));
    line.setAttribute("width", "14");
    line.setAttribute("height", "1.6");
    line.setAttribute("rx", "0.8");
    line.setAttribute("fill", "currentColor");
    svg.append(line);
  });
  handle.append(svg);
  return handle;
}

function markLongTitles() {
  document.querySelectorAll(".clip .grow strong, .grade-row .grow strong").forEach((node) => {
    if (node.scrollWidth > node.clientWidth + 1) node.title = node.textContent;
    else node.removeAttribute("title");
  });
}

function bindRowDrag(handle, rowSelector, container, onDrop) {
  handle.addEventListener("pointerdown", (event) => {
    if (event.button != null && event.button !== 0) return;
    const row = handle.closest(rowSelector);
    if (!row || !container.contains(row)) return;
    event.preventDefault();
    state.dragging = true;
    row.classList.add("is-dragging");
    const pointerId = event.pointerId;
    try { handle.setPointerCapture(pointerId); } catch (error) { /* pointer already released */ }
    let done = false;
    const move = (ev) => {
      if (ev.pointerId !== pointerId) return;
      const rows = Array.from(container.children).filter((item) => item.matches(rowSelector));
      const target = rows.find((item) => {
        const box = item.getBoundingClientRect();
        return ev.clientY < box.top + box.height / 2;
      });
      if (target && target !== row) container.insertBefore(row, target);
      else if (!target && container.lastElementChild !== row) container.append(row);
    };
    const finish = (ev) => {
      if (done) return;
      if (ev && ev.pointerId != null && ev.pointerId !== pointerId) return;
      done = true;
      state.dragging = false;
      row.classList.remove("is-dragging");
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
      onDrop();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
  });
}

function enableTabDrag(nav) {
  nav.querySelectorAll(".handle").forEach((handle) => {
    bindRowDrag(handle, ".desk-tab-row", nav, () => {
      state.doc.tabOrder = Array.from(nav.querySelectorAll(".desk-tab-row")).map((item) => item.getAttribute("data-id"));
      queueSave();
    });
  });
}

function enableDrag(list, getItems) {
  list.querySelectorAll(".handle").forEach((handle) => {
    bindRowDrag(handle, ".clip", list, () => {
      const items = getItems();
      const order = Array.from(list.querySelectorAll(".clip")).map((item) => item.getAttribute("data-id"));
      const next = order.map((id) => items.find((item) => item.id === id)).filter(Boolean);
      items.splice(0, items.length, ...next);
      queueSave();
    });
  });
}

function bindEditor() {
  const logout = document.getElementById("logout");
  if (logout) logout.addEventListener("click", () => {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (error) { /* ignore */ }
    state.admin = false;
    renderDesk();
  });
  const menu = document.getElementById("desk-menu");
  const scrim = document.getElementById("desk-scrim");
  if (menu) menu.addEventListener("click", () => document.body.classList.toggle("desk-open"));
  if (scrim) scrim.addEventListener("click", () => document.body.classList.remove("desk-open"));
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
  loginBusy = true;
  try {
    const hash = await sha256(password);
    if (!(id === ADMIN_ID && safeEqual(hash, ADMIN_PASSWORD_SHA256))) {
      registerLoginFailure();
      document.getElementById("login-password").value = "";
      toast("아이디 또는 비밀번호를 다시 확인해 주세요.");
      return;
    }
    try { sessionStorage.removeItem(LOGIN_LOCK_KEY); } catch (error) { /* ignore */ }
    await issueSession();
    state.admin = true;
    renderDesk();
  } catch (error) {
    toast("이 페이지는 https 또는 localhost에서 열어 주세요.");
  } finally {
    loginBusy = false;
  }
}

async function refresh() {
  if (state.saving || state.dragging || deskBusy() || localDirty()) return;
  try {
    applyDoc(await request("GET"));
  } catch (error) { /* keep the screen up */ }
}

function clipBounds(clip) {
  let duration = 0;
  try { duration = player && player.getDuration ? player.getDuration() || 0 : 0; } catch (error) { duration = 0; }
  const start = clip.start || 0;
  let end = clip.end == null ? duration : clip.end;
  if (duration && end > duration) end = duration;
  if (!(end > start)) end = duration > start ? duration : start + 1;
  return { start: start, end: end };
}

function seekVisible() {
  const clip = currentClip();
  if (!clip || state.desk || state.counting || state.loadedId !== clip.clipId) return false;
  if (pageId() === "random" && state.randomPhase !== "play") return false;
  if (pageId() === "guess" && !state.revealed) return false;
  return true;
}

function paintSeekFill(range) {
  const pct = (Number(range.value) / 1000) * 100;
  range.style.background = "linear-gradient(90deg, #c8c8c8 " + pct + "%, rgba(200,200,200,0.28) " + pct + "%)";
}

function paintSeek() {
  const bar = document.getElementById("seek");
  if (!bar) return;
  const show = seekVisible();
  bar.hidden = !show;
  if (!show) return;
  const bounds = clipBounds(currentClip());
  const span = Math.max(0.01, bounds.end - bounds.start);
  if (seeking) return;
  let now = bounds.start;
  try { now = player.getCurrentTime(); } catch (error) { now = bounds.start; }
  const ratio = Math.min(1, Math.max(0, (now - bounds.start) / span));
  const range = document.getElementById("seek-range");
  range.value = String(Math.round(ratio * 1000));
  paintSeekFill(range);
  document.getElementById("seek-time").textContent = formatTime(Math.max(0, now - bounds.start));
  document.getElementById("seek-total").textContent = formatTime(span);
}

function seekRatio(ratio) {
  const clip = currentClip();
  if (!clip || !player || !player.seekTo) return;
  const bounds = clipBounds(clip);
  const span = Math.max(0, bounds.end - bounds.start);
  const time = bounds.start + Math.min(1, Math.max(0, ratio)) * span;
  let paused = false;
  try { paused = player.getPlayerState() === 2; } catch (error) { paused = false; }
  try { player.seekTo(Math.min(time, Math.max(bounds.start, bounds.end - 0.05)), true); } catch (error) { return; }
  if (paused) {
    try { player.pauseVideo(); } catch (error) { /* keep the paused frame */ }
  }
  document.getElementById("seek-time").textContent = formatTime(Math.max(0, time - bounds.start));
  paintSeekFill(document.getElementById("seek-range"));
}

function playbackBlocked() {
  if (pageId() === "random" && state.randomPhase !== "play") return true;
  if (pageId() === "guess" && !state.revealed) return true;
  return !currentClip();
}

function playerCode() {
  try { return player && player.getPlayerState ? player.getPlayerState() : -1; } catch (error) { return -1; }
}

function resumePlay() {
  if (playbackBlocked()) return;
  const code = playerCode();
  const same = state.loadedId === currentClip().clipId;
  if (same && code === 1) return;
  state.needRestart = !(same && code === 2);
  playCurrent();
}

function pausePlay() {
  try { if (player) player.pauseVideo(); } catch (error) { /* ignore */ }
}

function bindShow() {
  document.getElementById("page-prev").addEventListener("click", () => setPage(state.page - 1));
  document.getElementById("page-next").addEventListener("click", goNextPage);
  document.getElementById("play").addEventListener("click", resumePlay);
  document.getElementById("pause").addEventListener("click", pausePlay);
  document.getElementById("next-track").addEventListener("click", nextTrack);
  const range = document.getElementById("seek-range");
  range.addEventListener("pointerdown", (event) => {
    seeking = true;
    try { range.setPointerCapture(event.pointerId); } catch (error) { /* already released */ }
  });
  range.addEventListener("pointerup", () => { seeking = false; });
  range.addEventListener("pointercancel", () => { seeking = false; });
  range.addEventListener("input", () => {
    seeking = true;
    seekRatio(Number(range.value) / 1000);
  });
  range.addEventListener("change", () => {
    seeking = false;
    seekRatio(Number(range.value) / 1000);
  });
  seekTimer = window.setInterval(paintSeek, 250);
  document.getElementById("list-toggle").addEventListener("click", toggleList);
  document.addEventListener("keydown", (event) => {
    if (state.desk) return;
    const tag = event.target && event.target.tagName;
    const typing = tag === "TEXTAREA" || (tag === "INPUT" && event.target.type !== "range");
    if (event.key === " ") {
      if (typing) return;
      event.preventDefault();
      if (event.repeat || state.counting || playbackBlocked()) return;
      const code = playerCode();
      if (code === 1 || code === 3) pausePlay();
      else resumePlay();
      return;
    }
    if (typing || tag === "INPUT") return;
    if (event.key === "ArrowLeft") setPage(state.page - 1);
    if (event.key === "ArrowRight") goNextPage();
  });
}

async function boot() {
  const hash = location.hash.replace(/^#/, "");
  const found = pageOrder().findIndex((page) => page.id === hash);
  state.page = found < 0 ? 0 : found;
  if (state.desk) {
    document.body.classList.add("is-desk");
    document.getElementById("desk").hidden = false;
    try { state.admin = await readSession(); } catch (error) { state.admin = false; }
  } else {
    loadYouTube();
    bindShow();
    paint();
  }
  try {
    await loadStore();
    applyDoc(await request("GET"));
  } catch (error) {
    if (state.desk) renderDesk();
    else paint();
    toast("저장된 목록을 불러오지 못했습니다.");
  }
  setInterval(() => { refresh(); }, 5000);
  window.addEventListener("pagehide", saveOnLeave);
}

boot();
