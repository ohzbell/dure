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
  authors: "dure.authors.v1",
  cooldown: "dure.cooldown.v1"
};
const SESSION_KEY = "dure.admin.session.v1";
const AI_VISIBLE_KEY = "dure.admin.aiVisible.v1";
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
  areaId: "",
  adminAreaId: "",
  adminTab: "questions",
  authorId: "",
  isAdmin: false,
  showAiAnswers: true,
  authorsUpdatedAt: "",
  authorsStamp: "",
  files: { revision: 1, areas: [], references: [] },
  cooldownUntil: 0
};

let lastFocus = null;
let toastTimer = 0;
let loginSum = 0;
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

function setSaveStatus(text) {
  const node = document.getElementById("answer-save-state");
  if (!node) return;
  node.textContent = text || "";
}

function setSyncNote(text) {
  const note = document.getElementById("sync-note");
  if (!note) return;
  note.hidden = !text;
  note.textContent = text || "";
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
let syncing = false;
let catalogMemo = {};
let catalogStamps = {};
let catalogsReady = false;
let remoteReady = false;
let autosaveTimer = 0;
let saveAgain = false;

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
  const size = budget;
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

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const count = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: count }, run));
  return results;
}

async function writeBlob(baseName, value) {
  const sample = baseName + "0";
  const parts = encodeChunks(value, valueBudget(sample));
  await mapLimit(parts, 6, (part, index) => kvPut(baseName + index, part));
  await kvPut(baseName + "n", String(parts.length));
}

async function readBlob(baseName) {
  const count = Number(await kvRead(baseName + "n")) || 0;
  if (!count) return null;
  const parts = await mapLimit(
    Array.from({ length: count }, (value, index) => index),
    6,
    (index) => kvRead(baseName + index)
  );
  if (parts.some((part) => !part)) return null;
  return JSON.parse(decodeB64Url(parts.join("")));
}

function payloadToEntry(payload) {
  if (!payload || typeof payload.u !== "string") return null;
  if (payload.d === true) return { text: "", deleted: true, updatedAt: payload.u };
  if (typeof payload.t !== "string") return null;
  return normalizeEntry({ text: payload.t, updatedAt: payload.u });
}

async function readEntry(questionId, authorId) {
  return payloadToEntry(await readBlob(pairName(questionId, authorId, "p")));
}

async function readIndex() {
  const payload = await readBlob("i");
  if (!Array.isArray(payload)) return [];
  return payload.filter((pair) => Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string");
}

function catalogBase(authorId) {
  return "c_" + String(authorId).replace(/[^A-Za-z0-9-]/g, "");
}

function catalogStampKey(authorId) {
  return "cs_" + String(authorId).replace(/[^A-Za-z0-9-]/g, "");
}

function canPublish(authorId) {
  if (!authorId || authorId === "author-ai") return false;
  const author = state.authors.find((item) => item.id === authorId);
  return !author || author.locked !== true;
}

function cleanCatalogItems(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => item && typeof item.q === "string" && typeof item.u === "string");
}

async function readAuthorCatalog(authorId) {
  const doc = await readBlob(catalogBase(authorId));
  if (!doc || !Array.isArray(doc.items)) return [];
  return cleanCatalogItems(doc.items);
}

async function readBody(questionId, authorId, chunks) {
  const count = Number(chunks) || 0;
  if (!count) return null;
  const base = pairName(questionId, authorId, "p");
  const parts = await mapLimit(
    Array.from({ length: count }, (value, index) => index),
    6,
    (index) => kvRead(base + index)
  );
  if (parts.some((part) => !part)) return null;
  return JSON.parse(decodeB64Url(parts.join("")));
}

async function writeBody(questionId, authorId, entry) {
  const payload = entry.deleted
    ? { d: true, u: entry.updatedAt }
    : { t: entry.text, u: entry.updatedAt };
  const base = pairName(questionId, authorId, "p");
  const parts = encodeChunks(payload, valueBudget(base + "0"));
  await mapLimit(parts, 6, (part, index) => kvPut(base + index, part));
  return parts.length;
}

function takeRemoteEntry(questionId, authorId, entry) {
  if (!entry) return false;
  const bucket = state.answers[questionId] && state.answers[questionId][authorId];
  if (bucket && String(bucket.updatedAt || "") >= String(entry.updatedAt)) return false;
  if (!state.answers[questionId]) state.answers[questionId] = {};
  state.answers[questionId][authorId] = entry;
  return true;
}

