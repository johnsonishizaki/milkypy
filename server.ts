process.env.DISABLE_HMR = "true";
import "dotenv/config";

import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { spawn } from "child_process";
import { createServer as createViteServer } from "vite";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, doc, setDoc, getDoc, getDocs, deleteDoc, query, where } from "firebase/firestore";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import {
  buildMilkyChatSystemInstruction,
  stripDecorativeEmojis,
} from "./src/data/curriculum/aiCurriculumGuide.ts";

const app = express();
const PORT = 3000;

// Enforce WWW & HTTPS 301 Redirects for production custom domain milkypy.com
app.use((req, res, next) => {
  const host = ((req.headers["x-forwarded-host"] as string) || req.headers.host || "").toLowerCase();
  const proto = ((req.headers["x-forwarded-proto"] as string) || req.protocol || "https").toLowerCase();

  if (host === "www.milkypy.com") {
    return res.redirect(301, `https://milkypy.com${req.originalUrl || req.url}`);
  }
  if (host === "milkypy.com" && proto === "http") {
    return res.redirect(301, `https://milkypy.com${req.originalUrl || req.url}`);
  }
  next();
});

// Enable CORS & standard security headers (omits X-Frame-Options so embedded previews work)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json({ limit: "5mb" }));

// Persistent JSON Storage Path (local backup / legacy support)
const DB_FILE = path.join(process.cwd(), "user_cloud_db.json");

interface StoredUser {
  userId: string;
  passwordHash: string;
  createdAt: number;
  updatedAt?: number;
}

interface StoredCloudFile {
  id: string;
  userId: string;
  name: string;
  code: string;
  updatedAt: number;
}

export interface StoredSharedSnippet {
  id: string;
  code: string;
  title: string;
  author: string;
  createdAt: number;
}

interface DBData {
  users: Record<string, StoredUser>;
  files: Record<string, StoredCloudFile[]>;
  sharedSnippets?: Record<string, StoredSharedSnippet>;
}

const loadDB = (): DBData => {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn("Failed to read DB file, initializing fresh store:", e);
  }
  return { users: {}, files: {} };
};

const saveDB = (data: DBData) => {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to write DB file:", e);
  }
};

let db = loadDB();

// Initialize Firebase
const firebaseConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), "firebase-applet-config.json"), "utf8"));
const firebaseApp = initializeApp({
  projectId: firebaseConfig.projectId,
  appId: firebaseConfig.appId,
  apiKey: firebaseConfig.apiKey,
  authDomain: firebaseConfig.authDomain,
});
const firestore = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);

// Password Hashing Helper (SHA-256 hex)
function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(`milkypy:${password}`).digest("hex");
}

function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash) return false;
  const computed = hashPassword(password);
  return storedHash === computed || storedHash === password;
}

function isValidUserId(userId: string): boolean {
  return /^[a-zA-Z0-9_-]{2,32}$/.test(userId);
}

function cleanAndParseJson(text: string): any {
  let clean = (text || "").trim();
  if (clean.startsWith("```")) {
    clean = clean.replace(/^```(?:json)?\n?/i, "");
    clean = clean.replace(/\n?```$/, "");
  }
  clean = clean.trim();
  try {
    return JSON.parse(clean);
  } catch {
    const objStart = clean.indexOf("{");
    const objEnd = clean.lastIndexOf("}");
    if (objStart !== -1 && objEnd > objStart) {
      return JSON.parse(clean.slice(objStart, objEnd + 1));
    }
    const arrStart = clean.indexOf("[");
    const arrEnd = clean.lastIndexOf("]");
    if (arrStart !== -1 && arrEnd > arrStart) {
      return JSON.parse(clean.slice(arrStart, arrEnd + 1));
    }
    throw new Error("Invalid JSON response from AI.");
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`));
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function clampText(val: unknown, maxChars: number): string {
  const s = typeof val === "string" ? val.trim() : String(val ?? "").trim();
  if (!s || s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n... (truncated)`;
}

function clampMessages(
  messages?: Array<{ role: string; text: string }>
): Array<{ role: "user" | "model"; text: string }> {
  const recent = (messages || []).slice(-6);
  return recent
    .map((m, idx) => {
      const isLast = idx === recent.length - 1;
      const text = clampText(m?.text || "", isLast ? 1200 : 750);
      return {
        role: (m?.role === "assistant" || m?.role === "model" ? "model" : "user") as "user" | "model",
        text,
      };
    })
    .filter((m) => m.text.length > 0);
}

function normalizeGeminiContents(
  messages?: Array<{ role: string; text: string }>,
  prompt?: string
): Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> {
  const raw = clampMessages(messages);
  if (prompt && prompt.trim()) {
    raw.push({ role: "user", text: clampText(prompt, 3800) });
  }

  // Gemini requires contents to start with a user turn and alternate cleanly
  while (raw.length > 0 && raw[0].role !== "user") {
    raw.shift();
  }

  const merged: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];
  for (const item of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === item.role) {
      prev.parts[0].text = `${prev.parts[0].text}\n\n${item.text}`;
    } else {
      merged.push({ role: item.role, parts: [{ text: item.text }] });
    }
  }

  if (merged.length === 0) {
    merged.push({ role: "user", parts: [{ text: "Hello" }] });
  }
  return merged;
}

