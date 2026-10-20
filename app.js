"use strict";

const ADMIN_ID = "ohzbell";
const ADMIN_PASSWORD_SHA256 = "467da2f448515085ff6bf87ff1971d917f7b797397326a2101f67130cfc69dca";
const SESSION_TTL = 8 * 60 * 60 * 1000;
const RATE_MS = 5000;
const LOGIN_LOCK_MS = 30000;
const LOGIN_FAIL_LIMIT = 5;

const STORAGE = {
  answers: "dure.answers.v1",
  content: "dure.content.v1",
  author: "dure.author.v1",
  cooldown: "dure.cooldown.v1"
};
const SESSION_KEY = "dure.admin.session.v1";
const LOGIN_LOCK_KEY = "dure.admin.lock.v1";

const LIMITS = {
  answer: 8000,
  question: 1000,
  areaTitle: 80,
  areaSummary: 200,
  refTitle: 120,
  refBody: 20000
};

const state = {
  authors: [],
  areas: [],
  references: [],
  answers: {},
  drafts: {},
  selected: {},
  areaId: "",
  adminAreaId: "",
  adminTab: "questions",
  authorId: "",
  isAdmin: false,
  files: { revision: 1, areas: [], references: [] },
  cooldownUntil: 0
};

let lastFocus = null;
let toastTimer = 0;
let saveSum = 0;
let loginSum = 0;
let pendingSave = null;
let saveBusy = false;
let loginBusy = false;

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  const props = attrs || {};
  Object.keys(props).forEach((key) => {
    const value = props[key];
    if (value == null || value === false) return;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "disabled") node.disabled = true;
    else if (key.indexOf("on") === 0 && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? "" : String(value));
  });
  const list = Array.isArray(children) ? children : children == null ? [] : [children];
  list.forEach((child) => {
    if (child == null || child === false) return;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return node;
}

function toast(message) {
  const node = document.getElementById("toast");
  node.textContent = message;
  node.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.remove("show"), 3400);
}

function readStore(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    toast("이 브라우저 저장 공간에 기록하지 못했습니다.");
    return false;
  }
}

function readSessionStore(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

function readRaw(key) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(url + " 파일을 읽지 못했습니다.");
  return response.json();
}

async function sha256(text) {
  if (!window.crypto || !window.crypto.subtle) throw new Error("secure-context");
  const data = new TextEncoder().encode(text);
  const digest = await window.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return diff === 0;
}

async function issueSession() {
  const exp = Date.now() + SESSION_TTL;
  const token = await sha256(ADMIN_ID + "|" + exp + "|" + ADMIN_PASSWORD_SHA256);
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id: ADMIN_ID, exp: exp, token: token }));
}

async function readSession() {
  const data = readSessionStore(SESSION_KEY);
  if (!data || data.id !== ADMIN_ID || typeof data.exp !== "number" || data.exp < Date.now() || typeof data.token !== "string") {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (error) { /* ignore */ }
    return false;
  }
  try {
    const expected = await sha256(data.id + "|" + data.exp + "|" + ADMIN_PASSWORD_SHA256);
    if (!safeEqual(expected, data.token)) {
      sessionStorage.removeItem(SESSION_KEY);
      return false;
    }
    return true;
  } catch (error) {
    return false;
  }
}

function loginLockRemaining() {
  const data = readSessionStore(LOGIN_LOCK_KEY);
  if (!data || !data.until) return 0;
  return Math.max(0, Number(data.until) - Date.now());
}

function registerLoginFailure() {
  const data = readSessionStore(LOGIN_LOCK_KEY) || { count: 0, until: 0 };
  if (data.until && data.until > Date.now()) return;
  data.count = Number(data.count || 0) + 1;
  if (data.count >= LOGIN_FAIL_LIMIT) {
    data.count = 0;
    data.until = Date.now() + LOGIN_LOCK_MS;
  }
  sessionStorage.setItem(LOGIN_LOCK_KEY, JSON.stringify(data));
}

function honeypotFilled() {
  const field = document.getElementById("fax_number");
  return Boolean(field && field.value.trim());
}

function cooldownRemaining() {
  const stored = Number(readRaw(STORAGE.cooldown) || 0);
  const until = Math.max(stored, state.cooldownUntil || 0);
  return Math.max(0, until - Date.now());
}

function assertCooldown() {
  const left = cooldownRemaining();
  if (left > 0) {
    toast("연속 작성을 막기 위해 " + Math.ceil(left / 1000) + "초 후에 다시 시도해 주세요.");
    return false;
  }
  return true;
}

function stampCooldown() {
  const until = Date.now() + RATE_MS;
  state.cooldownUntil = until;
  try { localStorage.setItem(STORAGE.cooldown, String(until)); } catch (error) { /* ignore */ }
  updateCooldownUI();
}

function updateCooldownUI() {
  const left = Math.ceil(cooldownRemaining() / 1000);
  const note = document.getElementById("cooldown-note");
  if (note) {
    note.textContent = left > 0 ? "연속 작성 제한 · " + left + "초 후에 다시 저장하거나 삭제할 수 있습니다." : "";
  }
  document.querySelectorAll("[data-guard='cooldown']").forEach((button) => {
    button.disabled = left > 0;
  });
}

function uid(prefix) {
  return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function currentArea() {
  return state.areas.find((area) => area.id === state.areaId) || state.areas[0];
}

function currentAdminArea() {
  return state.areas.find((area) => area.id === state.adminAreaId) || currentArea();
}

function currentAuthor() {
  return state.authors.find((author) => author.id === state.authorId) || null;
}

function getAnswer(questionId, authorId) {
  const bucket = state.answers[questionId];
  if (!bucket || !bucket[authorId] || !bucket[authorId].text) return null;
  return bucket[authorId];
}

function findQuestion(id) {
  for (let index = 0; index < state.areas.length; index += 1) {
    const area = state.areas[index];
    const question = area.questions.find((item) => item.id === id);
    if (question) return { area: area, question: question };
  }
  return null;
}

function answeredCount(area) {
  if (!state.authorId) return 0;
  return area.questions.filter((question) => getAnswer(question.id, state.authorId)).length;
}

const KV_ROOT = "https://keyvalue.immanuel.co/api/KeyVal";
const KV_URL_BUDGET = 270;

let answerStore = { appKey: "" };
let remoteStamp = "";
let syncing = false;

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const updatedAt = typeof entry.updatedAt === "string" ? entry.updatedAt : "";
  if (!updatedAt) return null;
  if (entry.deleted === true) return { text: "", deleted: true, updatedAt: updatedAt };
  if (typeof entry.text !== "string") return null;
  const text = entry.text.trim().slice(0, LIMITS.answer);
  if (!text) return null;
  return { text: text, updatedAt: updatedAt };
}