async function updateAuthorCatalog(authorId, item) {
  const base = catalogBase(authorId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = catalogMemo[authorId] || await readAuthorCatalog(authorId);
    const map = new Map();
    current.forEach((entry) => map.set(entry.q, entry));
    const prev = map.get(item.q);
    if (prev && String(prev.u) > String(item.u)) return { remote: prev };
    if (prev && prev.u === item.u && prev.n === item.n && prev.d === item.d) {
      catalogMemo[authorId] = current;
      return { ok: true };
    }
    map.set(item.q, item);
    const items = Array.from(map.values());
    const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await writeBlob(base, { token: token, items: items });
    await kvPut(catalogStampKey(authorId), token);
    catalogMemo[authorId] = items;
    catalogStamps[authorId] = token;
    return { ok: true };
  }
  throw new Error("답변 목록을 서버에 반영하지 못했습니다.");
}

async function publishEntry(questionId, authorId, entry) {
  const item = entry.deleted
    ? { q: questionId, u: entry.updatedAt, d: 1 }
    : { q: questionId, u: entry.updatedAt, n: await writeBody(questionId, authorId, entry) };
  const result = await updateAuthorCatalog(authorId, item);
  if (result && result.remote) await adoptRemote(questionId, authorId, result.remote, entry);
}

async function adoptRemote(questionId, authorId, remoteItem, attempted) {
  const entry = remoteItem.d
    ? { text: "", deleted: true, updatedAt: remoteItem.u }
    : payloadToEntry(await readBody(questionId, authorId, remoteItem.n || 1));
  if (!entry) return;
  const box = document.getElementById("answer-modal-text");
  const editing = box
    && document.getElementById("answer-modal").hidden === false
    && box.dataset.question === questionId
    && state.authorId === authorId;
  if (editing && box.value.trim() !== (attempted.deleted ? "" : attempted.text)) return;
  takeRemoteEntry(questionId, authorId, entry);
  cacheAnswers();
  if (editing) {
    box.value = entry.deleted ? "" : entry.text;
    setSaveStatus("다른 곳에서 저장된 내용으로 맞췄습니다.");
  }
  if (!editing) renderBoard();
}

const authorQueues = new Map();

function enqueueAuthor(authorId, job) {
  const prev = authorQueues.get(authorId) || Promise.resolve();
  const next = prev.then(job, job);
  authorQueues.set(authorId, next);
  return next;
}

async function syncEntries(pairs) {
  for (let index = 0; index < pairs.length; index += 1) {
    const questionId = pairs[index][0];
    const authorId = pairs[index][1];
    if (!canPublish(authorId)) continue;
    const entry = normalizeEntry(state.answers[questionId] && state.answers[questionId][authorId]);
    if (!entry) continue;
    await enqueueAuthor(authorId, () => publishEntry(questionId, authorId, entry));
  }
  cacheAnswers();
}

async function ensureCatalogs() {
  if (catalogsReady) return;
  const indexStamp = await kvRead("iu");
  if (!indexStamp) {
    catalogsReady = true;
    return;
  }
  const migrated = await kvRead("cm");
  if (migrated === indexStamp) {
    catalogsReady = true;
    return;
  }
  const pairs = await readIndex();
  const grouped = {};
  pairs.forEach((pair) => {
    if (!canPublish(pair[1])) return;
    if (!grouped[pair[1]]) grouped[pair[1]] = [];
    grouped[pair[1]].push(pair[0]);
  });
  const authorIds = Object.keys(grouped);
  for (let index = 0; index < authorIds.length; index += 1) {
    const authorId = authorIds[index];
    const existing = await readAuthorCatalog(authorId);
    const seen = new Set(existing.map((item) => item.q));
    const items = existing.slice();
    for (let cursor = 0; cursor < grouped[authorId].length; cursor += 1) {
      const questionId = grouped[authorId][cursor];
      if (seen.has(questionId)) continue;
      const entry = await readEntry(questionId, authorId);
      if (!entry) continue;
      const chunks = Number(await kvRead(pairName(questionId, authorId, "pn"))) || 1;
      items.push(entry.deleted
        ? { q: questionId, u: entry.updatedAt, d: 1 }
        : { q: questionId, u: entry.updatedAt, n: chunks });
      seen.add(questionId);
    }
    if (items.length !== existing.length) {
      const token = "m" + Date.now().toString(36);
      await writeBlob(catalogBase(authorId), { token: token, items: items });
      await kvPut(catalogStampKey(authorId), token);
      catalogMemo[authorId] = items;
      catalogStamps[authorId] = token;
    }
  }
  await kvPut("cm", indexStamp);
  catalogsReady = true;
}