// Smart In-Memory Cache for zero-cost repeated queries
interface AICacheEntry {
  data: any;
  timestamp: number;
}
const aiResponseCache = new Map<string, AICacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 Hours

function getCacheKey(type: string, prompt: string, extra?: string): string {
  const normalized = `${type}:${prompt.trim().replace(/\s+/g, " ")}:${(extra || "").trim()}`;
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash << 5) - hash + normalized.charCodeAt(i);
    hash |= 0;
  }
  return `${type}_${Math.abs(hash)}`;
}

// Per-IP Sliding-Window Rate Limiter for Cloud AI endpoints
const serverAiRateLimits = new Map<string, { shortWindow: number[]; hourWindow: number[] }>();

function checkServerAiRateLimit(req: express.Request): { allowed: boolean } {
  const forwarded = req.headers["x-forwarded-for"];
  const ip =
    (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : undefined) ||
    req.ip ||
    "anonymous";
  const now = Date.now();
  const tenMinAgo = now - 10 * 60 * 1000;
  const oneHourAgo = now - 60 * 60 * 1000;

  const entry = serverAiRateLimits.get(ip) || { shortWindow: [], hourWindow: [] };
  entry.shortWindow = entry.shortWindow.filter((t) => t > tenMinAgo);
  entry.hourWindow = entry.hourWindow.filter((t) => t > oneHourAgo);

  if (entry.shortWindow.length >= 15 || entry.hourWindow.length >= 40) {
    serverAiRateLimits.set(ip, entry);
    return { allowed: false };
  }

  entry.shortWindow.push(now);
  entry.hourWindow.push(now);
  if (serverAiRateLimits.size > 500) {
    const firstIp = serverAiRateLimits.keys().next().value;
    if (firstIp) serverAiRateLimits.delete(firstIp);
  }
  serverAiRateLimits.set(ip, entry);
  return { allowed: true };
}

function getServerProviderOrder(): Array<"gemini" | "groq" | "deepseek"> {
  const preferred = (process.env.AI_PRIMARY_PROVIDER || "").trim().toLowerCase();
  if (preferred === "deepseek") return ["deepseek", "gemini", "groq"];
  if (preferred === "groq") return ["groq", "gemini", "deepseek"];
  return ["gemini", "groq", "deepseek"];
}