function mergeAnswers(base, extra) {
  const out = {};
  function take(source) {
    if (!source || typeof source !== "object" || Array.isArray(source)) return;
    Object.keys(source).forEach((questionId) => {
      const byAuthor = source[questionId];
      if (!byAuthor || typeof byAuthor !== "object" || Array.isArray(byAuthor)) return;
      Object.keys(byAuthor).forEach((authorId) => {
        const next = normalizeEntry(byAuthor[authorId]);
        if (!next) return;
        if (!out[questionId]) out[questionId] = {};
        const prev = out[questionId][authorId];
        if (!prev || String(next.updatedAt) >= String(prev.updatedAt || "")) {
          out[questionId][authorId] = next;
        }
      });
    });
  }
  take(base);
  take(extra);
  return out;
}

function exportableAnswers() {
  const out = {};
  Object.keys(state.answers).forEach((questionId) => {
    const bucket = state.answers[questionId];
    if (!bucket || typeof bucket !== "object") return;
    Object.keys(bucket).forEach((authorId) => {
      const entry = normalizeEntry(bucket[authorId]);
      if (!entry || entry.deleted) return;
      if (!out[questionId]) out[questionId] = {};
      out[questionId][authorId] = { text: entry.text, updatedAt: entry.updatedAt };
    });
  });
  return out;
}

function cacheAnswers() {
  writeStore(STORAGE.answers, state.answers);
}

function timeKey(iso) {
  return String(iso || "").replace(/\D/g, "").slice(0, 17).padEnd(17, "0");
}

function encodeB64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeB64Url(text) {
  const pad = (4 - (text.length % 4)) % 4;
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

function pairName(questionId, authorId, suffix) {
  const question = String(questionId).replace(/[^A-Za-z0-9-]/g, "");
  const author = String(authorId).replace(/[^A-Za-z0-9-]/g, "");
  if (!question || !author) throw new Error("질문 또는 작성자 아이디를 서버 키로 바꾸지 못했습니다.");
  return "a_" + question + "_" + author + "_" + suffix;
}

function valueBudget(name) {
  const prefix = KV_ROOT + "/UpdateValue/" + answerStore.appKey + "/" + name + "/";
  return KV_URL_BUDGET - prefix.length;
}

function encodeChunks(value, budget) {
  const encoded = encodeB64Url(JSON.stringify(value));
  const size = Math.min(150, budget);
  if (size < 40) throw new Error("서버 키 이름이 너무 깁니다.");
  const parts = [];
  for (let index = 0; index < encoded.length; index += size) parts.push(encoded.slice(index, index + size));
  return parts.length ? parts : [encodeB64Url("{}")];
}

async function kvPut(name, value) {
  if (!/^[A-Za-z0-9_-]+$/.test(name) || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("서버에 보낼 수 없는 문자가 있습니다.");
  }
  if (value.length > valueBudget(name)) throw new Error("서버에 보낼 조각이 너무 깁니다.");
  const response = await fetch(KV_ROOT + "/UpdateValue/" + answerStore.appKey + "/" + name + "/" + value, {
    method: "POST",
    cache: "no-store"
  });
  const body = (await response.text()).trim();
  if (!response.ok || body !== "true") throw new Error("답변 서버에 저장하지 못했습니다.");
}

async function kvRead(name) {
  const response = await fetch(KV_ROOT + "/GetValue/" + answerStore.appKey + "/" + name, { cache: "no-store" });
  if (!response.ok) throw new Error("답변 서버를 읽지 못했습니다.");
  const data = await response.json();
  return data == null ? "" : String(data);
}

async function mapPool(items, limit, worker) {
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  }
  const count = Math.min(limit, items.length);
  const jobs = [];
  for (let index = 0; index < count; index += 1) jobs.push(run());
  await Promise.all(jobs);
}

async function writeBlob(baseName, value) {
  const sample = baseName + "0";
  const parts = encodeChunks(value, valueBudget(sample));
  await mapPool(parts, 4, (part, index) => kvPut(baseName + index, part));
  await kvPut(baseName + "n", String(parts.length));
}

async function readBlob(baseName) {
  const count = Number(await kvRead(baseName + "n")) || 0;
  if (!count) return null;
  let blob = "";
  for (let index = 0; index < count; index += 1) blob += await kvRead(baseName + index);
  if (!blob) return null;
  return JSON.parse(decodeB64Url(blob));
}

async function writeEntry(questionId, authorId, entry) {
  const payload = entry.deleted
    ? { d: true, u: entry.updatedAt }
    : { t: entry.text, u: entry.updatedAt };
  const base = pairName(questionId, authorId, "p");
  await writeBlob(base, payload);
  await kvPut(pairName(questionId, authorId, "u"), timeKey(entry.updatedAt));
}

async function readEntry(questionId, authorId) {
  const payload = await readBlob(pairName(questionId, authorId, "p"));
  if (!payload || typeof payload.u !== "string") return null;
  if (payload.d === true) return { text: "", deleted: true, updatedAt: payload.u };
  if (typeof payload.t !== "string") return null;
  return normalizeEntry({ text: payload.t, updatedAt: payload.u });
}

async function readIndex() {
  const payload = await readBlob("i");
  if (!Array.isArray(payload)) return [];
  return payload.filter((pair) => Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string");
}

async function writeIndex(pairs) {
  await writeBlob("i", pairs);
  await kvPut("iu", timeKey(new Date().toISOString()));
}

async function ensureIndexed(pairs) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await readIndex();
    const map = new Map();
    current.forEach((pair) => map.set(pair[0] + "\n" + pair[1], pair));
    pairs.forEach((pair) => map.set(pair[0] + "\n" + pair[1], pair));
    await writeIndex(Array.from(map.values()));
    const verify = await readIndex();
    const missing = pairs.some((pair) => !verify.some((item) => item[0] === pair[0] && item[1] === pair[1]));
    if (!missing) {
      remoteStamp = await kvRead("iu");
      return;
    }
  }
  throw new Error("답변 목록을 서버에 반영하지 못했습니다.");
}

async function syncEntries(pairs) {
  const fresh = [];
  for (let index = 0; index < pairs.length; index += 1) {
    const questionId = pairs[index][0];
    const authorId = pairs[index][1];
    const entry = normalizeEntry(state.answers[questionId] && state.answers[questionId][authorId]);
    if (!entry) continue;
    const remote = await kvRead(pairName(questionId, authorId, "u"));
    if (remote && remote > timeKey(entry.updatedAt)) {
      const newer = await readEntry(questionId, authorId);
      if (newer) state.answers[questionId][authorId] = newer;
      continue;
    }
    await writeEntry(questionId, authorId, entry);
    fresh.push([questionId, authorId]);
  }
  if (fresh.length) await ensureIndexed(fresh);
  cacheAnswers();
}