async function pullAuthor(authorId) {
  const stamp = await kvRead(catalogStampKey(authorId));
  if (stamp === catalogStamps[authorId] && Array.isArray(catalogMemo[authorId])) return false;
  const items = await readAuthorCatalog(authorId);
  catalogMemo[authorId] = items;
  catalogStamps[authorId] = stamp;
  let changed = false;
  const jobs = [];
  items.forEach((item) => {
    const local = state.answers[item.q] && state.answers[item.q][authorId];
    if (local && String(local.updatedAt || "") >= String(item.u)) return;
    if (item.d) {
      if (takeRemoteEntry(item.q, authorId, { text: "", deleted: true, updatedAt: item.u })) changed = true;
      return;
    }
    jobs.push(async () => {
      const entry = payloadToEntry(await readBody(item.q, authorId, item.n || 1));
      return takeRemoteEntry(item.q, authorId, entry);
    });
  });
  const found = await mapLimit(jobs, 6, (job) => job());
  return changed || found.some(Boolean);
}

async function healAuthor(authorId) {
  const items = catalogMemo[authorId] || [];
  const known = new Map(items.map((item) => [item.q, item]));
  const bucketIds = Object.keys(state.answers);
  for (let index = 0; index < bucketIds.length; index += 1) {
    const questionId = bucketIds[index];
    const entry = normalizeEntry(state.answers[questionId] && state.answers[questionId][authorId]);
    if (!entry || !canPublish(authorId)) continue;
    const remote = known.get(questionId);
    if (remote && String(remote.u) >= String(entry.updatedAt)) continue;
    await publishEntry(questionId, authorId, entry);
  }
}

