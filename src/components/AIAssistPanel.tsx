import React, { useState, useRef, useEffect, useMemo } from "react";
import Prism from "prismjs";
import "prismjs/components/prism-python";
import {
  AIDebugResult,
  AICommentResult,
  AIExplainResult,
} from "../types";
import {
  X,
  Bug,
  MessageSquare,
  HelpCircle,
  Check,
  RotateCcw,
  Lightbulb,
  Send,
  MessageCircle,
  History,
  Copy,
  Trash2,
  PlusCircle,
  Search,
  Clock,
  WifiOff,
  Square,
  ChevronDown,
  Code2,
  Maximize2,
  Minimize2,
  AlertCircle,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import {
  AiChatSession,
  saveAiChatSession,
  getAiChatSessions,
  deleteAiChatSession,
  clearAllAiChatSessions,
} from "../lib/indexedDbStorage";
import {
  diagnoseOfflineError,
  explainOfflineCode,
  getOfflineChatReply,
} from "../lib/offlineAiKnowledge";
import { getApiUrl, fetchWithTimeout } from "../lib/apiConfig";
import { copyToClipboard } from "../lib/clipboard";
import { CopyCodeButton } from "./CopyCodeButton";

interface AIAssistPanelProps {
  isOpen: boolean;
  onClose: () => void;
  code: string;
  errorMessage?: string;
  onApplyCode: (newCode: string) => void;
  lessonContext?: {
    title: string;
    description: string;
    expectedOutput?: string;
    learningObjectives?: string[];
    starterCode?: string;
    quizQuestion?: {
      question: string;
      userChoice?: string;
      correctAnswer: string;
      explanation?: string;
      isCorrect?: boolean;
    };
  };
}

type TabType = "chat" | "debug" | "comments" | "explain" | "hint";

const CLIENT_AI_DAILY_LIMIT = 25;
const CLIENT_AI_USAGE_KEY = "milkypy_ai_daily_usage_v1";
const CLIENT_AI_CACHE_PREFIX = "milkypy_ai_cache_v1:";
const memPanelCache = new Map<string, unknown>();

function hashPanelKey(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function readPanelCache<T>(rawKey: string): T | null {
  const key = `${CLIENT_AI_CACHE_PREFIX}${hashPanelKey(rawKey)}`;
  if (memPanelCache.has(key)) {
    return memPanelCache.get(key) as T;
  }
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as T;
    memPanelCache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function writePanelCache<T>(rawKey: string, value: T): void {
  const key = `${CLIENT_AI_CACHE_PREFIX}${hashPanelKey(rawKey)}`;
  if (memPanelCache.size > 60) {
    const first = memPanelCache.keys().next().value;
    if (first) memPanelCache.delete(first);
  }
  memPanelCache.set(key, value);
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota issues
  }
}

function getTodayDateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function canUseDailyCloudAi(): boolean {
  try {
    const raw = localStorage.getItem(CLIENT_AI_USAGE_KEY);
    if (!raw) return true;
    const parsed = JSON.parse(raw) as { date?: string; count?: number };
    if (parsed.date !== getTodayDateStamp()) return true;
    return (parsed.count || 0) < CLIENT_AI_DAILY_LIMIT;
  } catch {
    return true;
  }
}

function recordCloudAiCall(): void {
  try {
    const today = getTodayDateStamp();
    const raw = localStorage.getItem(CLIENT_AI_USAGE_KEY);
    let count = 0;
    if (raw) {
      const parsed = JSON.parse(raw) as { date?: string; count?: number };
      if (parsed.date === today) count = parsed.count || 0;
    }
    localStorage.setItem(CLIENT_AI_USAGE_KEY, JSON.stringify({ date: today, count: count + 1 }));
  } catch {
    // Ignore localStorage restrictions
  }
}

function isStandardPythonError(err?: string): boolean {
  if (!err) return false;
  return /\b(SyntaxError|IndentationError|NameError|ZeroDivisionError|TypeError|IndexError|KeyError)\b/.test(
    err
  );
}

function clampClientText(text: string, maxChars: number): string {
  const s = (text || "").trim();
  if (!s || s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n... (truncated)`;
}

export const AIAssistPanel: React.FC<AIAssistPanelProps> = ({
  isOpen,
  onClose,
  code,
  errorMessage,
  onApplyCode,
  lessonContext,
}) => {
  const [activeTab, setActiveTab] = useState<TabType>(
    errorMessage ? "debug" : "chat"
  );
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const [debugResult, setDebugResult] = useState<AIDebugResult | null>(null);
  const [commentResult, setCommentResult] = useState<AICommentResult | null>(null);
  const [explainResult, setExplainResult] = useState<AIExplainResult | null>(null);
  const [hintResult, setHintResult] = useState<{ hint: string; conceptToReview?: string } | null>(null);

  // Chat State
  const [chatMessages, setChatMessages] = useState<{ role: "user" | "model"; text: string }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  // AI Chat History State (IndexedDB)
  const [activeSessionId, setActiveSessionId] = useState<string>(() => `chat-${Date.now()}`);
  const [activeSessionTitle, setActiveSessionTitle] = useState<string>("New Conversation");
  const [savedSessions, setSavedSessions] = useState<AiChatSession[]>([]);
  const [showHistoryDrawer, setShowHistoryDrawer] = useState(false);
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);
  const [historySearchQuery, setHistorySearchQuery] = useState("");
  const [copiedChat, setCopiedChat] = useState(false);
  const [applied, setApplied] = useState(false);
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [showObjectives, setShowObjectives] = useState(false);
  const [showCodePreview, setShowCodePreview] = useState(false);
  const [expandedWidth, setExpandedWidth] = useState(false);
  const activeAbortRef = useRef<AbortController | null>(null);
  const manualCancelRef = useRef(false);

  const attachedCodeLines = useMemo(() => {
    if (!code || !code.trim()) return 0;
    return code.split("\n").length;
  }, [code]);

  const highlightPython = (snippet: string) => {
    try {
      return Prism.highlight(
        snippet || "",
        Prism.languages.python || Prism.languages.clike,
        "python"
      );
    } catch {
      return snippet;
    }
  };

  const handleCancelAiRequest = () => {
    manualCancelRef.current = true;
    if (activeAbortRef.current) {
      activeAbortRef.current.abort();
      activeAbortRef.current = null;
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!isOpen && activeAbortRef.current) {
      manualCancelRef.current = true;
      activeAbortRef.current.abort();
      activeAbortRef.current = null;
      setLoading(false);
    }
  }, [isOpen]);

  // Dismiss on Escape (History drawer first, then whole panel)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showHistoryDrawer) {
          setShowHistoryDrawer(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, showHistoryDrawer, onClose]);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Load chat history from IndexedDB on open or mount
  const reloadChatHistory = async () => {
    try {
      const sessions = await getAiChatSessions();
      setSavedSessions(sessions);
      // If active chat is empty but sessions exist, load the latest
      if (chatMessages.length === 0 && sessions.length > 0) {
        const latest = sessions[0];
        setActiveSessionId(latest.id);
        setActiveSessionTitle(latest.title);
        setChatMessages(latest.messages);
      }
    } catch (err) {
      console.warn("Failed to load chat history from IndexedDB:", err);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setErrorText(null);
      setActiveTab(errorMessage ? "debug" : "chat");
      const cachedDebug = code.trim()
        ? readPanelCache<AIDebugResult>(
            `debug|${code.trim()}|${(errorMessage || "").trim()}`
          )
        : null;
      setDebugResult(cachedDebug);
      reloadChatHistory();
    }
  }, [isOpen, errorMessage]);

  // Handler: Start a new conversation
  const handleNewChat = () => {
    const newId = `chat-${Date.now()}`;
    setActiveSessionId(newId);
    setActiveSessionTitle("New Conversation");
    setChatMessages([]);
    setShowHistoryDrawer(false);
  };

  // Handler: Select a previous conversation
  const handleSelectSession = (session: AiChatSession) => {
    setActiveSessionId(session.id);
    setActiveSessionTitle(session.title);
    setChatMessages(session.messages);
    setShowHistoryDrawer(false);
  };

  // Handler: Delete a conversation
  const handleDeleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await deleteAiChatSession(id);
      const remaining = savedSessions.filter((s) => s.id !== id);
      setSavedSessions(remaining);
      if (activeSessionId === id) {
        if (remaining.length > 0) {
          handleSelectSession(remaining[0]);
        } else {
          handleNewChat();
        }
      }
    } catch (err) {
      console.warn("Failed to delete session:", err);
    }
  };

  // Handler: Clear all conversation history
  const handleClearAllHistory = async () => {
    if (!confirmClearHistory) {
      setConfirmClearHistory(true);
      return;
    }
    try {
      await clearAllAiChatSessions();
      setSavedSessions([]);
      setConfirmClearHistory(false);
      handleNewChat();
    } catch (err) {
      console.warn("Failed to clear chat history:", err);
    }
  };

  // Handler: Copy chat transcript to clipboard
  const handleCopyChat = async () => {
    if (chatMessages.length === 0) return;
    const transcript = chatMessages
      .map((m) => `[${m.role === "user" ? "You" : "Milky"}]:\n${m.text}\n`)
      .join("\n---\n");
    const ok = await copyToClipboard(transcript);
    if (ok) {
      setCopiedChat(true);
      setTimeout(() => setCopiedChat(false), 2000);
    }
  };

  useEffect(() => {
    if (activeTab === "chat" && chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatMessages, activeTab]);

  // Trigger Debug Request (cache + local-first for standard Python errors)
  const handleDebug = async (forceCloud = false) => {
    if (!code || !code.trim()) {
      setDebugResult({
        bugType: "No Code Yet",
        explanation: "Write or paste some Python code in the editor first before running Debug.",
        fixedCode: "# Write your Python code here\nprint('Hello, Python!')",
        tips: ["Try writing a print() statement or opening a lesson exercise."],
      });
      return;
    }

    const cacheKey = `debug|${code.trim()}|${(errorMessage || "").trim()}`;
    if (!forceCloud) {
      const cached = readPanelCache<AIDebugResult>(cacheKey);
      if (cached) {
        setErrorText(null);
        setDebugResult(cached);
        return;
      }
      if (isStandardPythonError(errorMessage)) {
        const localResult = diagnoseOfflineError(code, errorMessage);
        setErrorText(
          "Solved instantly with the built-in Python diagnoser ($0 cloud cost). Use 'Ask Cloud AI' below if you still want a custom fix."
        );
        setDebugResult(localResult);
        return;
      }
    }

    if (activeAbortRef.current) activeAbortRef.current.abort();
    manualCancelRef.current = false;
    const controller = new AbortController();
    activeAbortRef.current = controller;
    setLoading(true);
    setErrorText(null);

    if (!navigator.onLine || !canUseDailyCloudAi()) {
      if (navigator.onLine && !canUseDailyCloudAi()) {
        setErrorText("Daily Cloud AI limit reached — showing built-in Python diagnoser.");
      }
      const localResult = diagnoseOfflineError(code, errorMessage);
      setDebugResult(localResult);
      setLoading(false);
      return;
    }

    try {
      recordCloudAiCall();
      const res = await fetchWithTimeout(getApiUrl("/api/ai/debug"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: clampClientText(code, 3000),
          errorMessage: clampClientText(errorMessage || "", 600),
        }),
        timeoutMs: 45000,
        externalSignal: controller.signal,
      });
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error("AI endpoint did not return JSON (check Cloudflare Workers API deployment or VITE_SERVER_URL).");
      }
      const data = await res.json();
      if (res.ok && data.success) {
        writePanelCache(cacheKey, data);
        setDebugResult(data);
      } else {
        setErrorText(data.error || "Cloud AI unavailable — showing on-device Python diagnoser.");
        setDebugResult(diagnoseOfflineError(code, errorMessage));
      }
    } catch (e: any) {
      if (manualCancelRef.current) return;
      setErrorText(e?.message || "Cloud AI unavailable — showing on-device Python diagnoser.");
      setDebugResult(diagnoseOfflineError(code, errorMessage));
    } finally {
      if (activeAbortRef.current === controller) activeAbortRef.current = null;
      setLoading(false);
    }
  };

  // Trigger Comment Addition (cached)
  const handleAddComments = async () => {
    const buildOfflineComments = () => {
      if (!code || !code.trim()) {
        return {
          commentedCode: "# Write Python code in the editor first",
          summary: "Editor is currently empty — add Python code to annotate.",
        };
      }
      const lines = code.split("\n");
      const commented = lines
        .map((l) => (l.trim() && !l.trim().startsWith("#") ? `  # Step: ${l.trim().slice(0, 36)}\n${l}` : l))
        .join("\n");
      return {
        commentedCode: commented,
        summary: "[Offline Mode] Added Python structural comments locally.",
      };
    };

    if (!code || !code.trim()) {
      setCommentResult(buildOfflineComments());
      return;
    }

    const cacheKey = `comments|${code.trim()}`;
    const cached = readPanelCache<AICommentResult>(cacheKey);
    if (cached) {
      setErrorText(null);
      setCommentResult(cached);
      return;
    }

    if (activeAbortRef.current) activeAbortRef.current.abort();
    manualCancelRef.current = false;
    const controller = new AbortController();
    activeAbortRef.current = controller;
    setLoading(true);
    setErrorText(null);

    if (!navigator.onLine || !canUseDailyCloudAi()) {
      if (navigator.onLine && !canUseDailyCloudAi()) {
        setErrorText("Daily Cloud AI limit reached — showing local structural comments.");
      }
      setCommentResult(buildOfflineComments());
      setLoading(false);
      return;
    }

    try {
      recordCloudAiCall();
      const res = await fetchWithTimeout(getApiUrl("/api/ai/add-comments"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: clampClientText(code, 3000) }),
        timeoutMs: 45000,
        externalSignal: controller.signal,
      });
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error("AI endpoint did not return JSON (check Cloudflare Workers API deployment or VITE_SERVER_URL).");
      }
      const data = await res.json();
      if (res.ok && data.success) {
        writePanelCache(cacheKey, data);
        setCommentResult(data);
      } else {
        setErrorText(data.error || "Cloud AI unavailable — showing offline structural comments.");
        setCommentResult(buildOfflineComments());
      }
    } catch (e: any) {
      if (manualCancelRef.current) return;
      setErrorText(e?.message || "Cloud AI unavailable — showing offline structural comments.");
      setCommentResult(buildOfflineComments());
    } finally {
      if (activeAbortRef.current === controller) activeAbortRef.current = null;
      setLoading(false);
    }
  };

  // Trigger Code Explanation (cached)
  const handleExplain = async () => {
    if (!code || !code.trim()) {
      setExplainResult({
        summary: "Write or paste Python code in the editor first to get a line-by-line breakdown.",
        steps: ["Open any lesson or type code in the playground editor."],
        concepts: ["Python Basics"],
      });
      return;
    }

    const cacheKey = `explain|${code.trim()}`;
    const cached = readPanelCache<AIExplainResult>(cacheKey);
    if (cached) {
      setErrorText(null);
      setExplainResult(cached);
      return;
    }

    if (activeAbortRef.current) activeAbortRef.current.abort();
    manualCancelRef.current = false;
    const controller = new AbortController();
    activeAbortRef.current = controller;
    setLoading(true);
    setErrorText(null);

    if (!navigator.onLine || !canUseDailyCloudAi()) {
      if (navigator.onLine && !canUseDailyCloudAi()) {
        setErrorText("Daily Cloud AI limit reached — showing built-in code breakdown.");
      }
      setExplainResult(explainOfflineCode(code));
      setLoading(false);
      return;
    }

    try {
      recordCloudAiCall();
      const res = await fetchWithTimeout(getApiUrl("/api/ai/explain"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: clampClientText(code, 3000) }),
        timeoutMs: 45000,
        externalSignal: controller.signal,
      });
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error("AI endpoint did not return JSON (check Cloudflare Workers API deployment or VITE_SERVER_URL).");
      }
      const data = await res.json();
      if (res.ok && data.success) {
        writePanelCache(cacheKey, data);
        setExplainResult(data);
      } else {
        setErrorText(data.error || "Cloud AI unavailable — showing offline explanation.");
        setExplainResult(explainOfflineCode(code));
      }
    } catch (e: any) {
      if (manualCancelRef.current) return;
      setErrorText(e?.message || "Cloud AI unavailable — showing offline explanation.");
      setExplainResult(explainOfflineCode(code));
    } finally {
      if (activeAbortRef.current === controller) activeAbortRef.current = null;
      setLoading(false);
    }
  };

  // Trigger Hint Generation (cached + free local starter hint if editor unchanged)
  const handleGetHint = async () => {
    const trimmedCode = (code || "").trim();
    const trimmedStarter = (lessonContext?.starterCode || "").trim();
    if (
      lessonContext?.title &&
      (!trimmedCode || (trimmedStarter && trimmedCode === trimmedStarter))
    ) {
      const objHint = lessonContext.learningObjectives?.[0]
        ? ` Focus first on: ${lessonContext.learningObjectives[0]}.`
        : "";
      setHintResult({
        hint: `For "${lessonContext.title}", start by updating or running the starter code toward the task goal: ${
          lessonContext.description || "check expected output carefully."
        }${objHint}`,
        conceptToReview: lessonContext.title,
      });
      return;
    }

    const cacheKey = `hint|${lessonContext?.title || ""}|${trimmedCode}`;
    const cached = readPanelCache<{ hint: string; conceptToReview?: string }>(cacheKey);
    if (cached) {
      setErrorText(null);
      setHintResult(cached);
      return;
    }

    if (activeAbortRef.current) activeAbortRef.current.abort();
    manualCancelRef.current = false;
    const controller = new AbortController();
    activeAbortRef.current = controller;
    setLoading(true);
    setErrorText(null);

    if (!navigator.onLine || !canUseDailyCloudAi()) {
      if (navigator.onLine && !canUseDailyCloudAi()) {
        setErrorText("Daily Cloud AI limit reached — showing local lesson hint.");
      }
      setHintResult({
        hint: `[Offline Hint] For ${lessonContext?.title || "this problem"}: Break the script into small steps. First, define the needed variables or inputs. Second, perform calculations with arithmetic/comparison operators. Third, use print() to verify intermediate values.`,
        conceptToReview: lessonContext?.title || "Python Basics",
      });
      setLoading(false);
      return;
    }

    try {
      recordCloudAiCall();
      const res = await fetchWithTimeout(getApiUrl("/api/ai/hint"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonTitle: lessonContext?.title,
          lessonDescription: lessonContext?.description,
          targetOutput: lessonContext?.expectedOutput,
          currentCode: clampClientText(code, 2000),
        }),
        timeoutMs: 45000,
        externalSignal: controller.signal,
      });
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error("AI endpoint did not return JSON (check Cloudflare Workers API deployment or VITE_SERVER_URL).");
      }
      const data = await res.json();
      if (res.ok && data.success) {
        writePanelCache(cacheKey, data);
        setHintResult(data);
      } else {
        setErrorText(data.error || "Cloud AI unavailable — showing offline hint.");
        setHintResult({
          hint: `[Offline Hint] Check the lesson description carefully: ${lessonContext?.description || "verify expected output"}.`,
          conceptToReview: lessonContext?.title || "Python Basics",
        });
      }
    } catch (e: any) {
      if (manualCancelRef.current) return;
      setErrorText(e?.message || "Cloud AI unavailable — showing offline hint.");
      setHintResult({
        hint: `[Offline Hint] Check the lesson description carefully: ${lessonContext?.description || "verify expected output"}.`,
        conceptToReview: lessonContext?.title || "Python Basics",
      });
    } finally {
      if (activeAbortRef.current === controller) activeAbortRef.current = null;
      setLoading(false);
    }
  };

  const sendChatPrompt = async (promptText: string) => {
    const userText = promptText.trim();
    if (!userText || loading) return;

    const newMessages = [...chatMessages, { role: "user" as const, text: userText }];
    setChatMessages(newMessages);
    setChatInput("");
    setErrorText(null);

    // Zero-cost local short-circuit for pure conversational greetings / thanks
    if (/^(hi|hello|hey|yo|sup|good morning|good afternoon|good evening|thanks|thank you|ok|okay)[!.?]*$/i.test(userText)) {
      const greetingReply = lessonContext?.title
        ? `Hey! Ready to help with **${lessonContext.title}**. Ask a question about this lesson or paste/run your code anytime.`
        : "Hey! Ask me any Python question, share a bug, or ask what lesson to study next.";
      const finalMessages = [...newMessages, { role: "model" as const, text: greetingReply }];
      setChatMessages(finalMessages);
      return;
    }

    if (activeAbortRef.current) activeAbortRef.current.abort();
    manualCancelRef.current = false;
    const controller = new AbortController();
    activeAbortRef.current = controller;
    setLoading(true);

    if (!navigator.onLine || !canUseDailyCloudAi()) {
      if (navigator.onLine && !canUseDailyCloudAi()) {
        setErrorText("Daily Cloud AI limit reached — using on-device Python guide.");
      }
      const offlineReply = getOfflineChatReply(userText, code, lessonContext);
      const finalMessages = [...newMessages, { role: "model" as const, text: offlineReply }];
      setChatMessages(finalMessages);

      let updatedTitle = activeSessionTitle;
      if (updatedTitle === "New Conversation" || !updatedTitle) {
        updatedTitle = userText.length > 36 ? userText.substring(0, 36) + "..." : userText;
        setActiveSessionTitle(updatedTitle);
      }

      saveAiChatSession({
        id: activeSessionId,
        title: updatedTitle,
        timestamp: Date.now(),
        messages: finalMessages,
        codeSnippet: code ? code.substring(0, 300) : undefined,
      }).catch(() => {});

      setLoading(false);
      return;
    }

    try {
      recordCloudAiCall();
      const recentWindow = newMessages.slice(-6).map((m, idx, arr) => ({
        role: m.role,
        text: clampClientText(m.text, idx === arr.length - 1 ? 1200 : 750),
      }));
      const res = await fetchWithTimeout(getApiUrl("/api/ai/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: recentWindow,
          code: clampClientText(code, 2200),
          lessonContext,
        }),
        timeoutMs: 45000,
        externalSignal: controller.signal,
      });
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error("AI endpoint did not return JSON (check Cloudflare Workers API deployment or VITE_SERVER_URL).");
      }
      const data = await res.json();
      const replyText = data.text || data.reply;
      if (res.ok && data.success && replyText) {
        const finalMessages = [...newMessages, { role: "model" as const, text: replyText }];
        setChatMessages(finalMessages);

        let updatedTitle = activeSessionTitle;
        if (updatedTitle === "New Conversation" || !updatedTitle) {
          updatedTitle = userText.length > 36 ? userText.substring(0, 36) + "..." : userText;
          setActiveSessionTitle(updatedTitle);
        }

        saveAiChatSession({
          id: activeSessionId,
          title: updatedTitle,
          timestamp: Date.now(),
          messages: finalMessages,
          codeSnippet: code ? code.substring(0, 300) : undefined,
        }).then(() => {
          reloadChatHistory();
        }).catch((err) => console.warn("Failed to save chat to IndexedDB:", err));
      } else {
        setErrorText(data.error || "Cloud AI unavailable — using on-device Python guide.");
        const offlineReply = getOfflineChatReply(userText, code, lessonContext);
        setChatMessages([...newMessages, { role: "model" as const, text: offlineReply }]);
      }
    } catch (e: any) {
      if (manualCancelRef.current) return;
      setErrorText(e?.message || "Cloud AI unavailable — using on-device Python guide.");
      const offlineReply = getOfflineChatReply(userText, code, lessonContext);
      setChatMessages([...newMessages, { role: "model" as const, text: offlineReply }]);
    } finally {
      if (activeAbortRef.current === controller) activeAbortRef.current = null;
      setLoading(false);
    }
  };

  const handleChatSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    await sendChatPrompt(chatInput);
  };

  const applyCodeFix = (newCode: string) => {
    onApplyCode(newCode);
    setApplied(true);
    setTimeout(() => {
      setApplied(false);
      onClose();
    }, 1000);
  };

  if (!isOpen) return null;

  const askFollowUpInChat = (prompt: string) => {
    setShowHistoryDrawer(false);
    setActiveTab("chat");
    sendChatPrompt(prompt);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[2px] flex justify-end"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`w-full ${
          expandedWidth ? "sm:max-w-2xl" : "sm:max-w-lg"
        } bg-white dark:bg-[#08090D] border-l border-slate-200 dark:border-[#252933] h-[100dvh] flex flex-col shadow-2xl overflow-hidden transition-[max-width] duration-200 pb-[env(safe-area-inset-bottom)]`}
      >
        {/* Panel Header */}
        <div className="px-3.5 py-3 border-b border-slate-200 dark:border-[#252933] bg-slate-100 dark:bg-[#15171E] flex items-center justify-between gap-2 shrink-0 select-none">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="p-1.5 rounded-lg bg-blue-600 dark:bg-[#8BBEFF] text-white dark:text-[#08090D] shadow-xs shrink-0">
              <MessageSquare className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-slate-900 dark:text-[#F3F4F6] truncate">
                Code Help
              </h2>
              <p className="text-[11px] text-slate-500 dark:text-[#BFC4CE] truncate">
                Fix errors, explain code, or ask questions
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setExpandedWidth((prev) => !prev)}
              className="hidden sm:flex items-center justify-center p-2 rounded-lg hover:bg-slate-200 dark:hover:bg-[#252933] text-slate-500 dark:text-[#BFC4CE] hover:text-slate-900 dark:hover:text-white cursor-pointer touch-target"
              title={expandedWidth ? "Use compact width" : "Widen panel"}
              aria-label={expandedWidth ? "Use compact width" : "Widen panel"}
            >
              {expandedWidth ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-slate-200 dark:hover:bg-[#252933] text-slate-500 dark:text-[#BFC4CE] hover:text-slate-900 dark:hover:text-white cursor-pointer touch-target"
              title="Close panel (Esc)"
              aria-label="Close Code Help panel"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Offline Mode Indicator Banner */}
        {!isOnline && (
          <div className="bg-amber-500/10 dark:bg-amber-500/15 border-b border-amber-500/20 px-3.5 py-1.5 flex items-center justify-between text-xs text-amber-800 dark:text-amber-300 font-medium shrink-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <WifiOff className="w-3.5 h-3.5 text-amber-500 shrink-0" />
              <span className="truncate">Offline mode: built-in Python guide active</span>
            </div>
            <span className="text-[10px] font-mono font-semibold shrink-0">Offline</span>
          </div>
        )}

        {/* Feature Navigation Tabs */}
        <div className="grid grid-cols-5 p-1.5 gap-1 bg-slate-50 dark:bg-[#15171E] border-b border-slate-200 dark:border-[#252933] text-[11px] font-semibold shrink-0 select-none">
          <button
            type="button"
            onClick={() => setActiveTab("chat")}
            className={`min-h-[42px] py-1.5 flex flex-col items-center justify-center gap-0.5 rounded-lg transition-all cursor-pointer ${
              activeTab === "chat"
                ? "bg-blue-600 dark:bg-[#8BBEFF] text-white dark:text-[#08090D] shadow-xs font-bold"
                : "text-slate-600 dark:text-[#BFC4CE] hover:bg-slate-200 dark:hover:bg-[#252933]"
            }`}
          >
            <MessageCircle className="w-3.5 h-3.5" />
            <span>Chat</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("debug")}
            className={`min-h-[42px] py-1.5 flex flex-col items-center justify-center gap-0.5 rounded-lg transition-all cursor-pointer relative ${
              activeTab === "debug"
                ? "bg-blue-600 dark:bg-[#8BBEFF] text-white dark:text-[#08090D] shadow-xs font-bold"
                : "text-slate-600 dark:text-[#BFC4CE] hover:bg-slate-200 dark:hover:bg-[#252933]"
            }`}
          >
            <Bug className="w-3.5 h-3.5" />
            <span>Debug</span>
            {errorMessage && activeTab !== "debug" && (
              <span className="absolute top-1.5 right-2 w-1.5 h-1.5 rounded-full bg-rose-500" aria-hidden="true" />
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("comments")}
            className={`min-h-[42px] py-1.5 flex flex-col items-center justify-center gap-0.5 rounded-lg transition-all cursor-pointer ${
              activeTab === "comments"
                ? "bg-blue-600 dark:bg-[#8BBEFF] text-white dark:text-[#08090D] shadow-xs font-bold"
                : "text-slate-600 dark:text-[#BFC4CE] hover:bg-slate-200 dark:hover:bg-[#252933]"
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>Comments</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("explain")}
            className={`min-h-[42px] py-1.5 flex flex-col items-center justify-center gap-0.5 rounded-lg transition-all cursor-pointer ${
              activeTab === "explain"
                ? "bg-blue-600 dark:bg-[#8BBEFF] text-white dark:text-[#08090D] shadow-xs font-bold"
                : "text-slate-600 dark:text-[#BFC4CE] hover:bg-slate-200 dark:hover:bg-[#252933]"
            }`}
          >
            <HelpCircle className="w-3.5 h-3.5" />
            <span>Explain</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("hint")}
            className={`min-h-[42px] py-1.5 flex flex-col items-center justify-center gap-0.5 rounded-lg transition-all cursor-pointer ${
              activeTab === "hint"
                ? "bg-blue-600 dark:bg-[#8BBEFF] text-white dark:text-[#08090D] shadow-xs font-bold"
                : "text-slate-600 dark:text-[#BFC4CE] hover:bg-slate-200 dark:hover:bg-[#252933]"
            }`}
          >
            <Lightbulb className="w-3.5 h-3.5" />
            <span>Hint</span>
          </button>
        </div>

        {/* Collapsible Attached Code & Error Bar */}
        {(attachedCodeLines > 0 || errorMessage) && (
          <div className="border-b border-slate-200 dark:border-[#252933] bg-slate-50/70 dark:bg-[#11131A] px-3.5 py-2 shrink-0 space-y-2">
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <button
                type="button"
                onClick={() => setShowCodePreview((prev) => !prev)}
                className="flex items-center gap-1.5 font-semibold text-slate-700 dark:text-[#BFC4CE] hover:text-blue-600 dark:hover:text-[#8BBEFF] cursor-pointer min-w-0"
              >
                <Code2 className="w-3.5 h-3.5 text-blue-600 dark:text-[#8BBEFF] shrink-0" />
                <span className="truncate">
                  {attachedCodeLines > 0
                    ? `Attached code · ${attachedCodeLines} line${attachedCodeLines === 1 ? "" : "s"}`
                    : "Error details attached"}
                </span>
                <ChevronDown
                  className={`w-3.5 h-3.5 shrink-0 transition-transform ${
                    showCodePreview ? "rotate-180" : ""
                  }`}
                />
              </button>

              <div className="flex items-center gap-2 shrink-0">
                {errorMessage && (
                  <button
                    type="button"
                    onClick={() => setActiveTab("debug")}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-600 dark:text-rose-400 hover:underline cursor-pointer"
                  >
                    <AlertCircle className="w-3 h-3" />
                    <span>View error</span>
                  </button>
                )}
              </div>
            </div>

            {showCodePreview && (
              <div className="space-y-2">
                {attachedCodeLines > 0 && (
                  <div className="rounded-xl border border-slate-200 dark:border-[#252933] bg-white dark:bg-[#050608] overflow-hidden">
                    <div className="flex items-center justify-between px-2.5 py-1 border-b border-slate-200 dark:border-[#252933] bg-slate-100/70 dark:bg-[#15171E] text-[10px] font-mono text-slate-500 dark:text-[#BFC4CE]">
                      <span>Python snippet</span>
                      <CopyCodeButton code={code} compact />
                    </div>
                    <pre className="p-2.5 max-h-36 overflow-auto font-mono text-[11px] leading-relaxed text-slate-800 dark:text-[#F3F4F6]">
                      <code
                        dangerouslySetInnerHTML={{
                          __html: highlightPython(code),
                        }}
                      />
                    </pre>
                  </div>
                )}
                {errorMessage && (
                  <div className="p-2 rounded-lg bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800/50 font-mono text-[11px] text-rose-700 dark:text-rose-300 max-h-24 overflow-y-auto whitespace-pre-wrap">
                    {errorMessage.slice(0, 400)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Active Curriculum Lesson or Quiz Context Banner */}
        {(lessonContext?.title || lessonContext?.quizQuestion) && (
          <div className="bg-blue-50 dark:bg-blue-950/40 border-b border-blue-200 dark:border-blue-800/60 px-3.5 py-2.5 space-y-2 shrink-0">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-bold text-blue-700 dark:text-blue-300 flex items-center gap-1.5 min-w-0 truncate">
                <Code2 className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                <span className="truncate">
                  {lessonContext.quizQuestion ? "Quiz Help: " : "Lesson: "}
                  {lessonContext.title}
                </span>
              </span>
              <div className="flex items-center gap-1.5 shrink-0">
                {lessonContext.learningObjectives && lessonContext.learningObjectives.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowObjectives((prev) => !prev)}
                    className="flex items-center gap-1 text-[10px] font-bold text-blue-700 dark:text-blue-300 hover:underline cursor-pointer"
                  >
                    <span>Objectives ({lessonContext.learningObjectives.length})</span>
                    <ChevronDown className={`w-3 h-3 transition-transform ${showObjectives ? "rotate-180" : ""}`} />
                  </button>
                )}
              </div>
            </div>

            {lessonContext.quizQuestion ? (
              <div className="rounded-lg bg-white/80 dark:bg-[#08090D]/80 border border-blue-200/80 dark:border-blue-900/60 p-2.5 text-[11px] space-y-1.5">
                <p className="font-semibold text-slate-800 dark:text-slate-100 leading-snug">
                  {lessonContext.quizQuestion.question}
                </p>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                  {lessonContext.quizQuestion.userChoice !== undefined && (
                    <span className={lessonContext.quizQuestion.isCorrect ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}>
                      <strong>Your pick:</strong> {lessonContext.quizQuestion.userChoice}
                    </span>
                  )}
                  <span className="text-emerald-700 dark:text-emerald-300">
                    <strong>Answer:</strong> {lessonContext.quizQuestion.correctAnswer}
                  </span>
                </div>
                {!showHistoryDrawer && activeTab === "chat" && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {[
                      lessonContext.quizQuestion.isCorrect
                        ? `Explain why "${lessonContext.quizQuestion.correctAnswer}" works here`
                        : `Why is "${lessonContext.quizQuestion.correctAnswer}" right instead of "${lessonContext.quizQuestion.userChoice}"?`,
                      "Walk through what this code runs line by line",
                      "Show me a fixed version and a similar example",
                    ].map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        disabled={loading}
                        onClick={() => sendChatPrompt(prompt)}
                        className="px-2 py-1 rounded-md bg-blue-100/80 hover:bg-blue-200/80 dark:bg-[#8BBEFF]/15 dark:hover:bg-[#8BBEFF]/25 text-blue-800 dark:text-[#8BBEFF] font-semibold text-[10px] transition-colors cursor-pointer disabled:opacity-50 text-left"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              lessonContext.description && (
                <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-normal line-clamp-2">
                  {lessonContext.description}
                </p>
              )
            )}

            {showObjectives && lessonContext.learningObjectives && lessonContext.learningObjectives.length > 0 && (
              <ul className="pt-1 border-t border-blue-200/70 dark:border-blue-800/50 space-y-0.5 list-disc list-inside text-[11px] text-slate-700 dark:text-slate-300">
                {lessonContext.learningObjectives.map((obj, idx) => (
                  <li key={idx}>{obj}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Notice Banner (API fallback notice, etc.) */}
        {errorText && (
          <div className="mx-3.5 mt-3 p-2.5 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 rounded-lg text-amber-800 dark:text-amber-300 text-xs flex items-start justify-between gap-2 shrink-0">
            <span className="font-mono leading-relaxed">{errorText}</span>
            <button
              type="button"
              onClick={() => setErrorText(null)}
              className="p-0.5 rounded hover:bg-amber-200/50 dark:hover:bg-amber-800/40 shrink-0 cursor-pointer"
              aria-label="Dismiss notice"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Main Content Body (Independent scroll per mode; chat keeps composer pinned) */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {/* TAB 0: CHAT */}
          {activeTab === "chat" && (
            <div className="flex-1 min-h-0 flex flex-col">
              {/* Chat Sub-Header / History Toolbar */}
              <div className="px-3.5 pt-3 pb-2 shrink-0">
                <div className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-100 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700/80 rounded-xl text-xs">
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <MessageCircle className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                    <span className="font-semibold text-slate-800 dark:text-slate-200 truncate">
                      {showHistoryDrawer
                        ? "Chat History"
                        : activeSessionTitle || "Code Help"}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {/* New Chat Button */}
                    <button
                      type="button"
                      onClick={handleNewChat}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-700 hover:bg-slate-50 dark:hover:bg-slate-600 border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200 text-[11px] font-bold shadow-2xs transition-colors cursor-pointer"
                      title="Start a new chat conversation"
                    >
                      <PlusCircle className="w-3.5 h-3.5 text-blue-500" />
                      <span className="hidden xs:inline">New</span>
                    </button>

                    {/* History Toggle Button */}
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmClearHistory(false);
                        setShowHistoryDrawer(!showHistoryDrawer);
                      }}
                      className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-[11px] font-bold shadow-2xs transition-colors cursor-pointer ${
                        showHistoryDrawer
                          ? "bg-blue-600 border-blue-600 text-white"
                          : "bg-white dark:bg-slate-700 hover:bg-slate-50 dark:hover:bg-slate-600 border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200"
                      }`}
                      title="View previous chats"
                    >
                      <History className="w-3.5 h-3.5" />
                      <span>History</span>
                      {savedSessions.length > 0 && (
                        <span className="tabular-nums opacity-80">
                          ({savedSessions.length})
                        </span>
                      )}
                    </button>

                    {/* Copy Chat */}
                    {chatMessages.length > 0 && !showHistoryDrawer && (
                      <button
                        type="button"
                        onClick={handleCopyChat}
                        className="p-1.5 rounded-lg bg-white dark:bg-slate-700 hover:bg-slate-50 dark:hover:bg-slate-600 border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 transition-colors cursor-pointer"
                        title="Copy chat transcript"
                        aria-label="Copy chat transcript"
                      >
                        {copiedChat ? (
                          <Check className="w-3.5 h-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* View 1: History Drawer / List of Saved Sessions */}
              {showHistoryDrawer ? (
                <div className="flex-1 min-h-0 flex flex-col px-3.5 pb-3.5 space-y-3">
                  {/* Search bar */}
                  <div className="relative shrink-0">
                    <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
                    <input
                      type="text"
                      value={historySearchQuery}
                      onChange={(e) => setHistorySearchQuery(e.target.value)}
                      placeholder="Search past conversations..."
                      className="w-full pl-8 pr-8 py-2 bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-xl text-xs text-slate-800 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-blue-500"
                    />
                    {historySearchQuery && (
                      <button
                        type="button"
                        onClick={() => setHistorySearchQuery("")}
                        className="absolute right-2.5 top-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-0.5 cursor-pointer"
                        aria-label="Clear search"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Sessions List */}
                  <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
                    {savedSessions.length === 0 ? (
                      <div className="text-center py-10 text-slate-400 dark:text-slate-500 text-xs">
                        <History className="w-8 h-8 mx-auto mb-2 opacity-40" />
                        <p>No saved chat sessions yet.</p>
                        <p className="text-[11px] mt-1 text-slate-400">
                          Ask a question and your conversations will appear here.
                        </p>
                      </div>
                    ) : (
                      savedSessions
                        .filter(
                          (s) =>
                            !historySearchQuery ||
                            s.title.toLowerCase().includes(historySearchQuery.toLowerCase()) ||
                            s.messages.some((m) =>
                              m.text.toLowerCase().includes(historySearchQuery.toLowerCase())
                            )
                        )
                        .map((session) => {
                          const isActive = session.id === activeSessionId;
                          const lastMsg =
                            session.messages.length > 0
                              ? session.messages[session.messages.length - 1].text
                              : "Empty conversation";

                          return (
                            <div
                              key={session.id}
                              onClick={() => handleSelectSession(session)}
                              className={`p-3 rounded-xl border text-xs transition-all cursor-pointer space-y-1.5 ${
                                isActive
                                  ? "bg-blue-50 dark:bg-blue-950/50 border-blue-300 dark:border-blue-800"
                                  : "bg-white dark:bg-slate-800/70 border-slate-200 dark:border-slate-700/80 hover:border-slate-300 dark:hover:border-slate-600"
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-bold text-slate-800 dark:text-slate-200 truncate flex-1">
                                  {session.title}
                                </span>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <span className="text-[10px] text-slate-400 flex items-center gap-0.5">
                                    <Clock className="w-2.5 h-2.5" />
                                    {new Date(session.timestamp).toLocaleDateString(undefined, {
                                      month: "short",
                                      day: "numeric",
                                    })}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={(e) => handleDeleteSession(session.id, e)}
                                    className="p-1.5 rounded text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/50 transition-colors cursor-pointer"
                                    title="Delete session"
                                    aria-label="Delete chat session"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>

                              <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2">
                                {lastMsg}
                              </p>

                              <div className="flex items-center justify-between text-[10px] text-slate-400 pt-0.5">
                                <span>{session.messages.length} messages</span>
                                <span className="text-blue-600 dark:text-blue-400 font-semibold">
                                  {isActive ? "Currently Active" : "Tap to Resume"}
                                </span>
                              </div>
                            </div>
                          );
                        })
                    )}
                  </div>

                  {/* History Footer Actions */}
                  <div className="flex items-center justify-between pt-2.5 border-t border-slate-200 dark:border-slate-800 gap-2 shrink-0">
                    {savedSessions.length > 0 && (
                      confirmClearHistory ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={handleClearAllHistory}
                            className="px-2.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-[11px] font-bold transition-colors cursor-pointer"
                          >
                            Confirm Clear All?
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmClearHistory(false)}
                            className="px-2.5 py-1.5 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-[11px] font-semibold cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={handleClearAllHistory}
                          className="text-[11px] text-rose-600 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300 font-bold transition-colors cursor-pointer py-1"
                        >
                          Clear All History
                        </button>
                      )
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmClearHistory(false);
                        setShowHistoryDrawer(false);
                      }}
                      className="ml-auto px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-xs font-bold transition-colors cursor-pointer"
                    >
                      Back to Chat
                    </button>
                  </div>
                </div>
              ) : (
                /* View 2: Scrollable Chat Messages + Pinned Bottom Composer */
                <>
                  <div className="flex-1 min-h-0 overflow-y-auto px-3.5 py-2 space-y-3">
                    {chatMessages.length === 0 ? (
                      <div className="text-center text-slate-500 dark:text-slate-400 text-xs py-5 space-y-4">
                        <div>
                          <MessageCircle className="w-8 h-8 mx-auto mb-2 opacity-50 text-blue-500" />
                          <p className="font-semibold text-slate-700 dark:text-slate-200">
                            {lessonContext?.title ? `Working on "${lessonContext.title}"?` : "Ask anything about Python or your code"}
                          </p>
                          <p className="text-[11px] text-slate-400 mt-1">
                            {lessonContext?.title
                              ? "I can walk through the lesson goals, explain code line by line, or check your solution."
                              : "Ask a coding question, share a bug, or pick one of the prompts below."}
                          </p>
                        </div>
                        <div className="flex flex-wrap justify-center gap-2 px-1">
                          {(errorMessage
                            ? [
                                "Explain what this error means and how to fix it",
                                "Walk through what my code runs line by line",
                                "Show a corrected version of my script",
                              ]
                            : lessonContext?.title
                            ? [
                                `Walk me through the goals of "${lessonContext.title}"`,
                                "How do I start this lesson exercise?",
                                "Check my current code against lesson goals",
                                "Give me a simple step-by-step breakdown",
                              ]
                            : [
                                "Teach me a topic from the Python curriculum",
                                "Explain what my code does step by step",
                                "Check my code for bugs or edge cases",
                                "What should I practice next?",
                              ]
                          ).map((starter) => (
                            <button
                              key={starter}
                              type="button"
                              onClick={() => sendChatPrompt(starter)}
                              className="min-h-[38px] px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-blue-50 dark:bg-slate-800/80 dark:hover:bg-blue-950/50 border border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-700 text-[11px] font-medium text-slate-700 dark:text-slate-200 transition-colors cursor-pointer text-left"
                            >
                              {starter}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      chatMessages.map((msg, idx) => (
                        <div
                          key={idx}
                          className={`flex flex-col max-w-[92%] p-3 rounded-2xl text-xs ${
                            msg.role === "user"
                              ? "bg-blue-600 text-white self-end ml-auto rounded-tr-sm"
                              : "bg-slate-100 dark:bg-slate-800/90 text-slate-800 dark:text-slate-200 self-start mr-auto rounded-tl-sm border border-slate-200 dark:border-slate-700"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3 mb-1">
                            <span className="font-bold text-[10px] opacity-75 uppercase tracking-wider">
                              {msg.role === "user" ? "You" : "Milky"}
                            </span>
                            {msg.role === "model" && (
                              <CopyCodeButton code={msg.text} compact label="Copy reply" />
                            )}
                          </div>
                          <div className="prose prose-sm dark:prose-invert max-w-none prose-pre:bg-slate-900 prose-pre:border prose-pre:border-slate-700 prose-p:leading-relaxed break-words">
                            <ReactMarkdown
                              components={{
                                code({ node, inline, className, children, ...props }: any) {
                                  const match = /language-(\w+)/.exec(className || "");
                                  const codeString = String(children).replace(/\n$/, "");
                                  if (!inline && match && match[1] === "python") {
                                    return (
                                      <div className="mt-2 space-y-1.5">
                                        <pre className={className} {...props}>
                                          <code>{children}</code>
                                        </pre>
                                        <div className="flex items-center gap-1.5">
                                          <CopyCodeButton code={codeString} compact />
                                          <button
                                            type="button"
                                            onClick={() => applyCodeFix(codeString)}
                                            className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white font-sans text-[10px] font-bold flex items-center gap-1 flex-1 justify-center cursor-pointer"
                                          >
                                            {applied ? (
                                              <Check className="w-3 h-3" />
                                            ) : (
                                              <Code2 className="w-3 h-3" />
                                            )}
                                            <span>{applied ? "Applied" : "Apply Code"}</span>
                                          </button>
                                        </div>
                                      </div>
                                    );
                                  }
                                  return (
                                    <code className={className} {...props}>
                                      {children}
                                    </code>
                                  );
                                },
                              }}
                            >
                              {msg.text}
                            </ReactMarkdown>
                          </div>
                        </div>
                      ))
                    )}
                    {loading && (
                      <div className="flex items-center justify-between gap-2 text-slate-500 text-xs p-2.5 rounded-lg bg-slate-100/70 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/70">
                        <div className="flex items-center gap-2">
                          <RotateCcw className="w-3.5 h-3.5 animate-spin text-blue-500" />
                          <span>Writing answer...</span>
                        </div>
                        <button
                          type="button"
                          onClick={handleCancelAiRequest}
                          className="px-2.5 py-1 rounded-md bg-rose-600/15 hover:bg-rose-600/25 text-rose-600 dark:text-rose-400 text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-colors"
                        >
                          <Square className="w-2.5 h-2.5 fill-current" />
                          <span>Cancel</span>
                        </button>
                      </div>
                    )}
                    <div ref={chatEndRef} />
                  </div>

                  {/* Pinned Chat Input Form */}
                  <div className="p-3 pt-2 border-t border-slate-200 dark:border-[#252933] bg-white dark:bg-[#08090D] shrink-0">
                    <form
                      onSubmit={handleChatSubmit}
                      className="flex items-end gap-2 bg-slate-50 dark:bg-slate-800/60 p-2 rounded-xl border border-slate-200 dark:border-slate-700"
                    >
                      <textarea
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        placeholder="Ask about your code or a lesson..."
                        className="flex-1 bg-transparent border-none focus:outline-none focus:ring-0 resize-none text-xs sm:text-xs text-slate-800 dark:text-slate-200 min-h-[40px] max-h-[120px] py-1"
                        rows={2}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            handleChatSubmit();
                          }
                        }}
                      />
                      {loading ? (
                        <button
                          type="button"
                          onClick={handleCancelAiRequest}
                          className="min-w-[40px] min-h-[40px] p-2.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white transition-colors cursor-pointer shrink-0 flex items-center justify-center"
                          title="Cancel reply"
                          aria-label="Cancel reply"
                        >
                          <Square className="w-4 h-4 fill-white" />
                        </button>
                      ) : (
                        <button
                          type="submit"
                          disabled={!chatInput.trim()}
                          className="min-w-[40px] min-h-[40px] p-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:opacity-50 text-white transition-colors cursor-pointer shrink-0 flex items-center justify-center"
                          title="Send message"
                          aria-label="Send message"
                        >
                          <Send className="w-4 h-4" />
                        </button>
                      )}
                    </form>
                  </div>
                </>
              )}
            </div>
          )}

          {/* TAB 1: DEBUGGER */}
          {activeTab === "debug" && (
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
              <div className="p-3.5 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700 text-xs space-y-2.5">
                <div className="text-slate-800 dark:text-slate-200 font-bold">Inspect & Fix Code Bug</div>
                <p className="text-slate-500 dark:text-slate-400 text-[11px] leading-relaxed">
                  Checks your Python code and error message to show what went wrong and how to fix it.
                </p>

                {errorMessage && (
                  <div className="p-2.5 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/60 rounded-lg font-mono text-[11px] text-rose-700 dark:text-rose-300 max-h-32 overflow-y-auto whitespace-pre-wrap">
                    {errorMessage.slice(0, 400)}
                  </div>
                )}

                {loading ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled
                      className="flex-1 min-h-[42px] py-2 bg-blue-500/80 text-white rounded-lg font-bold flex items-center justify-center gap-2"
                    >
                      <RotateCcw className="w-4 h-4 animate-spin" />
                      <span>Checking code...</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelAiRequest}
                      className="px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg font-bold flex items-center gap-1 cursor-pointer transition-colors"
                    >
                      <Square className="w-3.5 h-3.5 fill-white" />
                      <span>Cancel</span>
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => handleDebug(false)}
                      className="flex-1 min-h-[44px] py-2 px-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold flex items-center justify-center gap-2 cursor-pointer transition-colors"
                    >
                      <Bug className="w-4 h-4" />
                      <span>Find Fix</span>
                    </button>
                    {isStandardPythonError(errorMessage) && (
                      <button
                        type="button"
                        onClick={() => handleDebug(true)}
                        className="min-h-[44px] py-2 px-3 bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-800 dark:text-slate-100 rounded-lg font-semibold cursor-pointer transition-colors"
                      >
                        Ask Cloud AI
                      </button>
                    )}
                  </div>
                )}
              </div>

              {debugResult && (
                <div className="space-y-3">
                  <div className="p-3.5 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/60 rounded-xl text-xs space-y-2">
                    <div className="text-[11px] font-mono font-bold text-blue-800 dark:text-[#8BBEFF] uppercase tracking-wider">
                      Bug type · {debugResult.bugType}
                    </div>
                    <p className="text-slate-800 dark:text-slate-200 leading-relaxed">
                      {debugResult.explanation}
                    </p>

                    {debugResult.tips && debugResult.tips.length > 0 && (
                      <ul className="list-disc list-inside text-slate-600 dark:text-slate-400 text-[11px] space-y-1 pt-1">
                        {debugResult.tips.map((tip, idx) => (
                          <li key={idx}>{tip}</li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* Fixed Code Display with Prism Syntax Highlighting + Copy */}
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap justify-between items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                      <span className="font-mono font-semibold">Fixed Python Code</span>
                      <div className="flex items-center gap-1.5">
                        <CopyCodeButton code={debugResult.fixedCode} compact />
                        <button
                          type="button"
                          onClick={() => applyCodeFix(debugResult.fixedCode)}
                          className="px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-sans text-xs font-bold flex items-center gap-1 shadow-xs cursor-pointer"
                        >
                          {applied ? <Check className="w-3.5 h-3.5" /> : <Code2 className="w-3.5 h-3.5" />}
                          <span>{applied ? "Applied!" : "Apply Fix"}</span>
                        </button>
                      </div>
                    </div>
                    <pre className="p-3 bg-slate-50 dark:bg-[#050608] border border-slate-200 dark:border-[#252933] rounded-xl font-mono text-xs overflow-x-auto leading-relaxed text-slate-800 dark:text-[#F3F4F6]">
                      <code
                        dangerouslySetInnerHTML={{
                          __html: highlightPython(debugResult.fixedCode),
                        }}
                      />
                    </pre>
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      askFollowUpInChat(
                        `Can you explain the ${debugResult.bugType} fix you suggested in simple steps?`
                      )
                    }
                    className="w-full py-2 px-3 rounded-lg border border-slate-200 dark:border-[#252933] hover:bg-slate-50 dark:hover:bg-[#15171E] text-xs font-semibold text-blue-600 dark:text-[#8BBEFF] flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <MessageCircle className="w-3.5 h-3.5" />
                    <span>Ask a follow-up question in Chat</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: GUIDED COMMENTS */}
          {activeTab === "comments" && (
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
              <div className="p-3.5 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700 text-xs space-y-2.5">
                <div className="text-slate-800 dark:text-slate-200 font-bold">Add Code Comments</div>
                <p className="text-slate-500 dark:text-slate-400 text-[11px] leading-relaxed">
                  Adds short <span className="font-mono text-blue-600 dark:text-blue-400"># comments</span> above key lines to explain what your script does.
                </p>

                {loading ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled
                      className="flex-1 min-h-[42px] py-2 bg-blue-500/80 text-white rounded-lg font-bold flex items-center justify-center gap-2"
                    >
                      <RotateCcw className="w-4 h-4 animate-spin" />
                      <span>Adding comments...</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelAiRequest}
                      className="px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg font-bold flex items-center gap-1 cursor-pointer transition-colors"
                    >
                      <Square className="w-3.5 h-3.5 fill-white" />
                      <span>Cancel</span>
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={handleAddComments}
                    className="w-full min-h-[44px] py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold flex items-center justify-center gap-2 cursor-pointer transition-colors"
                  >
                    <MessageSquare className="w-4 h-4" />
                    <span>Add Comments</span>
                  </button>
                )}
              </div>

              {commentResult && (
                <div className="space-y-3">
                  <div className="p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 rounded-lg text-xs text-emerald-800 dark:text-emerald-300 leading-relaxed">
                    {commentResult.summary}
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex flex-wrap justify-between items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                      <span className="font-mono font-semibold">Commented Python Code</span>
                      <div className="flex items-center gap-1.5">
                        <CopyCodeButton code={commentResult.commentedCode} compact />
                        <button
                          type="button"
                          onClick={() => applyCodeFix(commentResult.commentedCode)}
                          className="px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-sans text-xs font-bold flex items-center gap-1 cursor-pointer"
                        >
                          {applied ? <Check className="w-3.5 h-3.5" /> : <Code2 className="w-3.5 h-3.5" />}
                          <span>{applied ? "Applied!" : "Apply Comments"}</span>
                        </button>
                      </div>
                    </div>
                    <pre className="p-3 bg-slate-50 dark:bg-[#050608] border border-slate-200 dark:border-[#252933] rounded-xl font-mono text-xs text-slate-800 dark:text-[#F3F4F6] overflow-x-auto leading-relaxed">
                      <code
                        dangerouslySetInnerHTML={{
                          __html: highlightPython(commentResult.commentedCode),
                        }}
                      />
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: CODE EXPLAINER */}
          {activeTab === "explain" && (
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
              <div className="p-3.5 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700 text-xs space-y-2.5">
                <div className="text-slate-800 dark:text-slate-200 font-bold">Explain Code</div>
                <p className="text-slate-600 dark:text-slate-400 text-[11px] leading-relaxed">
                  Explains what your Python code does in simple, plain words.
                </p>

                {loading ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled
                      className="flex-1 min-h-[42px] py-2 bg-blue-500/80 text-white rounded-lg font-medium flex items-center justify-center gap-2"
                    >
                      <RotateCcw className="w-4 h-4 animate-spin" />
                      <span>Explaining code...</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelAiRequest}
                      className="px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg font-bold flex items-center gap-1 cursor-pointer transition-colors"
                    >
                      <Square className="w-3.5 h-3.5 fill-white" />
                      <span>Cancel</span>
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={handleExplain}
                    className="w-full min-h-[44px] py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold flex items-center justify-center gap-2 transition-colors cursor-pointer"
                  >
                    <HelpCircle className="w-4 h-4" />
                    <span>Explain Code</span>
                  </button>
                )}
              </div>

              {explainResult && (
                <div className="space-y-3 text-xs">
                  <div className="p-3.5 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700 space-y-1.5">
                    <div className="font-semibold text-blue-600 dark:text-blue-400">Summary</div>
                    <p className="text-slate-800 dark:text-slate-200 leading-relaxed">{explainResult.summary}</p>
                  </div>

                  <div className="p-3.5 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700 space-y-2">
                    <div className="font-semibold text-emerald-700 dark:text-emerald-400">Step by Step</div>
                    <ol className="list-decimal list-inside space-y-1.5 text-slate-800 dark:text-slate-200 leading-relaxed">
                      {explainResult.steps.map((step, idx) => (
                        <li key={idx}>{step}</li>
                      ))}
                    </ol>
                  </div>

                  {explainResult.concepts && explainResult.concepts.length > 0 && (
                    <div className="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700 space-y-1">
                      <div className="font-semibold text-purple-700 dark:text-purple-300">Topics Used</div>
                      <p className="text-[11px] font-mono text-slate-700 dark:text-slate-300 leading-relaxed">
                        {explainResult.concepts.join(" · ")}
                      </p>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() =>
                      askFollowUpInChat(
                        `Walk me through ${
                          explainResult.concepts?.[0] || "this Python code"
                        } with a quick practice example.`
                      )
                    }
                    className="w-full py-2 px-3 rounded-lg border border-slate-200 dark:border-[#252933] hover:bg-slate-50 dark:hover:bg-[#15171E] text-xs font-semibold text-blue-600 dark:text-[#8BBEFF] flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <MessageCircle className="w-3.5 h-3.5" />
                    <span>Ask a follow-up question in Chat</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TAB 4: LESSON HINT */}
          {activeTab === "hint" && (
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
              <div className="p-3.5 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700 text-xs space-y-2.5">
                <div className="text-slate-800 dark:text-slate-200 font-bold">Get a Hint</div>
                <p className="text-slate-600 dark:text-slate-400 text-[11px] leading-relaxed">
                  Get a helpful nudge for your current task without giving away the full answer.
                </p>

                {loading ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled
                      className="flex-1 min-h-[42px] py-2 bg-blue-500/80 text-white rounded-lg font-medium flex items-center justify-center gap-2"
                    >
                      <RotateCcw className="w-4 h-4 animate-spin" />
                      <span>Thinking...</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelAiRequest}
                      className="px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg font-bold flex items-center gap-1 cursor-pointer transition-colors"
                    >
                      <Square className="w-3.5 h-3.5 fill-white" />
                      <span>Cancel</span>
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={handleGetHint}
                    className="w-full min-h-[44px] py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold flex items-center justify-center gap-2 transition-colors cursor-pointer"
                  >
                    <Lightbulb className="w-4 h-4" />
                    <span>Show Hint</span>
                  </button>
                )}
              </div>

              {hintResult && (
                <div className="space-y-3">
                  <div className="p-3.5 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/40 rounded-xl text-xs space-y-2 text-amber-800 dark:text-amber-200">
                    <div className="font-semibold text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                      <Lightbulb className="w-4 h-4" />
                      <span>Hint</span>
                    </div>
                    <p className="leading-relaxed">{hintResult.hint}</p>
                    {hintResult.conceptToReview && (
                      <div className="text-[11px] font-mono text-slate-600 dark:text-slate-400">
                        Topic to review: <span className="text-amber-700 dark:text-amber-300">{hintResult.conceptToReview}</span>
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      askFollowUpInChat(
                        `I still need a bit more help with ${
                          hintResult.conceptToReview || lessonContext?.title || "this step"
                        }. What should my first line be?`
                      )
                    }
                    className="w-full py-2 px-3 rounded-lg border border-slate-200 dark:border-[#252933] hover:bg-slate-50 dark:hover:bg-[#15171E] text-xs font-semibold text-blue-600 dark:text-[#8BBEFF] flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <MessageCircle className="w-3.5 h-3.5" />
                    <span>Still stuck? Ask in Chat</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