// Gemini SDK Caller (@google/genai)
async function callGeminiDirect(options: {
  systemInstruction?: string;
  prompt: string;
  messages?: Array<{ role: "user" | "assistant" | "model"; text: string }>;
  responseType?: "json" | "text";
  maxTokens?: number;
  apiKey: string;
}): Promise<any> {
  const ai = new GoogleGenAI({
    apiKey: options.apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  const contents = normalizeGeminiContents(options.messages, options.prompt);

  const modelCandidates: Array<{ model: string; thinkingLevel: ThinkingLevel; timeoutMs: number }> = [
    { model: "gemini-4-hydrogen", thinkingLevel: ThinkingLevel.LOW, timeoutMs: 25000 },
    { model: "gemini-3.1-flash-lite", thinkingLevel: ThinkingLevel.MINIMAL, timeoutMs: 20000 },
  ];

  let lastErr: Error | null = null;
  for (const candidate of modelCandidates) {
    const controller = new AbortController();
    try {
      const response = await withTimeout(
        ai.models.generateContent({
          model: candidate.model,
          contents,
          config: {
            abortSignal: controller.signal,
            ...(options.systemInstruction ? { systemInstruction: clampText(options.systemInstruction, 4500) } : {}),
            thinkingConfig: { thinkingLevel: candidate.thinkingLevel },
            maxOutputTokens: Math.min(options.maxTokens || 900, 1400),
            ...(options.responseType === "json" ? { responseMimeType: "application/json" } : {}),
          },
        }),
        candidate.timeoutMs,
        `Gemini (${candidate.model})`
      );

      const content = response.text || "";
      if (!content.trim()) {
        throw new Error(`Empty response returned from Gemini (${candidate.model}).`);
      }

      if (options.responseType === "json") {
        return cleanAndParseJson(content);
      }
      return { text: content };
    } catch (err: any) {
      controller.abort();
      lastErr = err instanceof Error ? err : new Error(String(err));
      console.warn(`[Gemini ${candidate.model} fallback]:`, lastErr.message);
    }
  }

  throw lastErr || new Error("Gemini API request failed.");
}

// OpenAI-Compatible Caller (Groq / DeepSeek)
async function callOpenAiCompatible(options: {
  endpoint: string;
  model: string;
  apiKey: string;
  systemInstruction?: string;
  prompt: string;
  messages?: Array<{ role: "user" | "assistant" | "model"; text: string }>;
  responseType?: "json" | "text";
  maxTokens?: number;
}): Promise<any> {
  const formattedMessages: Array<{ role: string; content: string }> = [];
  let systemContent = clampText(options.systemInstruction || "", 4500);
  if (
    options.responseType === "json" &&
    !systemContent.toLowerCase().includes("json") &&
    !options.prompt.toLowerCase().includes("json")
  ) {
    systemContent = `${systemContent ? systemContent + "\n" : ""}Respond ONLY in valid JSON.`;
  }
  if (systemContent) {
    formattedMessages.push({ role: "system", content: systemContent });
  }
  const clampedHistory = clampMessages(options.messages);
  for (const m of clampedHistory) {
    formattedMessages.push({
      role: m.role === "model" ? "assistant" : "user",
      content: m.text,
    });
  }
  if (options.prompt && options.prompt.trim()) {
    formattedMessages.push({ role: "user", content: clampText(options.prompt, 3800) });
  }
  if (formattedMessages.length === 0) {
    formattedMessages.push({ role: "user", content: "Hello" });
  }

  const payload: any = {
    model: options.model,
    messages: formattedMessages,
    temperature: 0.3,
    max_tokens: Math.min(options.maxTokens || 900, 1400),
  };

  if (options.responseType === "json") {
    payload.response_format = { type: "json_object" };
  }

  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), 35000);
  let resp: Response;
  try {
    resp = await fetch(options.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutTimer);
  }

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`AI API (${options.model}) returned error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || "";
  if (!content.trim()) {
    throw new Error(`Empty response returned from ${options.model}.`);
  }
  if (options.responseType === "json") {
    return cleanAndParseJson(content);
  }
  return { text: content };
}

// Unified AI Engine (Free-tier Gemini & Groq prioritized first by default, DeepSeek fallback)
async function callPlatformAi(options: {
  cacheKeyPrefix: string;
  systemInstruction?: string;
  prompt: string;
  messages?: Array<{ role: "user" | "assistant" | "model"; text: string }>;
  responseType?: "json" | "text";
  maxTokens?: number;
}): Promise<any> {
  if ((process.env.DISABLE_CLOUD_AI || "").trim().toLowerCase() === "true") {
    const missingErr: any = new Error("Cloud AI is paused via DISABLE_CLOUD_AI — using built-in offline guide.");
    missingErr.missingApiKey = true;
    throw missingErr;
  }

  const clampedHistory = clampMessages(options.messages);
  const fullText =
    clampText(options.prompt, 3800) +
    clampText(options.systemInstruction || "", 4500) +
    clampedHistory.map((m) => `${m.role}:${m.text}`).join("|");
  const cacheKey = getCacheKey(options.cacheKeyPrefix, fullText);
  const cached = aiResponseCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return { ...cached.data, _fromCache: true };
  }

  const deepseekKey = (process.env.DEEPSEEK_API_KEY || "").trim();
  const geminiKey = (process.env.GEMINI_API_KEY || "").trim();
  const groqKey = (process.env.GROQ_API_KEY || "").trim();

  const keys: Record<"gemini" | "groq" | "deepseek", string> = {
    gemini: geminiKey && geminiKey !== "your_gemini_api_key_here" ? geminiKey : "",
    groq: groqKey && groqKey !== "your_groq_api_key_here" ? groqKey : "",
    deepseek: deepseekKey && deepseekKey !== "your_deepseek_api_key_here" ? deepseekKey : "",
  };

  const errors: string[] = [];

  for (const provider of getServerProviderOrder()) {
    const apiKey = keys[provider];
    if (!apiKey) continue;
    try {
      let result: any;
      if (provider === "gemini") {
        result = await callGeminiDirect({ ...options, apiKey });
      } else if (provider === "groq") {
        result = await callOpenAiCompatible({
          endpoint: "https://api.groq.com/openai/v1/chat/completions",
          model: "llama-3.3-70b-versatile",
          apiKey,
          ...options,
        });
      } else {
        result = await callOpenAiCompatible({
          endpoint: "https://api.deepseek.com/chat/completions",
          model: "deepseek-chat",
          apiKey,
          ...options,
        });
      }
      aiResponseCache.set(cacheKey, { data: result, timestamp: Date.now() });
      return { ...result, _engine: provider };
    } catch (err: any) {
      console.warn(`[${provider} AI Error]:`, err?.message || err);
      errors.push(`${provider}: ${err?.message || err}`);
    }
  }

  if (errors.length === 0) {
    const missingErr: any = new Error(
      "No AI API key configured on the server. Set GEMINI_API_KEY, GROQ_API_KEY, or DEEPSEEK_API_KEY in environment variables."
    );
    missingErr.missingApiKey = true;
    throw missingErr;
  }

  throw new Error(errors.join(" | "));
}

// Pyodide Sync Input store
const pendingInputs = new Map<string, (text: string) => void>();

app.get("/api/pyodide/wait-input", (req, res) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId) return res.status(400).send("");

  const timeout = setTimeout(() => {
    pendingInputs.delete(sessionId);
    res.send("");
  }, 300000);

  pendingInputs.set(sessionId, (text: string) => {
    clearTimeout(timeout);
    res.send(text);
  });
});

app.post("/api/pyodide/submit-input", express.json(), (req, res) => {
  const { sessionId, input } = req.body;
  const resolver = pendingInputs.get(sessionId);
  if (resolver) {
    pendingInputs.delete(sessionId);
    resolver(input);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Session not waiting" });
  }
});

// Instant Native Server Python Execution Endpoint (Zero-Latency Fallback & Hybrid Runner)
app.post("/api/py/run", (req, res) => {
  try {
    const { code, input } = req.body;
    if (typeof code !== "string") {
      res.status(400).json({ error: "Code string is required" });
      return;
    }

    const startTime = Date.now();
    let stdout = "";
    let stderr = "";
    let finished = false;

    const pyProcess = spawn("python3", ["-u", "-c", code], {
      timeout: 10000,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    const timeoutTimer = setTimeout(() => {
      if (!finished) {
        finished = true;
        pyProcess.kill("SIGKILL");
        res.json({
          stdout,
          stderr: stderr ? `${stderr}\nExecution timed out (10s limit).` : "Execution timed out (10s limit).",
          executionTimeMs: Date.now() - startTime,
          isError: true,
        });
      }
    }, 10000);

    if (typeof input === "string" && input.length > 0) {
      pyProcess.stdin.write(input.endsWith("\n") ? input : input + "\n");
      pyProcess.stdin.end();
    } else {
      pyProcess.stdin.end();
    }

    pyProcess.stdout.on("data", (data) => {
      stdout += data.toString();
      if (stdout.length > 500000) {
        pyProcess.kill("SIGKILL");
      }
    });

    pyProcess.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    pyProcess.on("close", (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      const executionTimeMs = Date.now() - startTime;
      res.json({
        stdout,
        stderr,
        executionTimeMs,
        isError: exitCode !== 0 || !!stderr.trim().length,
      });
    });

    pyProcess.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      res.json({
        stdout,
        stderr: "Native execution error: " + err.message,
        executionTimeMs: Date.now() - startTime,
        isError: true,
      });
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Execution failed" });
  }
});

// API Routes
app.get("/api/health", (_req, res) => {
  const disabled = (process.env.DISABLE_CLOUD_AI || "").trim().toLowerCase() === "true";
  const hasDeepseek = Boolean(process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY !== "your_deepseek_api_key_here");
  const hasGemini = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "your_gemini_api_key_here");
  const hasGroq = Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== "your_groq_api_key_here");
  const aiConfigured = !disabled && (hasDeepseek || hasGemini || hasGroq);
  const order = getServerProviderOrder();
  const primaryProvider = disabled
    ? "disabled"
    : order.find((p) => (p === "gemini" ? hasGemini : p === "groq" ? hasGroq : hasDeepseek)) || "none";
  res.json({ status: "ok", runtime: "node-express", aiConfigured, primaryProvider, timestamp: Date.now() });
});

async function getUserFilesFromFirestore(userId: string): Promise<StoredCloudFile[]> {
  try {
    const q = query(collection(firestore, "files"), where("userId", "==", userId));
    const snapshot = await getDocs(q);
    return snapshot.docs.map((d) => d.data() as StoredCloudFile);
  } catch (e) {
    console.warn("Firestore files read fallback to local store:", e);
    return db.files[userId] || [];
  }
}

async function ensureStarterFileForUser(userId: string): Promise<StoredCloudFile[]> {
  let files = await getUserFilesFromFirestore(userId);
  if (files.length === 0) {
    const localFiles = db.files[userId];
    if (localFiles && localFiles.length > 0) {
      files = localFiles;
    } else {
      files = [
        {
          id: `file-${userId}-1`,
          userId,
          name: "main.py",
          code: `# Welcome ${userId}! Your Python files auto-save in the cloud.\nprint("Hello, ${userId}!")\n`,
          updatedAt: Date.now(),
        },
      ];
    }
    for (const f of files) {
      try {
        await setDoc(doc(firestore, "files", f.id), f);
      } catch (fsErr) {
        console.warn("Firestore starter file sync warning:", fsErr);
      }
    }
    db.files[userId] = files;
    saveDB(db);
  }
  return files;
}