async function syncRemote() {
  if (syncing || saveBusy || !answerStore.appKey) return;
  syncing = true;
  if (!remoteReady) setSyncNote("답변을 불러오는 중");
  try {
    try {
      const remoteAuthors = await readAuthorsRemote();
      const authorStamp = await kvRead("aut");
      state.authorsStamp = authorStamp;
      if (remoteAuthors && remoteAuthors.updatedAt !== state.authorsUpdatedAt) {
        applyAuthors(remoteAuthors.authors, remoteAuthors.updatedAt);
        renderAuthorSelect();
      }
    } catch (error) {
      const cached = readStore(STORAGE.authors);
      const cachedAuthors = cached && normalizeAuthors(cached.authors);
      if (cachedAuthors) applyAuthors(cachedAuthors, cached.updatedAt || "");
    }
    await ensureCatalogs();
    const writers = state.authors.filter((author) => canPublish(author.id));
    const pulled = await mapLimit(writers, 4, (author) => pullAuthor(author.id));
    const changed = pulled.some(Boolean);
    for (let index = 0; index < writers.length; index += 1) {
      await enqueueAuthor(writers[index].id, () => healAuthor(writers[index].id));
    }
    cacheAnswers();
    const typing = document.activeElement && document.activeElement.tagName === "TEXTAREA";
    if (changed && !typing) renderBoard();
    remoteReady = true;
  } catch (error) {
    return;
  } finally {
    syncing = false;
    setSyncNote("");
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

  if (!isQuestionFile(questionsFile)) throw new Error("data/questions.json 형식을 확인해 주세요.");
  if (!isReferenceFile(referencesFile)) throw new Error("data/references.json 형식을 확인해 주세요.");

  const fileAuthors = normalizeAuthors(authorsFile.authors);
  if (!fileAuthors) throw new Error("data/authors.json에 작성자가 없습니다.");
  state.authors = fileAuthors;
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
  const cachedAuthors = readStore(STORAGE.authors);
  const cachedAuthorList = cachedAuthors && normalizeAuthors(cachedAuthors.authors);
  if (cachedAuthorList) applyAuthors(cachedAuthorList, cachedAuthors.updatedAt || "");
  state.answers = mergeAnswers(answersFile.answers || {}, readStore(STORAGE.answers) || {});
  state.areaId = state.areas[0].id;
  const storedAuthor = readRaw(STORAGE.author) || "";
  state.authorId = state.authors.some((author) => author.id === storedAuthor && author.locked !== true) ? storedAuthor : "";
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

function aiAnswersVisible() {
  return !state.isAdmin || state.showAiAnswers !== false;
}

function readAiVisibility() {
  try {
    return sessionStorage.getItem(AI_VISIBLE_KEY) !== "0";
  } catch (error) {
    return true;
  }
}

function updateAdminButton() {
  document.getElementById("admin-open").textContent = state.isAdmin ? "관리 화면" : "관리자 로그인";
  const toggle = document.getElementById("ai-toggle");
  toggle.hidden = !state.isAdmin;
  document.getElementById("ai-toggle-input").checked = state.showAiAnswers !== false;
}

function normalizeAuthors(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const ids = new Set();
  const authors = [];
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    if (!item || typeof item.id !== "string" || !/^[A-Za-z0-9-]{1,40}$/.test(item.id)) return null;
    if (ids.has(item.id)) return null;
    if (typeof item.name !== "string") return null;
    const name = item.name.trim().slice(0, 20);
    if (!name) return null;
    ids.add(item.id);
    const author = { id: item.id, name: name };
    if (item.locked === true) author.locked = true;
    authors.push(author);
  }
  return authors;
}

function cacheAuthors() {
  writeStore(STORAGE.authors, { updatedAt: state.authorsUpdatedAt, authors: state.authors });
}

async function readAuthorsRemote() {
  const payload = await readBlob("au");
  if (!payload) return null;
  const authors = normalizeAuthors(payload.authors);
  if (!authors) return null;
  return { authors: authors, updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : "" };
}

async function persistAuthors() {
  state.authorsUpdatedAt = new Date().toISOString();
  cacheAuthors();
  await writeBlob("au", { authors: state.authors, updatedAt: state.authorsUpdatedAt });
  const stamp = timeKey(state.authorsUpdatedAt);
  await kvPut("aut", stamp);
  state.authorsStamp = stamp;
}

function applyAuthors(authors, updatedAt) {
  state.authors = authors;
  state.authorsUpdatedAt = updatedAt || "";
  if (state.authorId && !authors.some((author) => author.id === state.authorId && author.locked !== true)) {
    state.authorId = "";
    try { localStorage.removeItem(STORAGE.author); } catch (error) { /* ignore */ }
  }
  cacheAuthors();
}

function writableAuthors() {
  return state.authors.filter((author) => author.locked !== true);
}

function renderAuthorSelect() {
  const select = document.getElementById("author-select");
  const writers = writableAuthors();
  select.replaceChildren(
    el("option", { value: "", text: "이름을 선택하세요" }),
    ...writers.map((author) => el("option", { value: author.id, text: author.name }))
  );
  select.value = writers.some((author) => author.id === state.authorId) ? state.authorId : "";
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
  const blocks = state.authors.filter((person) => person.locked !== true || aiAnswersVisible()).map((person) => {
    const raw = saved[person.id];
    const entry = raw && raw.text && !raw.deleted ? raw : null;
    const text = entry ? entry.text : "아직 답변이 없습니다.";
    const sample = person.locked === true;
    const mine = !sample && author && person.id === author.id;
    return el("div", { class: sample ? "answer is-sample" : mine ? "answer is-self" : "answer" }, [
      el("div", { class: "answer-name", text: person.name }),
      el("p", { class: entry && entry.text ? "answer-text" : "answer-text is-empty", text: text }),
      entry && entry.updatedAt ? el("time", { class: "answer-time", datetime: entry.updatedAt, text: formatTime(entry.updatedAt) }) : null
    ]);
  });

  return el("article", { class: "question" }, [
    el("div", { class: "q-index", text: String(index + 1).padStart(2, "0") }),
    el("div", { class: "q-body" }, [
      el("h3", { class: "q-text", text: question.text }),
      el("div", { class: "q-actions" }, [
        el("button", {
          type: "button",
          class: "btn btn-primary",
          "data-action": "write",
          "data-question": question.id,
          text: "답변작성"
        })
      ]),
      el("div", { class: "answers" }, blocks)
    ])
  ]);
}

function findQuestion(questionId) {
  for (let index = 0; index < state.areas.length; index += 1) {
    const question = state.areas[index].questions.find((item) => item.id === questionId);
    if (question) return question;
  }
  return null;
}

function answerDraft(questionId, authorId) {
  const draftBucket = state.drafts[questionId] || {};
  if (Object.prototype.hasOwnProperty.call(draftBucket, authorId)) return draftBucket[authorId];
  const saved = state.answers[questionId] && state.answers[questionId][authorId];
  return saved && saved.text && !saved.deleted ? saved.text : "";
}

function closeAnswerModal() {
  const modal = document.getElementById("answer-modal");
  if (!modal || modal.hidden) return;
  flushAutosave(false);
  if (document.activeElement && modal.contains(document.activeElement)) document.activeElement.blur();
  modal.hidden = true;
  const adminOpen = !document.getElementById("admin").hidden;
  const anyModal = Array.from(document.querySelectorAll(".modal")).some((node) => !node.hidden);
  if (!adminOpen && !anyModal) document.body.classList.remove("modal-open");
}

function openAnswerModal(questionId) {
  if (!state.authorId) {
    toast("작성자를 먼저 선택해 주세요.");
    return;
  }
  const question = findQuestion(questionId);
  const author = currentAuthor();
  if (!question || !author) return;
  const saved = state.answers[questionId] && state.answers[questionId][author.id];
  const hasSaved = Boolean(saved && saved.text && !saved.deleted);
  document.getElementById("answer-modal-author").textContent = author.name;
  document.getElementById("answer-modal-question").textContent = question.text;
  const box = document.getElementById("answer-modal-text");
  box.dataset.question = questionId;
  box.value = answerDraft(questionId, author.id);
  const remove = document.getElementById("answer-modal-delete");
  remove.hidden = !hasSaved;
  remove.dataset.question = questionId;
  setSaveStatus(hasSaved ? "자동 저장됨" : "입력하면 자동으로 저장됩니다.");
  openModal("answer-modal");
  box.focus();
}

function questionField(questionId) {
  const box = document.getElementById("answer-modal-text");
  if (box && box.dataset.question === questionId) return box;
  return null;
}

function rememberAnswer(questionId, authorId, entry) {
  if (!state.answers[questionId]) state.answers[questionId] = {};
  state.answers[questionId][authorId] = entry;
  if (!state.drafts[questionId]) state.drafts[questionId] = {};
  state.drafts[questionId][authorId] = entry.deleted ? "" : entry.text;
  cacheAnswers();
  const remove = document.getElementById("answer-modal-delete");
  const box = document.getElementById("answer-modal-text");
  if (remove && box && box.dataset.question === questionId && state.authorId === authorId) {
    remove.hidden = !entry.text || entry.deleted;
  }
}

function scheduleAutosave() {
  window.clearTimeout(autosaveTimer);
  setSaveStatus("입력 중");
  autosaveTimer = window.setTimeout(() => { flushAutosave(false); }, 700);
}

async function flushAutosave(manual) {
  window.clearTimeout(autosaveTimer);
  const box = document.getElementById("answer-modal-text");
  const questionId = box && box.dataset.question;
  const authorId = state.authorId;
  if (!questionId || !authorId) {
    if (manual) toast("작성자를 먼저 선택해 주세요.");
    return;
  }
  if (honeypotFilled()) {
    toast("저장하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.");
    return;
  }
  if (saveBusy) {
    saveAgain = true;
    return;
  }
  const text = box.value.trim().slice(0, LIMITS.answer);
  const prev = state.answers[questionId] && state.answers[questionId][authorId];
  const prevText = prev && prev.text && !prev.deleted ? prev.text : "";
  if (!text) {
    setSaveStatus(prevText ? "지우려면 삭제를 누르세요." : "입력하면 자동으로 저장됩니다.");
    if (manual && !prevText) toast("답변을 입력해 주세요.");
    return;
  }
  if (text === prevText) {
    setSaveStatus("자동 저장됨");
    if (manual) toast("변경된 내용이 없습니다.");
    return;
  }
  const entry = { text: text, updatedAt: new Date().toISOString() };
  rememberAnswer(questionId, authorId, entry);
  renderBoard();
  setSaveStatus("저장 중…");
  saveBusy = true;
  try {
    await enqueueAuthor(authorId, () => publishEntry(questionId, authorId, entry));
    const still = document.getElementById("answer-modal-text");
    const sameBox = still && still.dataset.question === questionId && state.authorId === authorId;
    if (!sameBox || still.value.trim() === text) setSaveStatus("자동 저장됨");
    if (manual) toast("답변을 저장했습니다.");
  } catch (error) {
    setSaveStatus("저장하지 못했습니다. 다시 시도합니다.");
    autosaveTimer = window.setTimeout(() => { flushAutosave(false); }, 2500);
  } finally {
    saveBusy = false;
    if (saveAgain) {
      saveAgain = false;
      flushAutosave(false);
    }
  }
}

async function requestDelete(questionId) {
  if (!state.authorId) {
    toast("작성자를 먼저 선택해 주세요.");
    return;
  }
  if (!getAnswer(questionId, state.authorId)) return;
  if (!window.confirm("이 답변을 삭제합니다. 계속할까요?")) return;
  window.clearTimeout(autosaveTimer);
  saveAgain = false;
  const authorId = state.authorId;
  const previous = structuredClone(state.answers[questionId][authorId]);
  const entry = { text: "", deleted: true, updatedAt: new Date().toISOString() };
  rememberAnswer(questionId, authorId, entry);
  const box = document.getElementById("answer-modal-text");
  if (box && box.dataset.question === questionId) box.value = "";
  closeAnswerModal();
  renderBoard();
  saveBusy = true;
  try {
    await enqueueAuthor(authorId, () => publishEntry(questionId, authorId, entry));
    toast("답변을 삭제했습니다.");
  } catch (error) {
    state.answers[questionId][authorId] = previous;
    cacheAnswers();
    toast("서버에서 삭제하지 못했습니다. 다시 시도해 주세요.");
    renderBoard();
  } finally {
    saveBusy = false;
  }
}

function areaReferences() {
  const area = currentArea();
  return state.references.filter((item) => item.areaId === area.id);
}

function refSortKey(ref) {
  const match = String(ref && ref.title || "").match(/^(\d+)(?:-(\d+))?/);
  if (!match) return 100000;
  return Number(match[1]) * 100 + Number(match[2] || 0);
}

function sortedReferences() {
  return state.references.slice().sort((left, right) => {
    const gap = refSortKey(left) - refSortKey(right);
    if (gap) return gap;
    return String(left.title).localeCompare(String(right.title), "ko");
  });
}

function updateRefFab() {
  const button = document.getElementById("ref-fab");
  const badge = document.getElementById("ref-fab-count");
  if (!button || !badge) return;
  const count = sortedReferences().length;
  button.classList.toggle("is-empty", count === 0);
  button.setAttribute("aria-label", count
    ? "참고 자료 " + count + "개 열기"
    : "등록된 참고 자료가 없습니다");
  if (count) {
    badge.hidden = false;
    badge.textContent = String(count);
  } else {
    badge.hidden = true;
  }
}

function renderReferences() {
  updateRefFab();
}

function openReferenceList() {
  const refs = sortedReferences();
  const body = document.getElementById("ref-list-body");
  const note = document.getElementById("ref-list-note");
  document.getElementById("ref-list-title").textContent = "참고 자료";
  if (!refs.length) {
    note.textContent = "등록된 참고 자료가 없습니다.";
    body.replaceChildren(el("p", { class: "empty", text: "관리자가 자료를 올리면 여기에 나타납니다." }));
  } else {
    note.textContent = "번호 순서입니다. 읽을 자료를 고르세요.";
    body.replaceChildren(...refs.map((ref) => {
      return el("button", {
        type: "button",
        class: "ref-pick",
        "data-ref-id": ref.id
      }, [
        el("span", { class: "ref-pick-title", text: ref.title }),
        el("span", { class: "ref-pick-hint", text: "읽기" })
      ]);
    }));
  }
  openModal("ref-list-modal");
  document.getElementById("ref-list-close").focus();
}

function openReferenceItem(id) {
  const ref = state.references.find((item) => item.id === id);
  if (!ref) {
    toast("참조를 찾지 못했습니다.");
    return;
  }
  document.getElementById("ref-modal-title").textContent = ref.title;
  document.getElementById("ref-modal-body").replaceChildren(el("article", { class: "ref-article" }, [
    el("p", { text: ref.body })
  ]));
  document.getElementById("ref-list-modal").hidden = true;
  document.getElementById("ref-modal").hidden = false;
  document.body.classList.add("modal-open");
  document.getElementById("ref-modal-back").focus();
}

function backToReferenceList() {
  document.getElementById("ref-modal").hidden = true;
  document.getElementById("ref-list-modal").hidden = false;
  document.body.classList.add("modal-open");
  document.getElementById("ref-list-close").focus();
}

function closeAllReferenceModals() {
  document.getElementById("ref-modal").hidden = true;
  closeModal("ref-list-modal");
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
    renderBoard();
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
    }),
    el("button", {
      type: "button",
      class: state.adminTab === "authors" ? "btn btn-primary" : "btn btn-ghost",
      "data-action": "show-authors",
      text: "작성자"
    })
  ]);
  const panel = state.adminTab === "authors"
    ? renderAdminAuthors()
    : state.adminTab === "references" ? renderAdminReferences(area) : renderAdminQuestions(area);
  root.replaceChildren(
    tools,
    state.adminTab === "authors" ? null : el("label", { class: "field" }, ["다룰 영역", areaSelect]),
    switcher,
    panel
  );
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

