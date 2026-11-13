import firebaseConfig from "../../firebase-applet-config.json";
import {
  buildMilkyChatSystemInstruction,
  stripDecorativeEmojis,
} from "../../src/data/curriculum/aiCurriculumGuide.ts";

interface CFContext {
  request: Request;
  env: Record<string, string | undefined>;
  params: { route?: string | string[] };
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

function isValidUserId(userId: string): boolean {
  return /^[a-zA-Z0-9_-]{2,32}$/.test(userId);
}

async function hashPassword(password: string): Promise<string> {
  const bytes = new TextEncoder().encode(`milkypy:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash) return false;
  const computed = await hashPassword(password);
  return storedHash === computed || storedHash === password;
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
    throw new Error("Invalid JSON response returned from AI.");
  }
}

function normalizeGeminiContentsEdge(
  messages?: Array<{ role: string; text: string }>,
  prompt?: string
): Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> {
  const raw: Array<{ role: "user" | "model"; text: string }> = [];
  for (const m of (messages || []).slice(-14)) {
    const text = (m?.text || "").trim();
    if (!text) continue;
    raw.push({
      role: m.role === "assistant" || m.role === "model" ? "model" : "user",
      text,
    });
  }
  if (prompt && prompt.trim()) {
    raw.push({ role: "user", text: prompt.trim() });
  }
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

// =====================================================================
// Firestore REST API Helpers (Zero Node.js Dependencies for Edge Runtime)
// =====================================================================

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents`;

function toFirestoreValue(val: unknown): Record<string, unknown> {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === "string") return { stringValue: val };
  if (typeof val === "boolean") return { booleanValue: val };
  if (typeof val === "number") {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(toFirestoreValue) } };
  }
  if (typeof val === "object") {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function toFirestoreFields(obj: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) fields[k] = toFirestoreValue(v);
  }
  return fields;
}

function fromFirestoreValue(val: any): any {
  if (!val || typeof val !== "object") return undefined;
  if ("nullValue" in val) return null;
  if ("stringValue" in val) return val.stringValue;
  if ("booleanValue" in val) return val.booleanValue;
  if ("integerValue" in val) return Number(val.integerValue);
  if ("doubleValue" in val) return Number(val.doubleValue);
  if ("arrayValue" in val) return (val.arrayValue?.values || []).map(fromFirestoreValue);
  if ("mapValue" in val) return fromFirestoreFields(val.mapValue?.fields || {});
  return undefined;
}

function fromFirestoreFields(fields: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(fields || {})) {
    out[k] = fromFirestoreValue(v);
  }
  return out;
}