// Student Sign Up Endpoint (Firestore backed + local backup)
app.post("/api/auth/signup", async (req, res) => {
  try {
    const rawUserId = (req.body.userId || "").toString().trim().toLowerCase();
    const password = (req.body.password || "").toString();

    if (!rawUserId || !isValidUserId(rawUserId)) {
      res.status(400).json({ error: "User ID must be 2-32 characters (letters, numbers, _ or -)." });
      return;
    }
    if (!password || password.length < 4) {
      res.status(400).json({ error: "Password must be at least 4 characters long." });
      return;
    }

    // Check Firestore first
    let existingUser: StoredUser | null = null;
    try {
      const snap = await getDoc(doc(firestore, "student_accounts", rawUserId));
      if (snap.exists()) {
        existingUser = snap.data() as StoredUser;
      }
    } catch (fsErr) {
      console.warn("Firestore signup lookup fallback:", fsErr);
    }

    if (!existingUser && db.users[rawUserId]) {
      existingUser = db.users[rawUserId];
    }

    if (existingUser) {
      res.status(409).json({ error: `Student ID "${rawUserId}" is already registered. Please log in instead.` });
      return;
    }

    const now = Date.now();
    const newUser: StoredUser = {
      userId: rawUserId,
      passwordHash: hashPassword(password),
      createdAt: now,
    };

    try {
      await setDoc(doc(firestore, "student_accounts", rawUserId), newUser);
    } catch (fsErr) {
      console.warn("Firestore account write warning:", fsErr);
    }

    db.users[rawUserId] = newUser;
    saveDB(db);

    const files = await ensureStarterFileForUser(rawUserId);

    res.json({
      success: true,
      userId: rawUserId,
      files,
      message: `Account "${rawUserId}" created!`,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Sign up failed" });
  }
});

// Student Login Endpoint (supports Firestore + legacy local DB accounts)
app.post("/api/auth/login", async (req, res) => {
  try {
    const rawUserId = (req.body.userId || "").toString().trim().toLowerCase();
    const password = (req.body.password || "").toString();
    const allowAutoCreate = Boolean(req.body.autoCreate);

    if (!rawUserId || !isValidUserId(rawUserId)) {
      res.status(400).json({ error: "Enter a valid Student ID (2-32 chars, letters/numbers/_/-)." });
      return;
    }

    if (!password) {
      res.status(400).json({ error: "Password is required." });
      return;
    }

    let user: StoredUser | null = null;
    try {
      const snap = await getDoc(doc(firestore, "student_accounts", rawUserId));
      if (snap.exists()) {
        user = snap.data() as StoredUser;
      }
    } catch (fsErr) {
      console.warn("Firestore login lookup fallback:", fsErr);
    }

    if (!user && db.users[rawUserId]) {
      user = db.users[rawUserId];
      // Migrate legacy user silently to Firestore if possible
      try {
        await setDoc(doc(firestore, "student_accounts", rawUserId), {
          userId: rawUserId,
          passwordHash: user.passwordHash.length === 64 ? user.passwordHash : hashPassword(user.passwordHash),
          createdAt: user.createdAt || Date.now(),
        });
      } catch {}
    }

    if (!user) {
      if (allowAutoCreate) {
        if (password.length < 4) {
          res.status(400).json({ error: "Password must be at least 4 characters long." });
          return;
        }
        const now = Date.now();
        user = {
          userId: rawUserId,
          passwordHash: hashPassword(password),
          createdAt: now,
        };
        try {
          await setDoc(doc(firestore, "student_accounts", rawUserId), user);
        } catch {}
        db.users[rawUserId] = user;
        saveDB(db);
      } else {
        res.status(404).json({
          error: `No account found for "${rawUserId}". Switch to Sign Up to create it.`,
        });
        return;
      }
    } else if (!verifyPassword(password, user.passwordHash)) {
      res.status(401).json({ error: `Incorrect password for Student ID "${rawUserId}".` });
      return;
    }

    const userFiles = await ensureStarterFileForUser(rawUserId);
    res.json({
      success: true,
      userId: rawUserId,
      files: userFiles,
      message: `Welcome back, ${rawUserId}!`,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Authentication failed" });
  }
});

// Fetch user cloud files
app.get("/api/user/files/:userId", async (req, res) => {
  try {
    const userId = (req.params.userId || "").trim().toLowerCase();
    const files = await getUserFilesFromFirestore(userId);
    res.json({ success: true, userId, files });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to fetch cloud files" });
  }
});

// Save user cloud file
app.post("/api/user/files/save", async (req, res) => {
  try {
    const userId = (req.body.userId || "").trim().toLowerCase();
    let fileId = req.body.fileId;
    const name = (req.body.name || "untitled.py").trim();
    const code = req.body.code ?? "";

    if (!userId) {
      res.status(400).json({ error: "User ID is required" });
      return;
    }

    const existingFiles = await getUserFilesFromFirestore(userId);
    const existingFile = existingFiles.find(
      (f) => f.id === fileId || f.name.toLowerCase() === name.toLowerCase()
    );
    if (existingFile) {
      fileId = existingFile.id;
    } else if (!fileId) {
      fileId = `file-${userId}-${Date.now()}`;
    }

    const updatedFile: StoredCloudFile = {
      id: fileId,
      userId,
      name,
      code,
      updatedAt: Date.now(),
    };

    try {
      await setDoc(doc(firestore, "files", fileId), updatedFile);
    } catch (fsErr) {
      console.warn("Firestore save file fallback:", fsErr);
    }

    // Update local backup too
    const localList = db.files[userId] || [];
    const idx = localList.findIndex((f) => f.id === fileId);
    if (idx >= 0) localList[idx] = updatedFile;
    else localList.push(updatedFile);
    db.files[userId] = localList;
    saveDB(db);

    const files = await getUserFilesFromFirestore(userId);
    res.json({
      success: true,
      file: updatedFile,
      files: files.length > 0 ? files : localList,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to save cloud file" });
  }
});

// Delete user cloud file
app.post("/api/user/files/delete", async (req, res) => {
  try {
    const userId = (req.body.userId || "").trim().toLowerCase();
    const fileId = req.body.fileId;

    if (!userId || !fileId) {
      res.status(400).json({ error: "User ID and File ID required" });
      return;
    }

    try {
      await deleteDoc(doc(firestore, "files", fileId));
    } catch (fsErr) {
      console.warn("Firestore delete file warning:", fsErr);
    }

    if (db.files[userId]) {
      db.files[userId] = db.files[userId].filter((f) => f.id !== fileId);
      saveDB(db);
    }

    const files = await getUserFilesFromFirestore(userId);
    res.json({ success: true, files });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to delete cloud file" });
  }
});

// Share code snippet permanently via Firebase
app.post("/api/snippets/share", async (req, res) => {
  try {
    const code = (req.body.code || "").toString();
    const title = (req.body.title || "Shared Python Script").toString().trim();
    const author = (req.body.author || "MilkyPy Student").toString().trim();

    if (!code.trim()) {
      res.status(400).json({ error: "Code cannot be empty to share" });
      return;
    }

    const snippetId = `snip-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
    const snippetData: StoredSharedSnippet = {
      id: snippetId,
      code,
      title,
      author,
      createdAt: Date.now(),
    };

    try {
      await setDoc(doc(firestore, "shared_snippets", snippetId), snippetData);
    } catch (fsErr) {
      console.warn("Firestore save warning, falling back to local store:", fsErr);
    }

    const localDb = loadDB();
    if (!localDb.sharedSnippets) localDb.sharedSnippets = {};
    localDb.sharedSnippets[snippetId] = snippetData;
    saveDB(localDb);

    const proto = (req.headers["x-forwarded-proto"] as string) || "https";
    const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "localhost:3000";
    const shareUrl = `${proto}://${host}/?snippet=${snippetId}`;

    res.json({
      success: true,
      snippetId,
      shareUrl,
      snippet: snippetData,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to generate share link" });
  }
});

// Fetch shared snippet by unique ID
app.get("/api/snippets/:id", async (req, res) => {
  try {
    const snippetId = (req.params.id || "").trim();
    if (!snippetId) {
      res.status(400).json({ error: "Snippet ID is required" });
      return;
    }

    try {
      const snap = await getDoc(doc(firestore, "shared_snippets", snippetId));
      if (snap.exists()) {
        res.json({ success: true, snippet: snap.data() });
        return;
      }
    } catch (fsErr) {
      console.warn("Firestore snippet read fallback:", fsErr);
    }

    const localDb = loadDB();
    const localSnippet = localDb.sharedSnippets?.[snippetId];
    if (localSnippet) {
      res.json({ success: true, snippet: localSnippet });
      return;
    }

    res.status(404).json({ error: "Shared Python snippet not found" });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to load shared snippet" });
  }
});

// Middleware: Rate limit all Cloud AI endpoints
app.use("/api/ai", (req, res, next) => {
  if (req.method === "POST") {
    const check = checkServerAiRateLimit(req);
    if (!check.allowed) {
      res.status(429).json({
        success: false,
        rateLimited: true,
        error: "Cloud AI rate limit reached — switching to on-device Python guide.",
      });
      return;
    }
  }
  next();
});

// AI Endpoint: Debug & Fix Code
app.post("/api/ai/debug", async (req, res) => {
  try {
    const { code, errorMessage } = req.body;
    if (!code) {
      res.status(400).json({ error: "Code is required" });
      return;
    }

    const clampedCode = clampText(code, 3000);
    const clampedErr = clampText(errorMessage || "", 600);
    const prompt = `Concise Python tutor. No emojis. Fix the bug briefly:
\`\`\`python
${clampedCode}
\`\`\`
Error: ${clampedErr || "Find logical or runtime bug."}
Respond in JSON:
{
  "fixedCode": "string",
  "explanation": "string (1-2 sentences)",
  "bugType": "string",
  "tips": ["string"]
}`;

    const parsed = await callPlatformAi({
      cacheKeyPrefix: "debug_v3",
      prompt,
      responseType: "json",
      maxTokens: 950,
    });

    if (typeof parsed.explanation === "string") {
      parsed.explanation = stripDecorativeEmojis(parsed.explanation);
    }
    if (Array.isArray(parsed.tips)) {
      parsed.tips = parsed.tips.map((t: any) => (typeof t === "string" ? stripDecorativeEmojis(t) : t));
    }

    res.json({ success: true, ...parsed });
  } catch (error: any) {
    console.error("AI Debug Error:", error);
    res.status(error?.missingApiKey ? 503 : 500).json({
      success: false,
      missingApiKey: Boolean(error?.missingApiKey),
      error: error.message || "Failed to process AI debugging request.",
    });
  }
});

// AI Endpoint: Add Guided Comments
app.post("/api/ai/add-comments", async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) {
      res.status(400).json({ error: "Code is required" });
      return;
    }

    const clampedCode = clampText(code, 3000);
    const prompt = `Add concise # comments explaining key lines. Keep logic intact. No emojis:
\`\`\`python
${clampedCode}
\`\`\`
Respond in JSON:
{
  "commentedCode": "string",
  "summary": "string (1 sentence)"
}`;

    const parsed = await callPlatformAi({
      cacheKeyPrefix: "comment_v3",
      prompt,
      responseType: "json",
      maxTokens: 1000,
    });

    if (typeof parsed.summary === "string") {
      parsed.summary = stripDecorativeEmojis(parsed.summary);
    }

    res.json({ success: true, ...parsed });
  } catch (error: any) {
    console.error("AI Comment Error:", error);
    res.status(error?.missingApiKey ? 503 : 500).json({
      success: false,
      missingApiKey: Boolean(error?.missingApiKey),
      error: error.message || "Failed to generate comments.",
    });
  }
});

// AI Endpoint: Explain Code
app.post("/api/ai/explain", async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) {
      res.status(400).json({ error: "Code is required" });
      return;
    }

    const clampedCode = clampText(code, 3000);
    const prompt = `Explain this Python snippet simply (no emojis):
\`\`\`python
${clampedCode}
\`\`\`
Respond in JSON:
{
  "summary": "string (1-2 sentences)",
  "steps": ["string"],
  "concepts": ["string"]
}`;

    const parsed = await callPlatformAi({
      cacheKeyPrefix: "explain_v3",
      prompt,
      responseType: "json",
      maxTokens: 750,
    });

    if (typeof parsed.summary === "string") {
      parsed.summary = stripDecorativeEmojis(parsed.summary);
    }
    if (Array.isArray(parsed.steps)) {
      parsed.steps = parsed.steps.map((s: any) => (typeof s === "string" ? stripDecorativeEmojis(s) : s));
    }

    res.json({ success: true, ...parsed });
  } catch (error: any) {
    console.error("AI Explain Error:", error);
    res.status(error?.missingApiKey ? 503 : 500).json({
      success: false,
      missingApiKey: Boolean(error?.missingApiKey),
      error: error.message || "Failed to explain code.",
    });
  }
});

// AI Endpoint: Progressive Lesson Hint
app.post("/api/ai/hint", async (req, res) => {
  try {
    const { lessonTitle, lessonDescription, currentCode, targetOutput } = req.body;
    const clampedCode = clampText(currentCode || "# Empty", 2000);
    const prompt = `Lesson "${clampText(lessonTitle || "Python Exercise", 100)}": ${clampText(
      lessonDescription || "Practice Python",
      250
    )}.
Goal: ${clampText(targetOutput || "Correct solution", 150)}
Code:
\`\`\`python
${clampedCode}
\`\`\`
Give a 1-2 sentence hint without giving the full solution (no emojis). JSON:
{
  "hint": "string",
  "conceptToReview": "string"
}`;

    const parsed = await callPlatformAi({
      cacheKeyPrefix: "hint_v3",
      prompt,
      responseType: "json",
      maxTokens: 280,
    });

    if (typeof parsed.hint === "string") {
      parsed.hint = stripDecorativeEmojis(parsed.hint);
    }

    res.json({ success: true, ...parsed });
  } catch (error: any) {
    console.error("AI Hint Error:", error);
    res.status(error?.missingApiKey ? 503 : 500).json({
      success: false,
      missingApiKey: Boolean(error?.missingApiKey),
      error: error.message || "Failed to generate hint.",
    });
  }
});

// AI Endpoint: Chat Assistant (General-purpose + Python & Curriculum Specialist)
app.post("/api/ai/chat", async (req, res) => {
  try {
    const { messages, code, currentCode, lessonContext, systemInstruction: customSystem } = req.body;
    const normalizedMessages = clampMessages(messages);
    const lastUserMessage = [...normalizedMessages].reverse().find((m) => m.role === "user")?.text || "";

    const effectiveCode = clampText(code || currentCode || "", 2200);
    const systemInstruction = buildMilkyChatSystemInstruction({
      code: effectiveCode,
      lessonContext,
      customSystem,
      latestUserMessage: lastUserMessage,
    });

    const result = await callPlatformAi({
      cacheKeyPrefix: "chat_v3",
      systemInstruction,
      prompt: "",
      messages: normalizedMessages,
      responseType: "text",
      maxTokens: 1100,
    });

    const allowEmojis = /emoji|unicode/i.test(lastUserMessage);
    const cleanedText = allowEmojis ? result.text : stripDecorativeEmojis(result.text);

    res.json({ success: true, text: cleanedText, reply: cleanedText });
  } catch (error: any) {
    console.error("AI Chat Error:", error);
    res.status(error?.missingApiKey ? 503 : 500).json({
      success: false,
      missingApiKey: Boolean(error?.missingApiKey),
      error: error.message || "Failed to generate chat response.",
    });
  }
});

// AI Endpoint: Dynamic Randomized AI Quiz Generator
app.post("/api/ai/quiz", async (req, res) => {
  try {
    const { lessonTitle, lessonConcept, difficulty } = req.body;

    const systemInstruction = `Create one concise Python multiple-choice question. No emojis. JSON only:
{
  "question": "string",
  "codeSnippet": "string",
  "options": ["string", "string", "string", "string"],
  "correctIndex": 0,
  "explanation": "string",
  "hint": "string"
}`;

    const prompt = `Topic: ${clampText(lessonTitle || "Python Fundamentals", 100)}
Details: ${clampText(lessonConcept || "", 280)}
Difficulty: ${difficulty || "intermediate"}`;

    const parsed = await callPlatformAi({
      cacheKeyPrefix: "quiz_v3",
      systemInstruction,
      prompt,
      responseType: "json",
      maxTokens: 480,
    });

    if (parsed && parsed.question && Array.isArray(parsed.options) && typeof parsed.correctIndex === "number") {
      res.json({
        success: true,
        quiz: {
          id: `ai-quiz-${Date.now()}`,
          lessonId: req.body.lessonId || "custom",
          topicTitle: lessonTitle || "Python Practice",
          type: parsed.codeSnippet ? "predict-output" : "multiple-choice",
          question: parsed.question,
          codeSnippet: parsed.codeSnippet || undefined,
          options: parsed.options,
          correctIndex: parsed.correctIndex,
          explanation: parsed.explanation || "Correct answer.",
          hint: parsed.hint || "Review the lesson concepts.",
          difficulty: difficulty || "intermediate",
        },
      });
    } else {
      throw new Error("Invalid quiz JSON structure received from model");
    }
  } catch (error: any) {
    console.warn("AI Quiz generation error:", error.message);
    res.status(error?.missingApiKey ? 503 : 500).json({
      success: false,
      missingApiKey: Boolean(error?.missingApiKey),
      error: error.message || "Failed to generate AI quiz",
    });
  }
});

// Vite & Static file setup
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: "spa",
    });
    // Intercept /@vite/client to suppress benign WebSocket reconnect notice
    app.get("/@vite/client", async (req, res, next) => {
      try {
        const mod = await vite.transformRequest("/@vite/client");
        if (mod && mod.code) {
          const patched = mod.code
            .replace(
              'reject(new Error("WebSocket closed without opened."));',
              'resolve();'
            )
            .replace(
              'reject(new Error("WebSocket closed without opened."))',
              'resolve()'
            )
            .replace(
              /console\.error\(`\[vite\] failed to connect to websocket.*?\);/g,
              '/* suppressed */'
            );
          res.set({ "Content-Type": "application/javascript" });
          return res.send(patched);
        }
      } catch (err) {
        // Fallback to default vite middleware
      }
      next();
    });

    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`MilkPy server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