async function fetchRemoteAnswers() {
  const pairs = await readIndex();
  const out = {};
  await mapPool(pairs, 6, async (pair) => {
    const entry = await readEntry(pair[0], pair[1]);
    if (!entry) return;
    if (!out[pair[0]]) out[pair[0]] = {};
    out[pair[0]][pair[1]] = entry;
  });
  return out;
}

async function refreshAnswers() {
  if (syncing || saveBusy || !answerStore.appKey) return;
  syncing = true;
  try {
    const stamp = await kvRead("iu");
    if (stamp === remoteStamp) return;
    const remote = await fetchRemoteAnswers();
    remoteStamp = stamp;
    const merged = mergeAnswers(state.answers, remote);
    if (JSON.stringify(merged) === JSON.stringify(state.answers)) return;
    state.answers = merged;
    cacheAnswers();
    const typing = document.activeElement && document.activeElement.tagName === "TEXTAREA";
    if (!typing) renderBoard();
  } catch (error) {
    return;
  } finally {
    syncing = false;
  }
}

function persistContent() {
  writeStore(STORAGE.content, {
    revision: state.files.revision,
    areas: state.areas,
    references: state.references
  });
}

async function loadData() {
  const authorsFile = await fetchJson("data/authors.json");
  const questionsFile = await fetchJson("data/questions.json");
  const referencesFile = await fetchJson("data/references.json");
  let answersFile = { answers: {} };
  try { answersFile = await fetchJson("data/answers.json"); } catch (error) { answersFile = { answers: {} }; }

  if (!authorsFile || !Array.isArray(authorsFile.authors) || authorsFile.authors.length === 0) {
    throw new Error("data/authors.json에 작성자가 없습니다.");
  }
  if (!isQuestionFile(questionsFile)) throw new Error("data/questions.json 형식을 확인해 주세요.");
  if (!isReferenceFile(referencesFile)) throw new Error("data/references.json 형식을 확인해 주세요.");

  state.authors = authorsFile.authors;
  state.files = {
    revision: Math.max(Number(questionsFile.revision) || 1, Number(referencesFile.revision) || 1),
    areas: structuredClone(questionsFile.areas),
    references: structuredClone(referencesFile.references)
  };

  const draft = readStore(STORAGE.content);
  const draftOk = draft && Number(draft.revision) >= state.files.revision && isQuestionFile({ areas: draft.areas }) && isReferenceFile({ references: draft.references });
  if (draftOk) {
    state.areas = draft.areas;
    state.references = draft.references;
  } else {
    state.areas = structuredClone(state.files.areas);
    state.references = structuredClone(state.files.references);
    if (draft) {
      try { localStorage.removeItem(STORAGE.content); } catch (error) { /* ignore */ }
    }
  }

  let storeFile = null;
  try { storeFile = await fetchJson("data/store.json"); } catch (error) { storeFile = null; }
  if (!storeFile || typeof storeFile.appKey !== "string" || !/^[A-Za-z0-9]+$/.test(storeFile.appKey)) {
    throw new Error("data/store.json의 저장소 키를 확인해 주세요.");
  }
  answerStore = storeFile;
  try {
    const remote = await fetchRemoteAnswers();
    remoteStamp = await kvRead("iu");
    state.answers = mergeAnswers(answersFile.answers || {}, remote);
    cacheAnswers();
  } catch (error) {
    state.answers = mergeAnswers(answersFile.answers || {}, readStore(STORAGE.answers) || {});
    toast("답변 서버에 연결하지 못했습니다. 이전에 이 브라우저에 남은 답변만 보여 줍니다.");
  }
  state.areaId = state.areas[0].id;
  const storedAuthor = readRaw(STORAGE.author) || "";
  state.authorId = state.authors.some((author) => author.id === storedAuthor) ? storedAuthor : "";
}

function isQuestionFile(data) {
  if (!data || !Array.isArray(data.areas) || data.areas.length === 0) return false;
  const ids = new Set();
  return data.areas.every((area) => {
    if (!area || typeof area.id !== "string" || !area.id || typeof area.title !== "string" || !Array.isArray(area.questions)) return false;
    if (ids.has(area.id)) return false;
    ids.add(area.id);
    return area.questions.every((question) => {
      if (!question || typeof question.id !== "string" || !question.id || typeof question.text !== "string") return false;
      if (ids.has(question.id)) return false;
      ids.add(question.id);
      return true;
    });
  });
}

function isReferenceFile(data) {
  if (!data || !Array.isArray(data.references)) return false;
  const ids = new Set();
  return data.references.every((ref) => {
    if (!ref || typeof ref.id !== "string" || !ref.id || typeof ref.areaId !== "string" || !ref.areaId) return false;
    if (typeof ref.title !== "string" || typeof ref.body !== "string") return false;
    if (ids.has(ref.id)) return false;
    ids.add(ref.id);
    return true;
  });
}

function showFatal(message) {
  document.getElementById("question-list").replaceChildren(el("p", { class: "empty", text: message }));
}

function updateAdminButton() {
  document.getElementById("admin-open").textContent = state.isAdmin ? "관리 화면" : "관리";
}

function renderAuthorSelect() {
  const select = document.getElementById("author-select");
  select.replaceChildren(
    el("option", { value: "", text: "이름을 선택하세요" }),
    ...state.authors.map((author) => el("option", { value: author.id, text: author.name }))
  );
  select.value = state.authors.some((author) => author.id === state.authorId) ? state.authorId : "";
  state.authorId = select.value;
}

function renderBoard() {
  const y = window.scrollY;
  renderTabs();
  renderQuestions();
  renderReferences();
  updateCooldownUI();
  window.scrollTo(0, y);
}

function renderTabs() {
  const current = currentArea();
  const nav = document.getElementById("area-tabs");
  nav.replaceChildren(...state.areas.map((area) => {
    return el("button", {
      type: "button",
      class: "tab",
      role: "tab",
      "aria-selected": area.id === current.id ? "true" : "false",
      "data-area": area.id
    }, [
      el("span", { text: area.title }),
      el("span", { class: "tab-count", text: answeredCount(area) + "/" + area.questions.length })
    ]);
  }));
}

function renderQuestions() {
  const area = currentArea();
  const author = currentAuthor();
  const root = document.getElementById("question-list");
  const head = el("div", { class: "section-head" }, [
    el("h2", { text: area.title }),
    area.summary ? el("p", { class: "muted", text: area.summary }) : null
  ]);
  const cards = area.questions.map((question, index) => renderQuestion(question, index, author));
  root.replaceChildren(head, ...cards);
  if (!area.questions.length) {
    root.append(el("p", { class: "empty", text: "이 영역에는 아직 질문이 없습니다." }));
  }
}