function renderAdminAuthors() {
  const cards = state.authors.map((author) => {
    const name = el("input", { name: "name", maxlength: "20", required: true });
    name.value = author.name;
    return el("form", { class: "admin-card stack", "data-action": "save-author", "data-id": author.id }, [
      el("h3", { text: author.locked ? author.name + " · 보기 전용" : author.name }),
      el("label", { class: "field" }, ["이름", name]),
      el("div", { class: "row" }, [
        el("button", { type: "submit", class: "btn btn-primary", "data-guard": "cooldown", text: "이름 수정" }),
        el("button", { type: "button", class: "btn btn-danger", "data-action": "delete-author", "data-id": author.id, "data-guard": "cooldown", text: "삭제" })
      ])
    ]);
  });
  const addName = el("input", { name: "name", maxlength: "20", required: true });
  const addForm = el("form", { class: "admin-card stack", "data-action": "add-author" }, [
    el("h3", { text: "작성자 추가" }),
    el("label", { class: "field" }, ["이름", addName]),
    el("button", { type: "submit", class: "btn btn-primary", "data-guard": "cooldown", text: "작성자 추가" })
  ]);
  return el("div", { class: "stack" }, [
    el("p", { class: "hint", text: "삭제하면 그 작성자는 보기 화면과 작성자 선택에서 사라집니다. AI 작성자를 지우면 모범 답변 카드도 보이지 않습니다." }),
    ...cards,
    addForm
  ]);
}