async function fsGetDoc(collectionName: string, docId: string): Promise<Record<string, any> | null> {
  const res = await fetch(
    `${FIRESTORE_BASE}/${collectionName}/${encodeURIComponent(docId)}?key=${firebaseConfig.apiKey}`
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Firestore read failed (${res.status}): ${txt}`);
  }
  const data: any = await res.json();
  return fromFirestoreFields(data.fields || {});
}

async function fsCreateDoc(
  collectionName: string,
  docId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const res = await fetch(
    `${FIRESTORE_BASE}/${collectionName}?documentId=${encodeURIComponent(docId)}&key=${firebaseConfig.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: toFirestoreFields(payload) }),
    }
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Firestore create failed (${res.status}): ${txt}`);
  }
}

async function fsSetDoc(
  collectionName: string,
  docId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const res = await fetch(
    `${FIRESTORE_BASE}/${collectionName}/${encodeURIComponent(docId)}?key=${firebaseConfig.apiKey}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: toFirestoreFields(payload) }),
    }
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Firestore write failed (${res.status}): ${txt}`);
  }
}

async function fsDeleteDoc(collectionName: string, docId: string): Promise<void> {
  const res = await fetch(
    `${FIRESTORE_BASE}/${collectionName}/${encodeURIComponent(docId)}?key=${firebaseConfig.apiKey}`,
    { method: "DELETE" }
  );
  if (!res.ok && res.status !== 404) {
    const txt = await res.text();
    throw new Error(`Firestore delete failed (${res.status}): ${txt}`);
  }
}

async function fsQueryFilesByUser(userId: string): Promise<any[]> {
  const res = await fetch(`${FIRESTORE_BASE}:runQuery?key=${firebaseConfig.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "files" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "userId" },
            op: "EQUAL",
            value: { stringValue: userId },
          },
        },
      },
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Firestore query failed (${res.status}): ${txt}`);
  }
  const rows: any[] = await res.json();
  return rows.filter((r) => r.document?.fields).map((r) => fromFirestoreFields(r.document.fields));
}

// =====================================================================
// Edge AI Providers (DeepSeek primary + Gemini & Groq fallback)
// =====================================================================

async function callGeminiEdge(options: {
  apiKey: string;
  systemInstruction?: string;
  prompt: string;
  messages?: Array<{ role: string; text: string }>;
  responseType?: "json" | "text";
  maxTokens?: number;
}): Promise<any> {
  const contents = normalizeGeminiContentsEdge(options.messages, options.prompt);

  const candidates: Array<{ model: string; thinkingLevel: "LOW" | "MINIMAL"; timeoutMs: number }> = [
    { model: "gemini-4-hydrogen", thinkingLevel: "LOW", timeoutMs: 22000 },
    { model: "gemini-3.1-flash-lite", thinkingLevel: "MINIMAL", timeoutMs: 18000 },
  ];

  let lastErr: Error | null = null;
  for (const candidate of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), candidate.timeoutMs);
    try {
      const body: any = {
        contents,
        generationConfig: {
          thinkingConfig: { thinkingLevel: candidate.thinkingLevel },
          ...(options.responseType === "json" ? { responseMimeType: "application/json" } : {}),
        },
      };

      if (options.systemInstruction) {
        body.systemInstruction = { parts: [{ text: options.systemInstruction }] };
      }

      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${candidate.model}:generateContent?key=${encodeURIComponent(
          options.apiKey
        )}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "aistudio-build",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }
      );

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Gemini API (${candidate.model} ${resp.status}): ${errText}`);
      }

      const data: any = await resp.json();
      const parts: any[] = data?.candidates?.[0]?.content?.parts || [];
      const content =
        parts
          .filter((p) => typeof p?.text === "string" && !p?.thought)
          .map((p) => p.text)
          .join("") ||
        parts.map((p) => p?.text || "").join("") ||
        "";

      if (!content.trim()) {
        throw new Error(`Empty response returned from Gemini API (${candidate.model}).`);
      }

      if (options.responseType === "json") {
        return cleanAndParseJson(content);
      }
      return { text: content };
    } catch (err: any) {
      if (err?.name === "AbortError") {
        lastErr = new Error(`Gemini (${candidate.model}) timed out.`);
      } else {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr || new Error("Gemini Edge request failed.");
}

async function callOpenAiEdge(options: {
  endpoint: string;
  model: string;
  apiKey: string;
  systemInstruction?: string;
  prompt: string;
  messages?: Array<{ role: string; text: string }>;
  responseType?: "json" | "text";
  maxTokens?: number;
}): Promise<any> {
  const formattedMessages: Array<{ role: string; content: string }> = [];
  let systemContent = options.systemInstruction || "";
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
  if (options.messages && options.messages.length > 0) {
    for (const m of options.messages.slice(-14)) {
      const text = (m.text || "").trim();
      if (!text) continue;
      formattedMessages.push({
        role: m.role === "model" || m.role === "assistant" ? "assistant" : "user",
        content: text,
      });
    }
  }
  if (options.prompt && options.prompt.trim()) {
    formattedMessages.push({ role: "user", content: options.prompt.trim() });
  }
  if (formattedMessages.length === 0) {
    formattedMessages.push({ role: "user", content: "Hello" });
  }

  const payload: any = {
    model: options.model,
    messages: formattedMessages,
    temperature: 0.35,
    max_tokens: Math.min(options.maxTokens || 4096, 8192),
  };
  if (options.responseType === "json") {
    payload.response_format = { type: "json_object" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
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
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`AI API (${options.model} ${resp.status}): ${errText}`);
  }

  const data: any = await resp.json();
  const content = data?.choices?.[0]?.message?.content || "";
  if (!content.trim()) {
    throw new Error(`Empty response returned from ${options.model}.`);
  }
  if (options.responseType === "json") {
    return cleanAndParseJson(content);
  }
  return { text: content };
}

async function callCloudflareAi(
  env: Record<string, string | undefined>,
  options: {
    systemInstruction?: string;
    prompt: string;
    messages?: Array<{ role: string; text: string }>;
    responseType?: "json" | "text";
    maxTokens?: number;
  }
): Promise<any> {
  const deepseekKey = (env.DEEPSEEK_API_KEY || "").trim();
  const geminiKey = (env.GEMINI_API_KEY || "").trim();
  const groqKey = (env.GROQ_API_KEY || "").trim();

  const errors: string[] = [];

  if (deepseekKey && deepseekKey !== "your_deepseek_api_key_here") {
    try {
      const res = await callOpenAiEdge({
        endpoint: "https://api.deepseek.com/chat/completions",
        model: "deepseek-chat",
        apiKey: deepseekKey,
        ...options,
      });
      return { ...res, _engine: "deepseek" };
    } catch (e: any) {
      errors.push(`DeepSeek: ${e?.message || String(e)}`);
    }
  }

  if (geminiKey && geminiKey !== "your_gemini_api_key_here") {
    try {
      const res = await callGeminiEdge({ apiKey: geminiKey, ...options });
      return { ...res, _engine: "gemini" };
    } catch (e: any) {
      errors.push(`Gemini: ${e?.message || String(e)}`);
    }
  }

  if (groqKey && groqKey !== "your_groq_api_key_here") {
    try {
      const res = await callOpenAiEdge({
        endpoint: "https://api.groq.com/openai/v1/chat/completions",
        model: "llama-3.3-70b-versatile",
        apiKey: groqKey,
        ...options,
      });
      return { ...res, _engine: "groq" };
    } catch (e: any) {
      errors.push(`Groq: ${e?.message || String(e)}`);
    }
  }

  if (errors.length === 0) {
    const err: any = new Error(
      "AI API key is not configured in Cloudflare Workers. Add DEEPSEEK_API_KEY (or GEMINI_API_KEY / GROQ_API_KEY) via Cloudflare Workers dashboard -> Settings -> Variables and Secrets or wrangler secret put, then redeploy."
    );
    err.missingApiKey = true;
    throw err;
  }

  throw new Error(errors.join(" | "));
}

// =====================================================================
// Main Request Router
// =====================================================================

export async function onRequest(context: CFContext): Promise<Response> {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const apiPath = url.pathname.replace(/^\/api\/?/, "");

  try {
    // Health check
    if (apiPath === "health" && request.method === "GET") {
      const hasDeepseek = Boolean(env.DEEPSEEK_API_KEY && env.DEEPSEEK_API_KEY !== "your_deepseek_api_key_here");
      const hasGemini = Boolean(env.GEMINI_API_KEY && env.GEMINI_API_KEY !== "your_gemini_api_key_here");
      const hasGroq = Boolean(env.GROQ_API_KEY && env.GROQ_API_KEY !== "your_groq_api_key_here");
      const aiConfigured = hasDeepseek || hasGemini || hasGroq;
      const primaryProvider = hasDeepseek ? "deepseek" : hasGemini ? "gemini" : hasGroq ? "groq" : "none";
      return jsonResponse({
        status: "ok",
        runtime: "cloudflare-pages",
        aiConfigured,
        primaryProvider,
        timestamp: Date.now(),
      });
    }

    // Native Python execution fallback signal for Edge runtime (forces browser Pyodide WASM)
    if (apiPath === "py/run" && request.method === "POST") {
      return jsonResponse({
        browserWasmRequired: true,
        stdout: "",
        stderr: "",
        isError: false,
      });
    }

    const body: any =
      request.method === "POST" || request.method === "PUT"
        ? await request.json().catch(() => ({}))
        : {};

    // Sign Up
    if (apiPath === "auth/signup" && request.method === "POST") {
      const rawUserId = (body.userId || "").toString().trim().toLowerCase();
      const password = (body.password || "").toString();

      if (!rawUserId || !isValidUserId(rawUserId)) {
        return jsonResponse(
          { error: "User ID must be 2-32 characters (letters, numbers, _ or -)." },
          400
        );
      }
      if (!password || password.length < 4) {
        return jsonResponse(
          { error: "Password must be at least 4 characters long." },
          400
        );
      }

      const existing = await fsGetDoc("student_accounts", rawUserId);
      if (existing) {
        return jsonResponse(
          { error: `Student ID "${rawUserId}" is already registered. Please log in instead.` },
          409
        );
      }

      const now = Date.now();
      const passwordHash = await hashPassword(password);
      await fsCreateDoc("student_accounts", rawUserId, {
        userId: rawUserId,
        passwordHash,
        createdAt: now,
      });

      const starterFile = {
        id: `file-${rawUserId}-1`,
        userId: rawUserId,
        name: "main.py",
        code: `# Welcome ${rawUserId}! Your Python files auto-save in the cloud.\nprint("Hello, ${rawUserId}!")\n`,
        updatedAt: now,
      };
      await fsSetDoc("files", starterFile.id, starterFile);

      return jsonResponse({
        success: true,
        userId: rawUserId,
        files: [starterFile],
        message: `Account "${rawUserId}" created!`,
      });
    }

    // Login
    if (apiPath === "auth/login" && request.method === "POST") {
      const rawUserId = (body.userId || "").toString().trim().toLowerCase();
      const password = (body.password || "").toString();
      const allowAutoCreate = Boolean(body.autoCreate);

      if (!rawUserId || !isValidUserId(rawUserId)) {
        return jsonResponse(
          { error: "Enter a valid Student ID (2-32 chars, letters/numbers/_/-)." },
          400
        );
      }
      if (!password) {
        return jsonResponse({ error: "Password is required." }, 400);
      }

      const user = await fsGetDoc("student_accounts", rawUserId);
      if (!user) {
        if (allowAutoCreate) {
          if (password.length < 4) {
            return jsonResponse({ error: "Password must be at least 4 characters long." }, 400);
          }
          const now = Date.now();
          await fsCreateDoc("student_accounts", rawUserId, {
            userId: rawUserId,
            passwordHash: await hashPassword(password),
            createdAt: now,
          });
        } else {
          return jsonResponse(
            { error: `No account found for "${rawUserId}". Switch to Sign Up to create it.` },
            404
          );
        }
      } else {
        const valid = await verifyPassword(password, user.passwordHash);
        if (!valid) {
          return jsonResponse(
            { error: `Incorrect password for Student ID "${rawUserId}".` },
            401
          );
        }
      }

      let files = await fsQueryFilesByUser(rawUserId);
      if (files.length === 0) {
        const starterFile = {
          id: `file-${rawUserId}-1`,
          userId: rawUserId,
          name: "main.py",
          code: `# Welcome ${rawUserId}! Your Python files auto-save in the cloud.\nprint("Hello, ${rawUserId}!")\n`,
          updatedAt: Date.now(),
        };
        await fsSetDoc("files", starterFile.id, starterFile);
        files = [starterFile];
      }

      return jsonResponse({
        success: true,
        userId: rawUserId,
        files,
        message: `Welcome back, ${rawUserId}!`,
      });
    }

    // Fetch user cloud files
    if (apiPath.startsWith("user/files/") && request.method === "GET") {
      const userId = decodeURIComponent(apiPath.replace("user/files/", "")).trim().toLowerCase();
      const files = await fsQueryFilesByUser(userId);
      return jsonResponse({ success: true, userId, files });
    }

    // Save user cloud file
    if (apiPath === "user/files/save" && request.method === "POST") {
      const userId = (body.userId || "").toString().trim().toLowerCase();
      let fileId = body.fileId;
      const name = (body.name || "untitled.py").toString().trim();
      const code = body.code ?? "";

      if (!userId) {
        return jsonResponse({ error: "User ID is required" }, 400);
      }

      const existingFiles = await fsQueryFilesByUser(userId);
      const existingFile = existingFiles.find(
        (f) => f.id === fileId || (f.name && f.name.toLowerCase() === name.toLowerCase())
      );
      if (existingFile) {
        fileId = existingFile.id;
      } else if (!fileId) {
        fileId = `file-${userId}-${Date.now()}`;
      }

      const updatedFile = {
        id: fileId,
        userId,
        name,
        code,
        updatedAt: Date.now(),
      };
      await fsSetDoc("files", fileId, updatedFile);
      const files = await fsQueryFilesByUser(userId);
      return jsonResponse({ success: true, file: updatedFile, files });
    }

    // Delete user cloud file
    if (apiPath === "user/files/delete" && request.method === "POST") {
      const userId = (body.userId || "").toString().trim().toLowerCase();
      const fileId = body.fileId;
      if (!userId || !fileId) {
        return jsonResponse({ error: "User ID and File ID required" }, 400);
      }
      await fsDeleteDoc("files", fileId);
      const files = await fsQueryFilesByUser(userId);
      return jsonResponse({ success: true, files });
    }

    // Share snippet
    if (apiPath === "snippets/share" && request.method === "POST") {
      const code = (body.code || "").toString();
      const title = (body.title || "Shared Python Script").toString().trim();
      const author = (body.author || "MilkyPy Student").toString().trim();
      if (!code.trim()) {
        return jsonResponse({ error: "Code cannot be empty to share" }, 400);
      }
      const snippetId = `snip-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
      const snippetData = {
        id: snippetId,
        code,
        title,
        author,
        createdAt: Date.now(),
      };
      await fsCreateDoc("shared_snippets", snippetId, snippetData);
      const shareUrl = `${url.origin}/?snippet=${snippetId}`;
      return jsonResponse({ success: true, snippetId, shareUrl, snippet: snippetData });
    }

    // Get shared snippet
    if (apiPath.startsWith("snippets/") && request.method === "GET") {
      const snippetId = decodeURIComponent(apiPath.replace("snippets/", "")).trim();
      const snippet = await fsGetDoc("shared_snippets", snippetId);
      if (!snippet) {
        return jsonResponse({ error: "Shared Python snippet not found" }, 404);
      }
      return jsonResponse({ success: true, snippet });
    }

    // AI: Debug
    if (apiPath === "ai/debug" && request.method === "POST") {
      if (!body.code) return jsonResponse({ error: "Code is required" }, 400);
      const prompt = `You are an expert Python tutor for beginner and intermediate learners. Never use emojis.
Analyze this Python code and the execution error (if any):

PYTHON CODE:
\`\`\`python
${body.code}
\`\`\`

ERROR / ISSUE REPORTED:
${body.errorMessage || "No explicit error, but code might have logical or runtime bugs."}

Respond ONLY in valid JSON matching this structure:
{
  "fixedCode": "string (the full corrected python code)",
  "explanation": "string (clear summary of the bug and how it was fixed)",
  "bugType": "string (e.g. IndentationError, TypeError, SyntaxError, LogicError)",
  "tips": ["string", "string"]
}`;
      const parsed = await callCloudflareAi(env, { prompt, responseType: "json", maxTokens: 4096 });
      if (typeof parsed.explanation === "string") parsed.explanation = stripDecorativeEmojis(parsed.explanation);
      if (Array.isArray(parsed.tips)) {
        parsed.tips = parsed.tips.map((t: any) => (typeof t === "string" ? stripDecorativeEmojis(t) : t));
      }
      return jsonResponse({ success: true, ...parsed });
    }

    // AI: Add comments
    if (apiPath === "ai/add-comments" && request.method === "POST") {
      if (!body.code) return jsonResponse({ error: "Code is required" }, 400);
      const prompt = `You are a Python programming guide. Add concise, educational inline Python comments (# comments) to this entire code so a student can understand every part. Preserve all functionality and never use emojis:

PYTHON CODE:
\`\`\`python
${body.code}
\`\`\`

Respond ONLY in valid JSON with format:
{
  "commentedCode": "string (the full python code with added educational comments)",
  "summary": "string (brief sentence describing what this code achieves)"
}`;
      const parsed = await callCloudflareAi(env, { prompt, responseType: "json", maxTokens: 4096 });
      if (typeof parsed.summary === "string") parsed.summary = stripDecorativeEmojis(parsed.summary);
      return jsonResponse({ success: true, ...parsed });
    }

    // AI: Explain
    if (apiPath === "ai/explain" && request.method === "POST") {
      if (!body.code) return jsonResponse({ error: "Code is required" }, 400);
      const prompt = `Explain the following Python code step-by-step for a learner (do not use emojis):

\`\`\`python
${body.code}
\`\`\`

Respond in JSON format:
{
  "summary": "string",
  "steps": ["string", "string"],
  "concepts": ["string", "string"]
}`;
      const parsed = await callCloudflareAi(env, { prompt, responseType: "json", maxTokens: 3000 });
      if (typeof parsed.summary === "string") parsed.summary = stripDecorativeEmojis(parsed.summary);
      if (Array.isArray(parsed.steps)) {
        parsed.steps = parsed.steps.map((s: any) => (typeof s === "string" ? stripDecorativeEmojis(s) : s));
      }
      return jsonResponse({ success: true, ...parsed });
    }

    // AI: Hint
    if (apiPath === "ai/hint" && request.method === "POST") {
      const prompt = `A student is working on "${body.lessonTitle || "Python Exercise"}".
Lesson task: ${body.lessonDescription || "Practice Python"}
Expected output: ${body.targetOutput || "Correct solution"}
Student's current code:
\`\`\`python
${body.currentCode || "# Empty"}
\`\`\`
Give a clear, encouraging hint (2-3 sentences max, no emojis). Respond in JSON:
{
  "hint": "string (helpful tip)",
  "conceptToReview": "string"
}`;
      const parsed = await callCloudflareAi(env, { prompt, responseType: "json", maxTokens: 1000 });
      if (typeof parsed.hint === "string") parsed.hint = stripDecorativeEmojis(parsed.hint);
      return jsonResponse({ success: true, ...parsed });
    }

    // AI: Chat (General-purpose + Python & Curriculum Specialist)
    if (apiPath === "ai/chat" && request.method === "POST") {
      const effectiveCode = body.code || body.currentCode || "";
      const systemInstruction = buildMilkyChatSystemInstruction({
        code: effectiveCode,
        lessonContext: body.lessonContext,
        customSystem: body.systemInstruction,
      });

      const normalizedMessages = (body.messages || []).map((m: any) => ({
        role: m.role === "assistant" || m.role === "model" ? "model" : "user",
        text: m.text || "",
      }));

      const result = await callCloudflareAi(env, {
        systemInstruction,
        prompt: "",
        messages: normalizedMessages,
        responseType: "text",
        maxTokens: 4096,
      });

      const lastUserMessage = [...normalizedMessages].reverse().find((m: any) => m.role === "user")?.text || "";
      const allowEmojis = /emoji|unicode/i.test(lastUserMessage);
      const cleanedText = allowEmojis ? result.text : stripDecorativeEmojis(result.text);

      return jsonResponse({ success: true, text: cleanedText, reply: cleanedText });
    }

    // AI: Quiz
    if (apiPath === "ai/quiz" && request.method === "POST") {
      const systemInstruction = `You are a Python curriculum specialist creating randomized, engaging quiz questions. Never use emojis.
Format your output strictly as a JSON object with this exact shape:
{
  "question": "string",
  "codeSnippet": "string",
  "options": ["string", "string", "string", "string"],
  "correctIndex": 0,
  "explanation": "string",
  "hint": "string"
}`;
      const prompt = `Create a dynamic Python quiz question for:
Topic: ${body.lessonTitle || "Python Fundamentals"}
Concept details: ${(body.lessonConcept || "").slice(0, 500)}
Difficulty: ${body.difficulty || "intermediate"}`;

      const parsed = await callCloudflareAi(env, {
        systemInstruction,
        prompt,
        responseType: "json",
        maxTokens: 1500,
      });

      if (parsed && parsed.question && Array.isArray(parsed.options) && typeof parsed.correctIndex === "number") {
        return jsonResponse({
          success: true,
          quiz: {
            id: `ai-quiz-${Date.now()}`,
            lessonId: body.lessonId || "custom",
            topicTitle: body.lessonTitle || "Python Practice",
            type: parsed.codeSnippet ? "predict-output" : "multiple-choice",
            question: parsed.question,
            codeSnippet: parsed.codeSnippet || undefined,
            options: parsed.options,
            correctIndex: parsed.correctIndex,
            explanation: parsed.explanation || "Correct answer.",
            hint: parsed.hint || "Review the lesson concepts.",
            difficulty: body.difficulty || "intermediate",
          },
        });
      }
      return jsonResponse({ success: false, error: "Invalid quiz JSON returned from AI." }, 500);
    }

    return jsonResponse({ error: `Unknown API route: /api/${apiPath}` }, 404);
  } catch (error: any) {
    return jsonResponse(
      {
        success: false,
        missingApiKey: Boolean(error?.missingApiKey),
        error: error?.message || "Edge API request failed.",
      },
      error?.missingApiKey ? 503 : 500
    );
  }
}