function renderQuestion(question, index, author) {
  const saved = state.answers[question.id] || {};
  const blocks = state.authors.map((person) => {
    const raw = saved[person.id];
    const entry = raw && raw.text && !raw.deleted ? raw : null;
    const text = entry ? entry.text : "아직 답변이 없습니다.";
    return el("div", { class: author && person.id === author.id ? "answer is-self" : "answer" }, [
      el("div", { class: "answer-name", text: person.name }),
      el("p", { class: entry && entry.text ? "answer-text" : "answer-text is-empty", text: text }),
      entry && entry.updatedAt ? el("time", { class: "answer-time", datetime: entry.updatedAt, text: formatTime(entry.updatedAt) }) : null
    ]);
  });

  let editor;
  if (!author) {
    editor = el("p", { class: "hint", text: "작성자를 선택하면 이 질문에 답변을 남길 수 있습니다." });
  } else {
    const draftBucket = state.drafts[question.id] || {};
    const value = Object.prototype.hasOwnProperty.call(draftBucket, author.id)
      ? draftBucket[author.id]
      : (saved[author.id] && saved[author.id].text && !saved[author.id].deleted ? saved[author.id].text : "");
    const box = el("textarea", {
      class: "textarea",
      "data-question": question.id,
      maxlength: String(LIMITS.answer),
      rows: "5",
      placeholder: author.name + "의 답변",
      autocomplete: "off"
    });
    box.value = value;
    const boxId = "answer-" + question.id;
    box.id = boxId;
    const hasSaved = Boolean(saved[author.id] && saved[author.id].text && !saved[author.id].deleted);
    editor = el("div", { class: "editor" }, [
      el("label", { class: "editor-label", for: boxId, text: author.name + " 답변 작성" }),
      box,
      el("div", { class: "editor-actions" }, [
        el("button", { type: "button", class: "btn btn-primary", "data-action": "save", "data-question": question.id, "data-guard": "cooldown", text: "답변 저장" }),
        hasSaved ? el("button", { type: "button", class: "btn btn-danger", "data-action": "delete", "data-question": question.id, "data-guard": "cooldown", text: "답변 삭제" }) : null
      ])
    ]);
  }

  return el("article", { class: "question" }, [
    el("div", { class: "q-index", text: String(index + 1).padStart(2, "0") }),
    el("div", { class: "q-body" }, [
      el("h3", { class: "q-text", text: question.text }),
      el("div", { class: "answers" }, blocks),
      editor
    ])
  ]);
}

function questionField(questionId) {
  return Array.from(document.querySelectorAll("textarea[data-question]")).find((node) => node.dataset.question === questionId) || null;
}

function requestSave(questionId) {
  if (!state.authorId) {
    toast("작성자를 먼저 선택해 주세요.");
    return;
  }
  if (honeypotFilled()) {
    toast("저장하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.");
    return;
  }
  if (!document.getElementById("captcha-modal").hidden) return;
  if (!assertCooldown()) return;
  const field = questionField(questionId);
  const text = field ? field.value.trim().slice(0, LIMITS.answer) : "";
  const prev = getAnswer(questionId, state.authorId);
  if (!text) {
    if (prev) requestDelete(questionId);
    else toast("답변을 입력해 주세요.");
    return;
  }
  if (prev && prev.text === text) {
    toast("변경된 내용이 없습니다.");
    return;
  }
  if (prev && prev.text !== text) {
    if (!window.confirm("이미 저장된 답변 전체를 수정합니다. 계속할까요?")) return;
    if (!assertCooldown()) return;
  }
  pendingSave = { questionId: questionId, authorId: state.authorId, text: text };
  openCaptcha();
}

async function requestDelete(questionId) {
  if (!state.authorId) {
    toast("작성자를 먼저 선택해 주세요.");
    return;
  }
  if (!getAnswer(questionId, state.authorId)) return;
  if (!assertCooldown()) return;
  if (!window.confirm("이 답변을 삭제합니다. 계속할까요?")) return;
  if (!assertCooldown()) return;
  const previous = structuredClone(state.answers[questionId][state.authorId]);
  state.answers[questionId][state.authorId] = {
    text: "",
    deleted: true,
    updatedAt: new Date().toISOString()
  };
  if (state.drafts[questionId]) delete state.drafts[questionId][state.authorId];
  saveBusy = true;
  try {
    await syncEntries([[questionId, state.authorId]]);
    stampCooldown();
    toast("답변을 삭제했습니다.");
  } catch (error) {
    state.answers[questionId][state.authorId] = previous;
    toast("서버에서 삭제하지 못했습니다. 다시 시도해 주세요.");
  } finally {
    saveBusy = false;
  }
  renderBoard();
}

function openCaptcha() {
  const left = 2 + Math.floor(Math.random() * 8);
  const right = 2 + Math.floor(Math.random() * 8);
  saveSum = left + right;
  document.getElementById("captcha-question").textContent = left + " + " + right + " = ?";
  const input = document.getElementById("captcha-answer");
  input.value = "";
  openModal("captcha-modal");
  input.focus();
}

function closeCaptcha() {
  pendingSave = null;
  closeModal("captcha-modal");
}

async function submitCaptcha() {
  if (saveBusy) return;
  const typed = document.getElementById("captcha-answer").value.trim();
  if (typed === "" || Number(typed) !== saveSum) {
    toast("덧셈 결과가 맞지 않습니다.");
    openCaptcha();
    return;
  }
  if (!pendingSave) return;
  if (honeypotFilled()) {
    toast("저장하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.");
    closeCaptcha();
    return;
  }
  if (!assertCooldown()) return;
  saveBusy = true;
  const questionId = pendingSave.questionId;
  const authorId = pendingSave.authorId;
  if (!state.answers[questionId]) state.answers[questionId] = {};
  const previous = state.answers[questionId][authorId] ? structuredClone(state.answers[questionId][authorId]) : null;
  state.answers[questionId][authorId] = {
    text: pendingSave.text,
    updatedAt: new Date().toISOString()
  };
  if (!state.drafts[questionId]) state.drafts[questionId] = {};
  state.drafts[questionId][authorId] = pendingSave.text;
  try {
    await syncEntries([[questionId, authorId]]);
    stampCooldown();
    pendingSave = null;
    closeModal("captcha-modal");
    toast("답변을 저장했습니다.");
    renderBoard();
  } catch (error) {
    if (previous) state.answers[questionId][authorId] = previous;
    else delete state.answers[questionId][authorId];
    toast("서버에 저장하지 못했습니다. 다시 시도해 주세요.");
    renderBoard();
  } finally {
    saveBusy = false;
  }
}

function selectedRefs() {
  const area = currentArea();
  return state.references.filter((ref) => ref.areaId === area.id && state.selected[ref.id]);
}

function updateRefButton() {
  const button = document.getElementById("open-refs");
  const note = document.getElementById("ref-count");
  if (!button) return;
  const count = selectedRefs().length;
  button.disabled = count === 0;
  button.textContent = count ? "선택 내용 보기 (" + count + ")" : "선택 내용 보기";
  if (note) note.textContent = count ? count + "개 선택됨" : "확인할 참조를 체크하세요.";
}