async function saveAuthor(form) {
  if (!(await requireAdmin())) return;
  const author = state.authors.find((item) => item.id === form.dataset.id);
  if (!author) return;
  const name = String(new FormData(form).get("name") || "").trim().slice(0, 20);
  if (!name) {
    toast("이름을 입력해 주세요.");
    return;
  }
  if (name === author.name) {
    toast("변경된 내용이 없습니다.");
    return;
  }
  if (!assertCooldown()) return;
  const previous = author.name;
  author.name = name;
  try {
    await persistAuthors();
  } catch (error) {
    author.name = previous;
    toast("서버에 반영하지 못했습니다. 다시 시도해 주세요.");
    return;
  }
  stampCooldown();
  toast("작성자 이름을 수정했습니다.");
  renderAuthorSelect();
  renderBoard();
  renderAdmin();
}

async function addAuthor(form) {
  if (!(await requireAdmin())) return;
  const name = String(new FormData(form).get("name") || "").trim().slice(0, 20);
  if (!name) {
    toast("이름을 입력해 주세요.");
    return;
  }
  if (state.authors.length >= 12) {
    toast("작성자는 12명까지 둘 수 있습니다.");
    return;
  }
  if (!assertCooldown()) return;
  const previous = state.authors.slice();
  state.authors = previous.concat([{ id: uid("author"), name: name }]);
  try {
    await persistAuthors();
  } catch (error) {
    state.authors = previous;
    toast("서버에 반영하지 못했습니다. 다시 시도해 주세요.");
    return;
  }
  stampCooldown();
  toast("작성자를 추가했습니다.");
  renderAuthorSelect();
  renderBoard();
  renderAdmin();
}

