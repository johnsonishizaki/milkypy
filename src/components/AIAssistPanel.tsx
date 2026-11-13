import React, { useState, useRef, useEffect } from "react";
import {
  AIDebugResult,
  AICommentResult,
  AIExplainResult,
} from "../types";
import {
  Sparkles,
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
  Wifi,
  Square,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { motion, AnimatePresence } from "motion/react";
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

interface AIAssistPanelProps {
  isOpen: boolean;
  onClose: () => void;
  code: string;
  errorMessage?: string;
  onApplyCode: (newCode: string) => void;
  lessonContext?: { title: string; description: string; expectedOutput?: string };
}

type TabType = "chat" | "debug" | "comments" | "explain" | "hint";

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
  const activeAbortRef = useRef<AbortController | null>(null);
  const manualCancelRef = useRef(false);

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
      setDebugResult(null);
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
  const handleCopyChat = () => {
    if (chatMessages.length === 0) return;
    const transcript = chatMessages
      .map((m) => `[${m.role === "user" ? "You" : "Milky AI"}]:\n${m.text}\n`)
      .join("\n---\n");
    navigator.clipboard.writeText(transcript);
    setCopiedChat(true);
    setTimeout(() => setCopiedChat(false), 2000);
  };

  useEffect(() => {
    if (activeTab === "chat" && chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatMessages, activeTab]);

  // Trigger Debug Request
  const handleDebug = async () => {
    if (activeAbortRef.current) activeAbortRef.current.abort();
    manualCancelRef.current = false;
    const controller = new AbortController();
    activeAbortRef.current = controller;
    setLoading(true);
    setErrorText(null);

    if (!navigator.onLine) {
      const localResult = diagnoseOfflineError(code, errorMessage);
      setDebugResult(localResult);
      setLoading(false);
      return;
    }

    try {
      const res = await fetchWithTimeout(getApiUrl("/api/ai/debug"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, errorMessage }),
        timeoutMs: 45000,
        externalSignal: controller.signal,
      });
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error("AI endpoint did not return JSON (check Cloudflare Pages Functions or VITE_SERVER_URL).");
      }
      const data = await res.json();
      if (res.ok && data.success) {
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

  // Trigger Comment Addition
  const handleAddComments = async () => {
    if (activeAbortRef.current) activeAbortRef.current.abort();
    manualCancelRef.current = false;
    const controller = new AbortController();
    activeAbortRef.current = controller;
    setLoading(true);
    setErrorText(null);

    const buildOfflineComments = () => {
      const lines = code.split("\n");
      const commented = lines
        .map((l) => (l.trim() && !l.trim().startsWith("#") ? `  # Step: ${l.trim().slice(0, 36)}\n${l}` : l))
        .join("\n");
      return {
        commentedCode: commented,
        summary: "[Offline Mode] Added Python structural comments locally.",
      };
    };

    if (!navigator.onLine) {
      setCommentResult(buildOfflineComments());
      setLoading(false);
      return;
    }

    try {
      const res = await fetchWithTimeout(getApiUrl("/api/ai/add-comments"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
        timeoutMs: 45000,
        externalSignal: controller.signal,
      });
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error("AI endpoint did not return JSON (check Cloudflare Pages Functions or VITE_SERVER_URL).");
      }
      const data = await res.json();
      if (res.ok && data.success) {
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

  // Trigger Code Explanation
  const handleExplain = async () => {
    if (activeAbortRef.current) activeAbortRef.current.abort();
    manualCancelRef.current = false;
    const controller = new AbortController();
    activeAbortRef.current = controller;
    setLoading(true);
    setErrorText(null);

    if (!navigator.onLine) {
      setExplainResult(explainOfflineCode(code));
      setLoading(false);
      return;
    }

    try {
      const res = await fetchWithTimeout(getApiUrl("/api/ai/explain"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
        timeoutMs: 45000,
        externalSignal: controller.signal,
      });
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error("AI endpoint did not return JSON (check Cloudflare Pages Functions or VITE_SERVER_URL).");
      }
      const data = await res.json();
      if (res.ok && data.success) {
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

  // Trigger Hint Generation
  const handleGetHint = async () => {
    if (activeAbortRef.current) activeAbortRef.current.abort();
    manualCancelRef.current = false;
    const controller = new AbortController();
    activeAbortRef.current = controller;
    setLoading(true);
    setErrorText(null);

    if (!navigator.onLine) {
      setHintResult({
        hint: `[Offline Hint] For ${lessonContext?.title || "this problem"}: Break the script into small steps. First, define the needed variables or inputs. Second, perform calculations with arithmetic/comparison operators. Third, use print() to verify intermediate values.`,
        conceptToReview: lessonContext?.title || "Python Basics",
      });
      setLoading(false);
      return;
    }

    try {
      const res = await fetchWithTimeout(getApiUrl("/api/ai/hint"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonTitle: lessonContext?.title,
          lessonDescription: lessonContext?.description,
          targetOutput: lessonContext?.expectedOutput,
          currentCode: code,
        }),
        timeoutMs: 45000,
        externalSignal: controller.signal,
      });
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error("AI endpoint did not return JSON (check Cloudflare Pages Functions or VITE_SERVER_URL).");
      }
      const data = await res.json();
      if (res.ok && data.success) {
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

    if (activeAbortRef.current) activeAbortRef.current.abort();
    manualCancelRef.current = false;
    const controller = new AbortController();
    activeAbortRef.current = controller;

    const newMessages = [...chatMessages, { role: "user" as const, text: userText }];
    setChatMessages(newMessages);
    setChatInput("");
    setLoading(true);
    setErrorText(null);

    if (!navigator.onLine) {
      const offlineReply = getOfflineChatReply(userText, code);
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
      const res = await fetchWithTimeout(getApiUrl("/api/ai/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: newMessages.slice(-14),
          code,
          lessonContext,
        }),
        timeoutMs: 45000,
        externalSignal: controller.signal,
      });
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error("AI endpoint did not return JSON (check Cloudflare Pages Functions or VITE_SERVER_URL).");
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
        setErrorText(data.error || "Cloud AI unavailable — using on-device Python handbook.");
        const offlineReply = getOfflineChatReply(userText, code);
        setChatMessages([...newMessages, { role: "model" as const, text: offlineReply }]);
      }
    } catch (e: any) {
      if (manualCancelRef.current) return;
      setErrorText(e?.message || "Cloud AI unavailable — using on-device Python handbook.");
      const offlineReply = getOfflineChatReply(userText, code);
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

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 bg-slate-900/40 flex justify-end"
        >
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="w-full max-w-lg bg-white dark:bg-[#08090D] border-l border-slate-200 dark:border-[#252933] h-full flex flex-col shadow-xl overflow-hidden select-none"
          >
            {/* Panel Header */}
        <div className="p-3.5 border-b border-slate-200 dark:border-[#252933] bg-slate-100 dark:bg-[#15171E] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-blue-600 dark:bg-[#8BBEFF] text-white dark:text-[#08090D] shadow-xs">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-[#F3F4F6]">
                Ask AI Assistant
              </h2>
              <p className="text-[11px] text-slate-500 dark:text-[#BFC4CE]">
                General assistant, Python specialist & curriculum tutor
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-[#252933] text-slate-500 dark:text-[#BFC4CE] hover:text-slate-900 dark:hover:text-white cursor-pointer touch-target"
              title="Close sidebar"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Offline Mode Indicator Banner */}
        {!isOnline && (
          <div className="bg-amber-500/10 dark:bg-amber-500/15 border-b border-amber-500/20 px-3.5 py-1.5 flex items-center justify-between text-xs text-amber-700 dark:text-amber-300 font-medium">
            <div className="flex items-center gap-1.5">
              <WifiOff className="w-3.5 h-3.5 text-amber-500 shrink-0" />
              <span>Offline Standalone Mode: Local Python Handbook active</span>
            </div>
            <span className="text-[10px] bg-amber-500/20 text-amber-800 dark:text-amber-200 px-1.5 py-0.5 rounded font-mono font-semibold">100% On-Device</span>
          </div>
        )}

        {/* Feature Navigation Tabs */}
        <div className="grid grid-cols-5 p-1.5 bg-slate-50 dark:bg-[#15171E] border-b border-slate-200 dark:border-[#252933] text-[11px] font-semibold">
          <button
            onClick={() => setActiveTab("chat")}
            className={`py-2 flex flex-col items-center gap-1 rounded-lg transition-all touch-target ${
              activeTab === "chat"
                ? "bg-blue-600 dark:bg-[#8BBEFF] text-white dark:text-[#08090D] shadow-xs font-bold"
                : "text-slate-600 dark:text-[#BFC4CE] hover:bg-slate-200 dark:hover:bg-[#252933]"
            }`}
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-300 dark:text-amber-400" />
            <span>Chat</span>
          </button>
          
          <button
            onClick={() => setActiveTab("debug")}
            className={`py-2 flex flex-col items-center gap-1 rounded-lg transition-all touch-target ${
              activeTab === "debug"
                ? "bg-blue-600 dark:bg-[#8BBEFF] text-white dark:text-[#08090D] shadow-xs font-bold"
                : "text-slate-600 dark:text-[#BFC4CE] hover:bg-slate-200 dark:hover:bg-[#252933]"
            }`}
          >
            <Bug className="w-3.5 h-3.5" />
            <span>Debug</span>
          </button>

          <button
            onClick={() => setActiveTab("comments")}
            className={`py-2 flex flex-col items-center gap-1 rounded-lg transition-all touch-target ${
              activeTab === "comments"
                ? "bg-blue-600 dark:bg-[#8BBEFF] text-white dark:text-[#08090D] shadow-xs font-bold"
                : "text-slate-600 dark:text-[#BFC4CE] hover:bg-slate-200 dark:hover:bg-[#252933]"
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>Comments</span>
          </button>

          <button
            onClick={() => setActiveTab("explain")}
            className={`py-2 flex flex-col items-center gap-1 rounded-lg transition-all touch-target ${
              activeTab === "explain"
                ? "bg-blue-600 dark:bg-[#8BBEFF] text-white dark:text-[#08090D] shadow-xs font-bold"
                : "text-slate-600 dark:text-[#BFC4CE] hover:bg-slate-200 dark:hover:bg-[#252933]"
            }`}
          >
            <HelpCircle className="w-3.5 h-3.5" />
            <span>Explain</span>
          </button>

          <button
            onClick={() => setActiveTab("hint")}
            className={`py-2 flex flex-col items-center gap-1 rounded-lg transition-all touch-target ${
              activeTab === "hint"
                ? "bg-blue-600 dark:bg-[#8BBEFF] text-white dark:text-[#08090D] shadow-xs font-bold"
                : "text-slate-600 dark:text-[#BFC4CE] hover:bg-slate-200 dark:hover:bg-[#252933]"
            }`}
          >
            <Lightbulb className="w-3.5 h-3.5" />
            <span>Hint</span>
          </button>
        </div>

        {/* Active Curriculum Lesson Context Banner */}
        {lessonContext?.title && (
          <div className="bg-blue-50 dark:bg-blue-950/40 border-b border-blue-200 dark:border-blue-800/60 px-3.5 py-2.5 space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-blue-700 dark:text-blue-300 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-blue-500" />
                Current Lesson: {lessonContext.title}
              </span>
              <span className="text-[10px] bg-blue-100 dark:bg-blue-900/60 text-blue-800 dark:text-blue-200 px-1.5 py-0.5 rounded font-mono font-semibold">
                Curriculum Mode
              </span>
            </div>
            {lessonContext.description && (
              <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-normal">
                {lessonContext.description}
              </p>
            )}
          </div>
        )}

        {/* Main Content Area */}
        <div className="flex-1 p-4 overflow-y-auto space-y-4">
          {errorText && (
            <div className="p-2.5 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 rounded-lg text-amber-800 dark:text-amber-300 text-xs flex items-start justify-between gap-2">
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

          {/* TAB 0: CHAT */}
          {activeTab === "chat" && (
            <div className="flex flex-col h-full space-y-3">
              {/* Chat Sub-Header / History Toolbar */}
              <div className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-100 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700/80 rounded-xl text-xs">
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <MessageCircle className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                  <span className="font-semibold text-slate-800 dark:text-slate-200 truncate">
                    {showHistoryDrawer
                      ? "Milky AI Tutor History"
                      : activeSessionTitle || "Milky AI Tutor"}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {/* New Chat Button */}
                  <button
                    onClick={handleNewChat}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white dark:bg-slate-700 hover:bg-slate-50 dark:hover:bg-slate-600 border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200 text-[11px] font-bold shadow-2xs transition-colors cursor-pointer"
                    title="Start a new chat conversation"
                  >
                    <PlusCircle className="w-3 h-3 text-blue-500" />
                    <span className="hidden sm:inline">New Chat</span>
                  </button>

                  {/* History Toggle Button */}
                  <button
                    onClick={() => {
                      setConfirmClearHistory(false);
                      setShowHistoryDrawer(!showHistoryDrawer);
                    }}
                    className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] font-bold shadow-2xs transition-colors cursor-pointer ${
                      showHistoryDrawer
                        ? "bg-blue-600 border-blue-600 text-white"
                        : "bg-white dark:bg-slate-700 hover:bg-slate-50 dark:hover:bg-slate-600 border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200"
                    }`}
                    title="View previous chats"
                  >
                    <History className="w-3 h-3" />
                    <span>History</span>
                    {savedSessions.length > 0 && (
                      <span
                        className={`px-1 py-0.2 rounded-full text-[9px] font-bold ${
                          showHistoryDrawer
                            ? "bg-blue-700 text-white"
                            : "bg-slate-200 dark:bg-slate-600 text-slate-700 dark:text-slate-200"
                        }`}
                      >
                        {savedSessions.length}
                      </span>
                    )}
                  </button>

                  {/* Copy Chat */}
                  {chatMessages.length > 0 && !showHistoryDrawer && (
                    <button
                      onClick={handleCopyChat}
                      className="p-1 rounded-lg bg-white dark:bg-slate-700 hover:bg-slate-50 dark:hover:bg-slate-600 border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 transition-colors cursor-pointer"
                      title="Copy chat transcript"
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

              {/* View 1: History Drawer / List of Saved Sessions */}
              {showHistoryDrawer ? (
                <div className="flex-1 flex flex-col space-y-3 min-h-0">
                  {/* Search bar */}
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
                    <input
                      type="text"
                      value={historySearchQuery}
                      onChange={(e) => setHistorySearchQuery(e.target.value)}
                      placeholder="Search past conversations..."
                      className="w-full pl-8 pr-3 py-1.5 bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-xl text-xs text-slate-800 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  {/* Sessions List */}
                  <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                    {savedSessions.length === 0 ? (
                      <div className="text-center py-10 text-slate-400 dark:text-slate-500 text-xs">
                        <History className="w-8 h-8 mx-auto mb-2 opacity-40" />
                        <p>No saved chat sessions yet.</p>
                        <p className="text-[11px] mt-1 text-slate-400">
                          Ask a question and your conversations will appear here!
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
                                    onClick={(e) => handleDeleteSession(session.id, e)}
                                    className="p-1 rounded text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/50 transition-colors"
                                    title="Delete session"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                </div>
                              </div>

                              <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2">
                                {lastMsg}
                              </p>

                              <div className="flex items-center justify-between text-[10px] text-slate-400 pt-0.5">
                                <span>{session.messages.length} messages</span>
                                <span className="text-blue-600 dark:text-blue-400 font-semibold">
                                  {isActive ? "Currently Active" : "Click to Resume →"}
                                </span>
                              </div>
                            </div>
                          );
                        })
                    )}
                  </div>

                  {/* History Footer Actions */}
                  <div className="flex items-center justify-between pt-2 border-t border-slate-200 dark:border-slate-800 gap-2">
                    {savedSessions.length > 0 && (
                      confirmClearHistory ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={handleClearAllHistory}
                            className="px-2 py-1 rounded-md bg-rose-600 hover:bg-rose-700 text-white text-[11px] font-bold transition-colors cursor-pointer"
                          >
                            Confirm Clear All?
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmClearHistory(false)}
                            className="px-2 py-1 rounded-md bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-[11px] font-semibold cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={handleClearAllHistory}
                          className="text-[11px] text-rose-600 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300 font-bold transition-colors cursor-pointer"
                        >
                          Clear All History
                        </button>
                      )
                    )}
                    <button
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
                /* View 2: Active Chat Messages & Input */
                <>
                  <div className="flex-1 overflow-y-auto space-y-3 pb-2">
                    {chatMessages.length === 0 ? (
                      <div className="text-center text-slate-500 dark:text-slate-400 text-xs py-6 space-y-4">
                        <div>
                          <MessageCircle className="w-8 h-8 mx-auto mb-2 opacity-50 text-blue-500" />
                          <p className="font-semibold text-slate-700 dark:text-slate-200">
                            {lessonContext?.title ? `Ready to master "${lessonContext.title}"?` : "Ask me anything, from Python lessons to everyday questions"}
                          </p>
                          <p className="text-[11px] text-slate-400 mt-1">
                            {lessonContext?.title ? "I can guide you through the lesson objectives, explain the code, or review your work." : "I know the full MilkyPy curriculum and can teach, debug, or chat normally."}
                          </p>
                        </div>
                        <div className="flex flex-wrap justify-center gap-2 px-2">
                          {(lessonContext?.title
                            ? [
                                `Walk me through the objectives of "${lessonContext.title}"`,
                                "How do I write the code for this lesson exercise?",
                                "Check my current editor code against lesson goals",
                                "Give me a simple step-by-step breakdown",
                              ]
                            : [
                                "Teach me a lesson from the Python curriculum",
                                "Explain what this code does step-by-step",
                                "Find any bugs or edge cases in my code",
                                "What should I learn next in Python?",
                              ]
                          ).map((starter) => (
                            <button
                              key={starter}
                              type="button"
                              onClick={() => sendChatPrompt(starter)}
                              className="px-2.5 py-1.5 rounded-xl bg-slate-100 hover:bg-blue-50 dark:bg-slate-800/80 dark:hover:bg-blue-950/50 border border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-700 text-[11px] font-medium text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
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
                          className={`flex flex-col max-w-[90%] p-3 rounded-2xl text-xs ${
                            msg.role === "user"
                              ? "bg-blue-600 text-white self-end ml-auto rounded-tr-sm"
                              : "bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 self-start mr-auto rounded-tl-sm border border-slate-200 dark:border-slate-700"
                          }`}
                        >
                          <div className="font-bold text-[10px] mb-1 opacity-70 uppercase tracking-wider">
                            {msg.role === "user" ? "You" : "Milky"}
                          </div>
                          <div className="prose prose-sm dark:prose-invert max-w-none prose-pre:bg-slate-900 prose-pre:border prose-pre:border-slate-700 prose-p:leading-relaxed">
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
                                        <button
                                          onClick={() => applyCodeFix(codeString)}
                                          className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white font-sans text-[10px] font-bold flex items-center gap-1 w-full justify-center cursor-pointer"
                                        >
                                          {applied ? (
                                            <Check className="w-3 h-3" />
                                          ) : (
                                            <Sparkles className="w-3 h-3" />
                                          )}
                                          <span>{applied ? "Applied" : "Apply Code"}</span>
                                        </button>
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
                      <div className="flex items-center justify-between gap-2 text-slate-500 text-xs ml-2 p-2 rounded-lg bg-slate-100/70 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/70">
                        <div className="flex items-center gap-2">
                          <RotateCcw className="w-3.5 h-3.5 animate-spin text-blue-500" />
                          <span>Milky is thinking...</span>
                        </div>
                        <button
                          type="button"
                          onClick={handleCancelAiRequest}
                          className="px-2 py-1 rounded-md bg-rose-600/15 hover:bg-rose-600/25 text-rose-600 dark:text-rose-400 text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-colors"
                        >
                          <Square className="w-2.5 h-2.5 fill-current" />
                          <span>Cancel</span>
                        </button>
                      </div>
                    )}
                    <div ref={chatEndRef} />
                  </div>

                  <form
                    onSubmit={handleChatSubmit}
                    className="flex items-end gap-2 bg-slate-50 dark:bg-slate-800/50 p-2 rounded-xl border border-slate-200 dark:border-slate-700"
                  >
                    <textarea
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      placeholder="Ask anything — Python, curriculum lessons, or general help... (Enter to send)"
                      className="flex-1 bg-transparent border-none focus:ring-0 resize-none text-xs text-slate-800 dark:text-slate-200 min-h-[40px] max-h-[120px]"
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
                        className="p-2.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white transition-colors cursor-pointer shrink-0"
                        title="Cancel AI response"
                      >
                        <Square className="w-4 h-4 fill-white" />
                      </button>
                    ) : (
                      <button
                        type="submit"
                        disabled={!chatInput.trim()}
                        className="p-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:opacity-50 text-white transition-colors cursor-pointer shrink-0"
                      >
                        <Send className="w-4 h-4" />
                      </button>
                    )}
                  </form>
                </>
              )}
            </div>
          )}

          {/* TAB 1: DEBUGGER */}
          {activeTab === "debug" && (
            <div className="space-y-4">
              <div className="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700 text-xs space-y-2">
                <div className="text-slate-800 dark:text-slate-200 font-bold">Inspect & Fix Code Bug</div>
                <p className="text-slate-500 dark:text-slate-400 text-[11px]">
                  Scans your Python code and error traces to deliver instant corrections and tips.
                </p>

                {errorMessage && (
                  <div className="p-2 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/60 rounded font-mono text-[11px] text-rose-700 dark:text-rose-300">
                    {errorMessage.slice(0, 300)}
                  </div>
                )}

                {loading ? (
                  <div className="flex gap-2">
                    <button
                      disabled
                      className="flex-1 py-2 bg-blue-500/80 text-white rounded-lg font-bold flex items-center justify-center gap-2"
                    >
                      <RotateCcw className="w-4 h-4 animate-spin" />
                      <span>Analyzing Code...</span>
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
                    onClick={handleDebug}
                    className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold flex items-center justify-center gap-2 cursor-pointer transition-colors"
                  >
                    <Bug className="w-4 h-4" />
                    <span>Run AI Debugger</span>
                  </button>
                )}
              </div>

              {debugResult && (
                <div className="space-y-3">
                  <div className="p-3 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/60 rounded-xl text-xs space-y-2">
                    <span className="px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-900/60 text-blue-800 dark:text-blue-300 font-mono text-[10px] uppercase font-bold">
                      Bug Type: {debugResult.bugType}
                    </span>
                    <p className="text-slate-800 dark:text-slate-200">{debugResult.explanation}</p>

                    {debugResult.tips && (
                      <ul className="list-disc list-inside text-slate-600 dark:text-slate-400 text-[11px] space-y-1">
                        {debugResult.tips.map((tip, idx) => (
                          <li key={idx}>{tip}</li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* Fixed Code Display */}
                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center text-xs font-mono text-slate-700 dark:text-slate-300">
                      <span>Corrected Python Code</span>
                      <button
                        onClick={() => applyCodeFix(debugResult.fixedCode)}
                        className="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-sans text-xs font-bold flex items-center gap-1 shadow-sm"
                      >
                        {applied ? <Check className="w-3.5 h-3.5" /> : <Sparkles className="w-3.5 h-3.5" />}
                        <span>{applied ? "Applied!" : "Apply Fix to Code"}</span>
                      </button>
                    </div>
                    <pre className="p-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl font-mono text-xs text-emerald-700 dark:text-emerald-400 overflow-x-auto">
                      {debugResult.fixedCode}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: GUIDED COMMENTS */}
          {activeTab === "comments" && (
            <div className="space-y-4">
              <div className="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700 text-xs space-y-2">
                <div className="text-slate-800 dark:text-slate-200 font-bold">Inject Guided Line Comments</div>
                <p className="text-slate-500 dark:text-slate-400 text-[11px]">
                  Adds line-by-line educational Python <span className="font-mono text-blue-600 dark:text-blue-400"># comments</span> to guide learners step-by-step.
                </p>

                {loading ? (
                  <div className="flex gap-2">
                    <button
                      disabled
                      className="flex-1 py-2 bg-blue-500/80 text-white rounded-lg font-bold flex items-center justify-center gap-2"
                    >
                      <RotateCcw className="w-4 h-4 animate-spin" />
                      <span>Generating Comments...</span>
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
                    onClick={handleAddComments}
                    className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold flex items-center justify-center gap-2 cursor-pointer transition-colors"
                  >
                    <MessageSquare className="w-4 h-4" />
                    <span>Add Educational Comments</span>
                  </button>
                )}
              </div>

              {commentResult && (
                <div className="space-y-3">
                  <div className="p-2.5 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 rounded-lg text-xs text-emerald-800 dark:text-emerald-300">
                    {commentResult.summary}
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center text-xs font-mono text-slate-700 dark:text-slate-300">
                      <span>Commented Python Script</span>
                      <button
                        onClick={() => applyCodeFix(commentResult.commentedCode)}
                        className="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-sans text-xs font-bold flex items-center gap-1"
                      >
                        {applied ? <Check className="w-3.5 h-3.5" /> : <Sparkles className="w-3.5 h-3.5" />}
                        <span>{applied ? "Applied!" : "Apply Commented Code"}</span>
                      </button>
                    </div>
                    <pre className="p-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl font-mono text-xs text-slate-800 dark:text-slate-100 overflow-x-auto whitespace-pre-wrap">
                      {commentResult.commentedCode}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: CODE EXPLAINER */}
          {activeTab === "explain" && (
            <div className="space-y-4">
              <div className="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700 text-xs space-y-2">
                <div className="text-slate-800 dark:text-slate-200 font-medium">Explain Python Execution</div>
                <p className="text-slate-600 dark:text-slate-400 text-[11px]">
                  Translates code logic into beginner-friendly plain English breakdown.
                </p>

                {loading ? (
                  <div className="flex gap-2">
                    <button
                      disabled
                      className="flex-1 py-2 bg-blue-500/80 text-white rounded font-medium flex items-center justify-center gap-2"
                    >
                      <RotateCcw className="w-4 h-4 animate-spin" />
                      <span>Explaining Code...</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelAiRequest}
                      className="px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded font-bold flex items-center gap-1 cursor-pointer transition-colors"
                    >
                      <Square className="w-3.5 h-3.5 fill-white" />
                      <span>Cancel</span>
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handleExplain}
                    className="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white rounded font-medium flex items-center justify-center gap-2 transition-colors cursor-pointer"
                  >
                    <HelpCircle className="w-4 h-4" />
                    <span>Explain Code</span>
                  </button>
                )}
              </div>

              {explainResult && (
                <div className="space-y-3 animate-fadeIn text-xs">
                  <div className="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700 space-y-1">
                    <div className="font-semibold text-blue-600 dark:text-blue-400">Summary:</div>
                    <p className="text-slate-800 dark:text-slate-200">{explainResult.summary}</p>
                  </div>

                  <div className="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700 space-y-2">
                    <div className="font-semibold text-emerald-700 dark:text-emerald-400">Execution Steps:</div>
                    <ol className="list-decimal list-inside space-y-1 text-slate-800 dark:text-slate-200">
                      {explainResult.steps.map((step, idx) => (
                        <li key={idx}>{step}</li>
                      ))}
                    </ol>
                  </div>

                  {explainResult.concepts && (
                    <div className="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700 space-y-1">
                      <div className="font-semibold text-purple-700 dark:text-purple-300">Core Concepts Used:</div>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {explainResult.concepts.map((c, idx) => (
                          <span
                            key={idx}
                            className="px-2 py-0.5 rounded bg-purple-50 dark:bg-purple-500/10 text-purple-700 dark:text-purple-300 font-mono text-[10px] border border-purple-200 dark:border-purple-500/20"
                          >
                            {c}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* TAB 4: LESSON HINT */}
          {activeTab === "hint" && (
            <div className="space-y-4">
              <div className="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700 text-xs space-y-2">
                <div className="text-slate-800 dark:text-slate-200 font-medium">Get Progressive Hint</div>
                <p className="text-slate-600 dark:text-slate-400 text-[11px]">
                  Get a helpful nudge on your current lesson exercise without spoiling the answer.
                </p>

                {loading ? (
                  <div className="flex gap-2">
                    <button
                      disabled
                      className="flex-1 py-2 bg-blue-500/80 text-white rounded font-medium flex items-center justify-center gap-2"
                    >
                      <RotateCcw className="w-4 h-4 animate-spin" />
                      <span>Thinking...</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelAiRequest}
                      className="px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded font-bold flex items-center gap-1 cursor-pointer transition-colors"
                    >
                      <Square className="w-3.5 h-3.5 fill-white" />
                      <span>Cancel</span>
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handleGetHint}
                    className="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white rounded font-medium flex items-center justify-center gap-2 transition-colors cursor-pointer"
                  >
                    <Lightbulb className="w-4 h-4" />
                    <span>Ask AI for Hint</span>
                  </button>
                )}
              </div>

              {hintResult && (
                <div className="p-3 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/40 rounded-lg text-xs space-y-2 text-amber-800 dark:text-amber-200 animate-fadeIn">
                  <div className="font-semibold text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                    <Lightbulb className="w-4 h-4" />
                    <span>AI Tutor Hint</span>
                  </div>
                  <p>{hintResult.hint}</p>
                  {hintResult.conceptToReview && (
                    <div className="text-[11px] font-mono text-slate-600 dark:text-slate-400">
                      Topic to review: <span className="text-amber-700 dark:text-amber-300">{hintResult.conceptToReview}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