function renderReferences() {
  const area = currentArea();
  const refs = state.references.filter((item) => item.areaId === area.id);
  const root = document.getElementById("reference-panel");
  const items = refs.map((ref) => {
    const id = "ref-check-" + ref.id;
    const input = el("input", { type: "checkbox", id: id, value: ref.id });
    input.checked = Boolean(state.selected[ref.id]);
    input.addEventListener("change", () => {
      if (input.checked) state.selected[ref.id] = true;
      else delete state.selected[ref.id];
      updateRefButton();
    });
    return el("label", { class: "ref-item", for: id }, [input, el("span", { text: ref.title })]);
  });
  const button = el("button", { type: "button", class: "btn btn-primary", id: "open-refs", text: "선택 내용 보기" });
  button.addEventListener("click", openReferenceModal);
  root.replaceChildren(el("div", { class: "panel" }, [
    el("p", { class: "eyebrow", text: "참조" }),
    el("h2", { text: "이 영역의 자료" }),
    refs.length ? el("div", { class: "ref-list" }, items) : el("p", { class: "empty", text: "등록된 참조가 없습니다." }),
    button,
    el("p", { class: "hint", id: "ref-count", text: "" })
  ]));
  updateRefButton();
}

function openReferenceModal() {
  const refs = selectedRefs();
  if (!refs.length) {
    toast("참조를 하나 이상 체크해 주세요.");
    return;
  }
  document.getElementById("ref-modal-title").textContent = "선택한 자료 " + refs.length + "개";
  document.getElementById("ref-modal-body").replaceChildren(...refs.map((ref) => {
    return el("article", { class: "ref-article" }, [
      el("h3", { text: ref.title }),
      el("p", { text: ref.body })
    ]);
  }));
  openModal("ref-modal");
  document.getElementById("ref-modal-close").focus();
}

function openModal(id) {
  lastFocus = document.activeElement;
  document.getElementById(id).hidden = false;
  document.body.classList.add("modal-open");
}

function closeModal(id) {
  document.getElementById(id).hidden = true;
  const adminOpen = !document.getElementById("admin").hidden;
  const anyModal = Array.from(document.querySelectorAll(".modal")).some((node) => !node.hidden);
  if (!adminOpen && !anyModal) document.body.classList.remove("modal-open");
  if (lastFocus && typeof lastFocus.focus === "function") {
    lastFocus.focus();
    lastFocus = null;
  }
}

function fillLoginCaptcha() {
  const left = 2 + Math.floor(Math.random() * 8);
  const right = 2 + Math.floor(Math.random() * 8);
  loginSum = left + right;
  document.getElementById("login-captcha-label").textContent = left + " + " + right;
}

function openLogin() {
  document.getElementById("login-form").reset();
  fillLoginCaptcha();
  openModal("login-modal");
  document.getElementById("login-id").focus();
  const lockLeft = loginLockRemaining();
  if (lockLeft > 0) toast("로그인이 잠시 잠겼습니다. " + Math.ceil(lockLeft / 1000) + "초 후에 다시 시도해 주세요.");
}

async function submitLogin(event) {
  event.preventDefault();
  if (loginBusy) return;
  const lockLeft = loginLockRemaining();
  if (lockLeft > 0) {
    toast("로그인이 잠시 잠겼습니다. " + Math.ceil(lockLeft / 1000) + "초 후에 다시 시도해 주세요.");
    return;
  }
  if (honeypotFilled()) {
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
    const ok = id === ADMIN_ID && safeEqual(hash, ADMIN_PASSWORD_SHA256) && captchaOk;
    if (!ok) {
      registerLoginFailure();
      document.getElementById("login-password").value = "";
      fillLoginCaptcha();
      document.getElementById("login-captcha").value = "";
      toast("아이디, 비밀번호 또는 덧셈 결과를 다시 확인해 주세요.");
      return;
    }
    try { sessionStorage.removeItem(LOGIN_LOCK_KEY); } catch (error) { /* ignore */ }
    await issueSession();
    state.isAdmin = true;
    document.getElementById("login-password").value = "";
    closeModal("login-modal");
    updateAdminButton();
    openAdmin();
  } catch (error) {
    toast("이 페이지는 https 또는 localhost에서 열어 주세요.");
  } finally {
    loginBusy = false;
  }
}

function openAdmin() {
  state.adminAreaId = state.adminAreaId || state.areaId;
  state.adminTab = state.adminTab || "questions";
  document.getElementById("admin").hidden = false;
  document.body.classList.add("modal-open");
  renderAdmin();
}

function closeAdmin() {
  document.getElementById("admin").hidden = true;
  const anyModal = Array.from(document.querySelectorAll(".modal")).some((node) => !node.hidden);
  if (!anyModal) document.body.classList.remove("modal-open");
  renderBoard();
}

function logout() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch (error) { /* ignore */ }
  state.isAdmin = false;
  updateAdminButton();
  closeAdmin();
  toast("관리 모드를 종료했습니다.");
}

async function requireAdmin() {
  const ok = await readSession();
  state.isAdmin = ok;
  updateAdminButton();
  if (!ok) {
    toast("관리자 세션이 없습니다.");
    closeAdmin();
    return false;
  }
  return true;
}

function renderAdmin() {
  const root = document.getElementById("admin-root");
  const area = currentAdminArea();
  const usingDraft = Boolean(readStore(STORAGE.content));
  const areaSelect = el("select", { id: "admin-area" }, state.areas.map((item) => {
    return el("option", { value: item.id, text: item.title });
  }));
  areaSelect.value = area.id;
  const tools = el("div", { class: "admin-tools stack" }, [
    el("div", { class: "row" }, [
      el("button", { type: "button", class: "btn btn-ghost", "data-action": "export-questions", text: "질문 파일 내려받기" }),
      el("button", { type: "button", class: "btn btn-ghost", "data-action": "export-references", text: "참조 파일 내려받기" }),
      el("button", { type: "button", class: "btn btn-ghost", "data-action": "pick-questions", text: "질문 파일 불러오기" }),
      el("button", { type: "button", class: "btn btn-ghost", "data-action": "pick-references", text: "참조 파일 불러오기" }),
      el("button", { type: "button", class: "btn btn-danger", "data-action": "reset-files", "data-guard": "cooldown", text: "파일 내용으로 되돌리기" })
    ]),
    el("input", { id: "import-questions-file", type: "file", accept: "application/json,.json", hidden: true }),
    el("input", { id: "import-references-file", type: "file", accept: "application/json,.json", hidden: true }),
    el("p", {
      class: "hint",
      text: usingDraft
        ? "이 브라우저에 질문·참조 수정본이 있습니다. 모두에게 반영하려면 파일을 내려받아 data 폴더에 넣으세요."
        : "질문과 참조는 data 폴더의 JSON이 기준입니다. 여기서 고치면 이 브라우저에 먼저 저장됩니다."
    }),
    el("p", { class: "hint", text: "데이터 revision " + state.files.revision })
  ]);
  const switcher = el("div", { class: "row" }, [
    el("button", {
      type: "button",
      class: state.adminTab === "questions" ? "btn btn-primary" : "btn btn-ghost",
      "data-action": "show-questions",
      text: "질문"
    }),
    el("button", {
      type: "button",
      class: state.adminTab === "references" ? "btn btn-primary" : "btn btn-ghost",
      "data-action": "show-references",
      text: "참조"
    })
  ]);
  const panel = state.adminTab === "references" ? renderAdminReferences(area) : renderAdminQuestions(area);
  root.replaceChildren(tools, el("label", { class: "field" }, ["다룰 영역", areaSelect]), switcher, panel);
  updateCooldownUI();
}