async function deleteAuthor(id) {
  if (!(await requireAdmin())) return;
  const author = state.authors.find((item) => item.id === id);
  if (!author) return;
  if (state.authors.length <= 1) {
    toast("작성자는 한 명은 남겨 주세요.");
    return;
  }
  if (!window.confirm(author.name + " 작성자를 삭제합니다. 보기 화면에서 사라집니다. 계속할까요?")) return;
  if (!assertCooldown()) return;
  const previous = state.authors.slice();
  const previousId = state.authorId;
  state.authors = previous.filter((item) => item.id !== id);
  if (state.authorId === id) state.authorId = "";
  try {
    await persistAuthors();
  } catch (error) {
    state.authors = previous;
    state.authorId = previousId;
    toast("서버에 반영하지 못해 삭제하지 않았습니다.");
    return;
  }
  if (!state.authorId) {
    try { localStorage.removeItem(STORAGE.author); } catch (error) { /* ignore */ }
  }
  stampCooldown();
  toast("작성자를 삭제했습니다. 보기 화면에서 숨깁니다.");
  renderAuthorSelect();
  renderBoard();
  renderAdmin();
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
  if (action === "show-authors") {
    state.adminTab = "authors";
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
  if (action === "delete-author") await deleteAuthor(button.dataset.id);
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
  else if (action === "save-author") await saveAuthor(form);
  else if (action === "add-author") await addAuthor(form);
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
    flushAutosave(false);
    state.authorId = document.getElementById("author-select").value;
    try {
      if (state.authorId) localStorage.setItem(STORAGE.author, state.authorId);
      else localStorage.removeItem(STORAGE.author);
    } catch (error) { /* ignore */ }
    const questionId = document.getElementById("answer-modal-text").dataset.question;
    const writing = !document.getElementById("answer-modal").hidden;
    renderBoard();
    if (writing && questionId) {
      if (state.authorId) openAnswerModal(questionId);
      else closeAnswerModal();
    }
  });

  document.getElementById("area-tabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-area]");
    if (!tab) return;
    state.areaId = tab.dataset.area;
    renderBoard();
  });

  document.getElementById("answer-modal-text").addEventListener("input", (event) => {
    const box = event.target;
    if (!state.authorId || !box.dataset.question) return;
    if (!state.drafts[box.dataset.question]) state.drafts[box.dataset.question] = {};
    state.drafts[box.dataset.question][state.authorId] = box.value;
    scheduleAutosave();
  });

  document.getElementById("question-list").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    if (button.dataset.action === "write") openAnswerModal(button.dataset.question);
  });

  document.getElementById("answer-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const questionId = document.getElementById("answer-modal-text").dataset.question;
    if (questionId) flushAutosave(true);
  });
  document.getElementById("answer-modal-close").addEventListener("click", closeAnswerModal);
  document.getElementById("answer-modal-delete").addEventListener("click", () => {
    const questionId = document.getElementById("answer-modal-delete").dataset.question;
    if (questionId) requestDelete(questionId);
  });

  document.getElementById("ai-toggle-input").addEventListener("change", (event) => {
    if (!state.isAdmin) return;
    state.showAiAnswers = event.target.checked;
    try { sessionStorage.setItem(AI_VISIBLE_KEY, state.showAiAnswers ? "1" : "0"); } catch (error) { /* ignore */ }
    renderBoard();
    toast(state.showAiAnswers ? "AI 답변을 표시합니다." : "AI 답변을 숨겼습니다.");
  });

  document.getElementById("admin-open").addEventListener("click", async () => {
    if (await readSession()) {
      state.isAdmin = true;
      updateAdminButton();
      renderBoard();
      openAdmin();
      return;
    }
    state.isAdmin = false;
    updateAdminButton();
    openLogin();
  });

  document.getElementById("login-form").addEventListener("submit", submitLogin);
  document.getElementById("login-cancel").addEventListener("click", () => closeModal("login-modal"));
  document.getElementById("ref-fab").addEventListener("click", openReferenceList);
  document.getElementById("ref-list-close").addEventListener("click", () => closeModal("ref-list-modal"));
  document.getElementById("ref-list-body").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-ref-id]");
    if (button) openReferenceItem(button.dataset.refId);
  });
  document.getElementById("ref-modal-back").addEventListener("click", backToReferenceList);
  document.getElementById("ref-modal-close").addEventListener("click", closeAllReferenceModals);
  document.getElementById("admin-close").addEventListener("click", closeAdmin);
  document.getElementById("admin-logout").addEventListener("click", logout);

  document.querySelectorAll(".modal").forEach((modal) => {
    modal.addEventListener("click", (event) => {
      if (event.target !== modal) return;
      if (modal.id === "ref-modal") closeAllReferenceModals();
      else if (modal.id === "ref-list-modal") closeModal("ref-list-modal");
      else closeModal(modal.id);
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!document.getElementById("answer-modal").hidden) closeAnswerModal();
    else if (!document.getElementById("login-modal").hidden) closeModal("login-modal");
    else if (!document.getElementById("ref-modal").hidden) backToReferenceList();
    else if (!document.getElementById("ref-list-modal").hidden) closeModal("ref-list-modal");
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
    state.showAiAnswers = readAiVisibility();
    renderAuthorSelect();
    renderBoard();
    updateAdminButton();
    updateCooldownUI();
    window.setInterval(updateCooldownUI, 500);
    syncRemote();
    window.setInterval(() => {
      if (document.visibilityState === "visible") syncRemote();
    }, 12000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") syncRemote();
    });
  } catch (error) {
    showFatal(error && error.message ? error.message : "데이터를 불러오지 못했습니다.");
  }
}

init();