function renderAdminQuestions(area) {
  const title = el("input", { name: "title", maxlength: String(LIMITS.areaTitle), required: true });
  title.value = area.title;
  const summary = el("textarea", { name: "summary", rows: "2", maxlength: String(LIMITS.areaSummary) });
  summary.value = area.summary || "";
  const areaForm = el("form", { class: "admin-card stack", "data-action": "save-area", "data-id": area.id }, [
    el("h3", { text: "영역 이름" }),
    el("label", { class: "field" }, ["이름", title]),
    el("label", { class: "field" }, ["설명", summary]),
    el("button", { type: "submit", class: "btn btn-primary", "data-guard": "cooldown", text: "영역 정보 저장" })
  ]);
  const cards = area.questions.map((question, index) => {
    const text = el("textarea", { name: "text", rows: "3", maxlength: String(LIMITS.question), required: true });
    text.value = question.text;
    const select = el("select", { name: "areaId" }, state.areas.map((item) => el("option", { value: item.id, text: item.title })));
    select.value = area.id;
    return el("form", { class: "admin-card stack", "data-action": "save-question", "data-id": question.id }, [
      el("h3", { text: "질문 " + (index + 1) }),
      el("label", { class: "field" }, ["내용", text]),
      el("label", { class: "field" }, ["영역", select]),
      el("div", { class: "row" }, [
        el("button", { type: "submit", class: "btn btn-primary", "data-guard": "cooldown", text: "수정 저장" }),
        el("button", { type: "button", class: "btn btn-danger", "data-action": "delete-question", "data-id": question.id, "data-guard": "cooldown", text: "삭제" })
      ])
    ]);
  });
  const addText = el("textarea", { name: "text", rows: "3", maxlength: String(LIMITS.question), required: true });
  const addForm = el("form", { class: "admin-card stack", "data-action": "add-question" }, [
    el("h3", { text: "질문 추가" }),
    el("label", { class: "field" }, ["내용", addText]),
    el("button", { type: "submit", class: "btn btn-primary", "data-guard": "cooldown", text: "이 영역에 추가" })
  ]);
  return el("div", { class: "stack" }, [areaForm, ...cards, addForm]);
}

function renderAdminReferences(area) {
  const refs = state.references.filter((ref) => ref.areaId === area.id);
  const cards = refs.map((ref) => {
    const title = el("input", { name: "title", maxlength: String(LIMITS.refTitle), required: true });
    title.value = ref.title;
    const body = el("textarea", { name: "body", rows: "6", maxlength: String(LIMITS.refBody), required: true });
    body.value = ref.body;
    const select = el("select", { name: "areaId" }, state.areas.map((item) => el("option", { value: item.id, text: item.title })));
    select.value = ref.areaId;
    return el("form", { class: "admin-card stack", "data-action": "save-reference", "data-id": ref.id }, [
      el("h3", { text: ref.title }),
      el("label", { class: "field" }, ["제목", title]),
      el("label", { class: "field" }, ["영역", select]),
      el("label", { class: "field" }, ["내용", body]),
      el("div", { class: "row" }, [
        el("button", { type: "submit", class: "btn btn-primary", "data-guard": "cooldown", text: "수정 저장" }),
        el("button", { type: "button", class: "btn btn-danger", "data-action": "delete-reference", "data-id": ref.id, "data-guard": "cooldown", text: "삭제" })
      ])
    ]);
  });
  const addTitle = el("input", { name: "title", maxlength: String(LIMITS.refTitle), required: true });
  const addBody = el("textarea", { name: "body", rows: "5", maxlength: String(LIMITS.refBody), required: true });
  const addSelect = el("select", { name: "areaId" }, state.areas.map((item) => el("option", { value: item.id, text: item.title })));
  addSelect.value = area.id;
  const addForm = el("form", { class: "admin-card stack", "data-action": "add-reference" }, [
    el("h3", { text: "참조 추가" }),
    el("label", { class: "field" }, ["제목", addTitle]),
    el("label", { class: "field" }, ["영역", addSelect]),
    el("label", { class: "field" }, ["내용", addBody]),
    el("button", { type: "submit", class: "btn btn-primary", "data-guard": "cooldown", text: "참조 추가" })
  ]);
  return el("div", { class: "stack" }, [
    refs.length ? null : el("p", { class: "empty", text: "이 영역에는 참조가 없습니다." }),
    ...cards,
    addForm
  ]);
}

async function saveArea(form) {
  if (!(await requireAdmin())) return;
  const area = state.areas.find((item) => item.id === form.dataset.id);
  if (!area) return;
  const data = new FormData(form);
  const title = String(data.get("title") || "").trim().slice(0, LIMITS.areaTitle);
  const summary = String(data.get("summary") || "").trim().slice(0, LIMITS.areaSummary);
  if (!title) {
    toast("영역 이름을 입력해 주세요.");
    return;
  }
  if (title === area.title && summary === (area.summary || "")) {
    toast("변경된 내용이 없습니다.");
    return;
  }
  if (!window.confirm("영역 정보를 수정합니다. 계속할까요?")) return;
  if (!assertCooldown()) return;
  area.title = title;
  area.summary = summary;
  persistContent();
  stampCooldown();
  toast("영역 정보를 수정했습니다.");
  renderAdmin();
  renderBoard();
}

async function saveQuestion(form) {
  if (!(await requireAdmin())) return;
  const found = findQuestion(form.dataset.id);
  if (!found) return;
  const data = new FormData(form);
  const text = String(data.get("text") || "").trim().slice(0, LIMITS.question);
  const areaId = String(data.get("areaId") || found.area.id);
  if (!text) {
    toast("질문 내용을 입력해 주세요.");
    return;
  }
  if (!state.areas.some((area) => area.id === areaId)) {
    toast("영역을 다시 선택해 주세요.");
    return;
  }
  if (text === found.question.text && areaId === found.area.id) {
    toast("변경된 내용이 없습니다.");
    return;
  }
  if (!window.confirm("질문 전체를 수정합니다. 계속할까요?")) return;
  if (!assertCooldown()) return;
  found.question.text = text;
  if (areaId !== found.area.id) {
    found.area.questions = found.area.questions.filter((item) => item.id !== found.question.id);
    const next = state.areas.find((area) => area.id === areaId);
    next.questions.push(found.question);
    state.adminAreaId = areaId;
  }
  persistContent();
  stampCooldown();
  toast("질문을 수정했습니다.");
  renderAdmin();
  renderBoard();
}

async function addQuestion(form) {
  if (!(await requireAdmin())) return;
  const text = String(new FormData(form).get("text") || "").trim().slice(0, LIMITS.question);
  if (!text) {
    toast("질문 내용을 입력해 주세요.");
    return;
  }
  if (!assertCooldown()) return;
  currentAdminArea().questions.push({ id: uid("q"), text: text });
  persistContent();
  stampCooldown();
  toast("질문을 추가했습니다.");
  renderAdmin();
  renderBoard();
}

async function deleteQuestion(id) {
  if (!(await requireAdmin())) return;
  if (!window.confirm("이 질문을 삭제합니다. 연결된 답변도 함께 지워집니다. 계속할까요?")) return;
  if (!assertCooldown()) return;
  state.areas.forEach((area) => {
    area.questions = area.questions.filter((item) => item.id !== id);
  });
  const bucket = state.answers[id] || {};
  const removed = Object.keys(bucket);
  const stamp = new Date().toISOString();
  removed.forEach((authorId) => {
    bucket[authorId] = { text: "", deleted: true, updatedAt: stamp };
  });
  let answersRemoved = true;
  if (removed.length) {
    try {
      await syncEntries(removed.map((authorId) => [id, authorId]));
    } catch (error) {
      answersRemoved = false;
    }
  }
  persistContent();
  stampCooldown();
  toast(answersRemoved ? "질문을 삭제했습니다." : "질문은 지웠지만 서버의 답변은 남았습니다. 다시 시도해 주세요.");
  renderAdmin();
  renderBoard();
}

async function saveReference(form) {
  if (!(await requireAdmin())) return;
  const ref = state.references.find((item) => item.id === form.dataset.id);
  if (!ref) return;
  const data = new FormData(form);
  const title = String(data.get("title") || "").trim().slice(0, LIMITS.refTitle);
  const body = String(data.get("body") || "").trim().slice(0, LIMITS.refBody);
  const areaId = String(data.get("areaId") || ref.areaId);
  if (!title || !body) {
    toast("제목과 내용을 입력해 주세요.");
    return;
  }
  if (!state.areas.some((area) => area.id === areaId)) {
    toast("영역을 다시 선택해 주세요.");
    return;
  }
  if (title === ref.title && body === ref.body && areaId === ref.areaId) {
    toast("변경된 내용이 없습니다.");
    return;
  }
  if (!window.confirm("이 참조 전체를 수정합니다. 계속할까요?")) return;
  if (!assertCooldown()) return;
  ref.title = title;
  ref.body = body;
  ref.areaId = areaId;
  if (areaId !== state.adminAreaId) state.adminAreaId = areaId;
  persistContent();
  stampCooldown();
  toast("참조를 수정했습니다.");
  renderAdmin();
  renderBoard();
}

async function addReference(form) {
  if (!(await requireAdmin())) return;
  const data = new FormData(form);
  const title = String(data.get("title") || "").trim().slice(0, LIMITS.refTitle);
  const body = String(data.get("body") || "").trim().slice(0, LIMITS.refBody);
  const areaId = String(data.get("areaId") || currentAdminArea().id);
  if (!title || !body) {
    toast("참조 제목과 내용을 입력해 주세요.");
    return;
  }
  if (!state.areas.some((area) => area.id === areaId)) {
    toast("영역을 다시 선택해 주세요.");
    return;
  }
  if (!assertCooldown()) return;
  state.references.push({ id: uid("ref"), areaId: areaId, title: title, body: body });
  persistContent();
  stampCooldown();
  toast("참조를 추가했습니다.");
  renderAdmin();
  renderBoard();
}

async function deleteReference(id) {
  if (!(await requireAdmin())) return;
  if (!window.confirm("이 참조를 삭제합니다. 계속할까요?")) return;
  if (!assertCooldown()) return;
  state.references = state.references.filter((item) => item.id !== id);
  delete state.selected[id];
  persistContent();
  stampCooldown();
  toast("참조를 삭제했습니다.");
  renderAdmin();
  renderBoard();
}

async function resetToFiles() {
  if (!(await requireAdmin())) return;
  if (!window.confirm("이 브라우저의 질문·참조 수정본을 지우고 파일 내용으로 되돌립니다. 계속할까요?")) return;
  if (!assertCooldown()) return;
  state.areas = structuredClone(state.files.areas);
  state.references = structuredClone(state.files.references);
  try { localStorage.removeItem(STORAGE.content); } catch (error) { /* ignore */ }
  state.areaId = state.areas[0].id;
  state.adminAreaId = state.areaId;
  stampCooldown();
  toast("파일 내용으로 되돌렸습니다.");
  renderAdmin();
  renderBoard();
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function readJsonFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try { resolve(JSON.parse(String(reader.result))); }
      catch (error) { reject(error); }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file, "utf-8");
  });
}

async function importQuestionFile(file) {
  if (!(await requireAdmin())) return;
  if (!file) return;
  if (file.size > 2000000) {
    toast("파일이 너무 큽니다.");
    return;
  }
  if (!window.confirm("질문 파일로 영역과 질문을 통째로 바꿉니다. 계속할까요?")) return;
  if (!assertCooldown()) return;
  try {
    const data = await readJsonFile(file);
    if (!isQuestionFile(data)) {
      toast("questions.json 형식이 아닙니다.");
      return;
    }
    state.areas = data.areas;
    if (Number.isFinite(Number(data.revision))) {
      state.files.revision = Math.max(state.files.revision, Number(data.revision));
    }
    if (!state.areas.some((area) => area.id === state.areaId)) state.areaId = state.areas[0].id;
    state.adminAreaId = currentAdminArea() ? currentAdminArea().id : state.areaId;
    if (!state.areas.some((area) => area.id === state.adminAreaId)) state.adminAreaId = state.areas[0].id;
    persistContent();
    stampCooldown();
    toast("질문 데이터를 반영했습니다.");
    renderAdmin();
    renderBoard();
  } catch (error) {
    toast("질문 파일을 읽지 못했습니다.");
  }
}

async function importReferenceFile(file) {
  if (!(await requireAdmin())) return;
  if (!file) return;
  if (file.size > 2000000) {
    toast("파일이 너무 큽니다.");
    return;
  }
  if (!window.confirm("참조 파일로 참조 글 전체를 바꿉니다. 계속할까요?")) return;
  if (!assertCooldown()) return;
  try {
    const data = await readJsonFile(file);
    if (!isReferenceFile(data)) {
      toast("references.json 형식이 아닙니다.");
      return;
    }
    state.references = data.references;
    if (Number.isFinite(Number(data.revision))) {
      state.files.revision = Math.max(state.files.revision, Number(data.revision));
    }
    persistContent();
    stampCooldown();
    toast("참조 데이터를 반영했습니다.");
    renderAdmin();
    renderBoard();
  } catch (error) {
    toast("참조 파일을 읽지 못했습니다.");
  }
}

async function importAnswers(file) {
  if (!file) return;
  if (file.size > 2000000) {
    toast("파일이 너무 큽니다.");
    return;
  }
  if (!window.confirm("답변 파일을 서버의 답변과 합칩니다. 더 최근 시각의 답변을 남깁니다. 계속할까요?")) return;
  try {
    const data = await readJsonFile(file);
    if (!data || typeof data.answers !== "object" || data.answers == null || Array.isArray(data.answers)) {
      toast("answers.json 형식이 아닙니다.");
      return;
    }
    state.answers = mergeAnswers(state.answers, data.answers);
    const pairs = [];
    Object.keys(state.answers).forEach((questionId) => {
      Object.keys(state.answers[questionId] || {}).forEach((authorId) => {
        if (normalizeEntry(state.answers[questionId][authorId])) pairs.push([questionId, authorId]);
      });
    });
    saveBusy = true;
    await syncEntries(pairs);
    toast("답변 파일을 서버에 반영했습니다.");
    renderBoard();
  } catch (error) {
    toast(error && error.message && error.message.indexOf("형식") >= 0 ? error.message : "답변 파일을 서버에 반영하지 못했습니다.");
  } finally {
    saveBusy = false;
  }
}

async function onAdminClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "show-questions") {
    state.adminTab = "questions";
    renderAdmin();
    return;
  }
  if (action === "show-references") {
    state.adminTab = "references";
    renderAdmin();
    return;
  }
  if (action === "export-questions") {
    downloadJson("questions.json", { revision: state.files.revision, areas: state.areas });
    return;
  }
  if (action === "export-references") {
    downloadJson("references.json", { revision: state.files.revision, references: state.references });
    return;
  }
  if (action === "pick-questions") {
    const input = document.getElementById("import-questions-file");
    if (input) input.click();
    return;
  }
  if (action === "pick-references") {
    const input = document.getElementById("import-references-file");
    if (input) input.click();
    return;
  }
  if (action === "reset-files") {
    await resetToFiles();
    return;
  }
  if (action === "delete-question") await deleteQuestion(button.dataset.id);
  if (action === "delete-reference") await deleteReference(button.dataset.id);
}

async function onAdminSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  const action = form.dataset.action;
  if (action === "save-area") await saveArea(form);
  else if (action === "save-question") await saveQuestion(form);
  else if (action === "add-question") await addQuestion(form);
  else if (action === "save-reference") await saveReference(form);
  else if (action === "add-reference") await addReference(form);
}

async function onAdminChange(event) {
  const target = event.target;
  if (target.id === "admin-area") {
    state.adminAreaId = target.value;
    renderAdmin();
    return;
  }
  if (target.id === "import-questions-file" && target.files && target.files[0]) {
    const file = target.files[0];
    target.value = "";
    await importQuestionFile(file);
  }
  if (target.id === "import-references-file" && target.files && target.files[0]) {
    const file = target.files[0];
    target.value = "";
    await importReferenceFile(file);
  }
}

function bindEvents() {
  document.getElementById("author-select").addEventListener("change", () => {
    state.authorId = document.getElementById("author-select").value;
    try {
      if (state.authorId) localStorage.setItem(STORAGE.author, state.authorId);
      else localStorage.removeItem(STORAGE.author);
    } catch (error) { /* ignore */ }
    renderBoard();
  });

  document.getElementById("area-tabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-area]");
    if (!tab) return;
    state.areaId = tab.dataset.area;
    renderBoard();
  });

  document.getElementById("question-list").addEventListener("input", (event) => {
    const box = event.target;
    if (!box.matches || !box.matches("textarea[data-question]") || !state.authorId) return;
    if (!state.drafts[box.dataset.question]) state.drafts[box.dataset.question] = {};
    state.drafts[box.dataset.question][state.authorId] = box.value;
  });

  document.getElementById("question-list").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    if (button.dataset.action === "save") requestSave(button.dataset.question);
    if (button.dataset.action === "delete") requestDelete(button.dataset.question);
  });

  document.getElementById("admin-open").addEventListener("click", async () => {
    if (await readSession()) {
      state.isAdmin = true;
      updateAdminButton();
      openAdmin();
      return;
    }
    state.isAdmin = false;
    updateAdminButton();
    openLogin();
  });

  document.getElementById("login-form").addEventListener("submit", submitLogin);
  document.getElementById("login-cancel").addEventListener("click", () => closeModal("login-modal"));
  document.getElementById("captcha-cancel").addEventListener("click", closeCaptcha);
  document.getElementById("captcha-submit").addEventListener("click", submitCaptcha);
  document.getElementById("captcha-answer").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitCaptcha();
    }
  });
  document.getElementById("ref-modal-close").addEventListener("click", () => closeModal("ref-modal"));
  document.getElementById("admin-close").addEventListener("click", closeAdmin);
  document.getElementById("admin-logout").addEventListener("click", logout);

  document.querySelectorAll(".modal").forEach((modal) => {
    modal.addEventListener("click", (event) => {
      if (event.target !== modal) return;
      if (modal.id === "captcha-modal") closeCaptcha();
      else closeModal(modal.id);
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!document.getElementById("captcha-modal").hidden) closeCaptcha();
    else if (!document.getElementById("login-modal").hidden) closeModal("login-modal");
    else if (!document.getElementById("ref-modal").hidden) closeModal("ref-modal");
  });

  document.getElementById("export-answers").addEventListener("click", () => {
    downloadJson("answers.json", { answers: exportableAnswers() });
  });
  document.getElementById("import-answers").addEventListener("click", () => {
    document.getElementById("import-answers-file").click();
  });
  document.getElementById("import-answers-file").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (file) await importAnswers(file);
  });

  const adminRoot = document.getElementById("admin-root");
  adminRoot.addEventListener("click", onAdminClick);
  adminRoot.addEventListener("submit", onAdminSubmit);
  adminRoot.addEventListener("change", onAdminChange);
}

async function init() {
  bindEvents();
  try {
    await loadData();
    state.isAdmin = await readSession();
    renderAuthorSelect();
    renderBoard();
    updateAdminButton();
    updateCooldownUI();
    window.setInterval(updateCooldownUI, 500);
    window.setInterval(refreshAnswers, 20000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshAnswers();
    });
  } catch (error) {
    showFatal(error && error.message ? error.message : "데이터를 불러오지 못했습니다.");
  }
}

init();
