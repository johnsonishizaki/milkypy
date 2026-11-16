import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import Prism from "prismjs";
import "prismjs/components/prism-python";
import {
  CheckCircle2,
  XCircle,
  Play,
  Lightbulb,
  ArrowRight,
  ArrowLeft,
  RotateCcw,
  BookOpen,
  Trophy,
  Clock,
  Flame,
  Target,
  Layers,
  AlertTriangle,
  History,
  BarChart3,
  Loader2,
  Trash2,
  RefreshCw,
  ChevronDown,
  Search,
  X,
  Check,
} from "lucide-react";
import { UserProgress } from "../types";
import { getCurriculumModules, getAllLessons } from "../data/curriculum";
import {
  DynamicQuizQuestion,
  buildAdaptiveQuizDeck,
  generateRandomQuiz,
} from "../lib/quizGenerator";
import {
  QuizScope,
  LessonMasteryRecord,
  QuizSessionRecord,
  QuizQuestionAttempt,
  loadLessonMastery,
  recordLessonQuestionAttempt,
  loadQuizHistorySync,
  loadQuizHistory,
  saveQuizSession,
  clearAllQuizTracking,
  computeOverallQuizStats,
} from "../lib/quizStorage";
import { CopyCodeButton } from "./CopyCodeButton";
import { QuizFeedbackActionsBar } from "./QuizFeedbackActionsBar";

const QUIZ_SESSION_STORAGE_KEY = "milkypy_active_quiz_session_v1";

interface QuizViewProps {
  progress: UserProgress;
  onUpdateProgress: (progress: UserProgress) => void;
  onOpenAiAssist: (code: string, errorMsg?: string, lessonCtx?: any) => void;
  onPracticeClick: (code: string, meta?: { topicTitle?: string; question?: string }) => void;
  onOpenLesson: (lessonId: string, meta?: { topicTitle?: string; question?: string }) => void;
  requestedLessonId?: string | null;
  onClearRequestedLesson?: () => void;
}

type QuizTab = "quiz" | "mastery" | "history";
type QuizStage = "setup" | "active" | "summary";
type TopicFilter = "all" | "weak" | "completed" | "untried";
type HistoryFilter = "all" | QuizScope;

const OPTION_LETTERS = ["A", "B", "C", "D"];

function formatDuration(sec: number): string {
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return mins > 0 ? `${mins}m ${rem}s` : `${rem}s`;
}

export const QuizView: React.FC<QuizViewProps> = ({
  progress,
  onUpdateProgress,
  onOpenAiAssist,
  onPracticeClick,
  onOpenLesson,
  requestedLessonId,
  onClearRequestedLesson,
}) => {
  const modules = useMemo(() => getCurriculumModules(), []);
  const allLessons = useMemo(() => getAllLessons(), []);

  // Hydrate suspended active/summary quiz session if user jumped away (e.g. Open Lesson / Try in Editor)
  const savedSession = useMemo(() => {
    if (requestedLessonId) return null;
    try {
      const raw = sessionStorage.getItem(QUIZ_SESSION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.deck) && parsed.deck.length > 0) {
        return parsed;
      }
    } catch {
      // ignore invalid session payload
    }
    return null;
  }, []);

  // View & Config state
  const [activeTab, setActiveTab] = useState<QuizTab>("quiz");
  const [stage, setStage] = useState<QuizStage>(() => savedSession?.stage || "setup");
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1);
  const [scope, setScope] = useState<QuizScope>(() => savedSession?.scope || "adaptive");
  const [selectedModuleId, setSelectedModuleId] = useState<string>(
    () => modules[0]?.id || "module-01-python-basics"
  );
  const [selectedLessonId, setSelectedLessonId] = useState<string>(
    () => progress.lastActiveLessonId || allLessons[0]?.lesson.id || ""
  );
  const [wizardLessonModuleId, setWizardLessonModuleId] = useState<string>(() => {
    const startLid = progress.lastActiveLessonId || allLessons[0]?.lesson.id;
    const found = allLessons.find((l) => l.lesson.id === startLid);
    return found?.module.id || modules[0]?.id || "module-01-python-basics";
  });
  const [questionCount, setQuestionCount] = useState<number>(8);
  const [difficultyPref, setDifficultyPref] = useState<
    "adaptive" | "beginner" | "intermediate" | "mixed"
  >("adaptive");

  // Persistent Mastery & History
  const [masteryMap, setMasteryMap] = useState<Record<string, LessonMasteryRecord>>(
    () => loadLessonMastery()
  );
  const [history, setHistory] = useState<QuizSessionRecord[]>(() =>
    loadQuizHistorySync()
  );
  const [confirmResetStats, setConfirmResetStats] = useState(false);

  // Active Quiz Session state
  const [deck, setDeck] = useState<DynamicQuizQuestion[]>(() => savedSession?.deck || []);
  const [scopeLabel, setScopeLabel] = useState<string>(
    () => savedSession?.scopeLabel || "Recommended"
  );
  const [selectionReason, setSelectionReason] = useState<string>(
    () => savedSession?.selectionReason || ""
  );
  const [currentIdx, setCurrentIdx] = useState<number>(() => savedSession?.currentIdx || 0);
  const [reviewingIdx, setReviewingIdx] = useState<number | null>(null);
  const [selectedOption, setSelectedOption] = useState<number | null>(
    () => (typeof savedSession?.selectedOption === "number" ? savedSession.selectedOption : null)
  );
  const [showHint, setShowHint] = useState<boolean>(false);
  const [attempts, setAttempts] = useState<QuizQuestionAttempt[]>(
    () => savedSession?.attempts || []
  );
  const [streak, setStreak] = useState<number>(() => savedSession?.streak || 0);
  const [bestStreak, setBestStreak] = useState<number>(() => savedSession?.bestStreak || 0);
  const [sessionXp, setSessionXp] = useState<number>(() => savedSession?.sessionXp || 0);
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(
    () => savedSession?.elapsedSeconds || 0
  );
  const [blitzRemaining, setBlitzRemaining] = useState<number>(
    () => (typeof savedSession?.blitzRemaining === "number" ? savedSession.blitzRemaining : 90)
  );

  // AI Question synthesis state
  const [isGeneratingAiQ, setIsGeneratingAiQ] = useState<boolean>(false);
  const [aiStatusNote, setAiStatusNote] = useState<string | null>(null);

  // Summary Review Filter & Expandable History Session
  const [reviewFilter, setReviewFilter] = useState<"all" | "missed" | "correct">(
    () => savedSession?.reviewFilter || "all"
  );
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const [historyQuestionFilter, setHistoryQuestionFilter] = useState<"all" | "missed">("all");
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");

  // Topics Tab Organization State
  const [topicSearch, setTopicSearch] = useState<string>("");
  const [topicFilter, setTopicFilter] = useState<TopicFilter>("all");
  const [expandedTopicModules, setExpandedTopicModules] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    const currentLid = progress.lastActiveLessonId;
    modules.forEach((m, i) => {
      const hasCurrent = m.lessons.some((l) => l.id === currentLid);
      map[m.id] = hasCurrent || i === 0;
    });
    return map;
  });

  const timerRef = useRef<number | null>(null);
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const stepperBtnRefs = useRef<Record<number, HTMLButtonElement | null>>({});

  // Persist active or summary quiz state so jumping to Lesson / Playground never loses quiz progress
  useEffect(() => {
    try {
      if ((stage === "active" || stage === "summary") && deck.length > 0) {
        sessionStorage.setItem(
          QUIZ_SESSION_STORAGE_KEY,
          JSON.stringify({
            stage,
            scope,
            scopeLabel,
            selectionReason,
            deck,
            currentIdx,
            selectedOption,
            attempts,
            streak,
            bestStreak,
            sessionXp,
            elapsedSeconds,
            blitzRemaining,
            reviewFilter,
          })
        );
      } else if (stage === "setup") {
        sessionStorage.removeItem(QUIZ_SESSION_STORAGE_KEY);
      }
    } catch {
      // ignore storage errors
    }
  }, [
    stage,
    scope,
    scopeLabel,
    selectionReason,
    deck,
    currentIdx,
    selectedOption,
    attempts,
    streak,
    bestStreak,
    sessionXp,
    elapsedSeconds,
    blitzRemaining,
    reviewFilter,
  ]);

  // Hydrate IndexedDB quiz history on mount
  useEffect(() => {
    loadQuizHistory().then((loaded) => {
      if (loaded.length > 0) {
        setHistory(loaded);
      }
    });
  }, []);

  // Auto-reset two-step stats confirmation after 3.5s
  useEffect(() => {
    if (!confirmResetStats) return;
    const t = window.setTimeout(() => setConfirmResetStats(false), 3500);
    return () => window.clearTimeout(t);
  }, [confirmResetStats]);

  // Keep mobile progress stepper centered on the currently viewed question
  useEffect(() => {
    if (stage !== "active") return;
    const activeTargetIdx = reviewingIdx !== null ? reviewingIdx : currentIdx;
    const el = stepperBtnRefs.current[activeTargetIdx];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }
  }, [stage, currentIdx, reviewingIdx]);

  // Helper to select a lesson and sync its module tab inside Setup Wizard Step 2
  const handleSelectLessonTarget = useCallback(
    (lessonId: string) => {
      setSelectedLessonId(lessonId);
      const match = allLessons.find((l) => l.lesson.id === lessonId);
      if (match) {
        setWizardLessonModuleId(match.module.id);
      }
    },
    [allLessons]
  );

  // Derived curriculum stats
  const completedCount = progress.completedLessonIds?.length || 0;
  const totalCurriculumLessons = allLessons.length || 24;
  const overallStats = useMemo(
    () => computeOverallQuizStats(masteryMap, history),
    [masteryMap, history]
  );

  // Quick target helpers for "One Lesson" setup
  const weakestLessonId = useMemo(() => {
    if (overallStats.weakLessonIds.length > 0) {
      return overallStats.weakLessonIds[0];
    }
    const entries = Object.values(masteryMap).filter((r) => r.attempts > 0);
    if (entries.length === 0) return null;
    entries.sort((a, b) => a.correct / a.attempts - b.correct / b.attempts);
    return entries[0]?.lessonId || null;
  }, [overallStats.weakLessonIds, masteryMap]);

  const nextUnfinishedLessonId = useMemo(() => {
    const found = allLessons.find(
      (item) => !progress.completedLessonIds.includes(item.lesson.id)
    );
    return found?.lesson.id || allLessons[0]?.lesson.id || null;
  }, [allLessons, progress.completedLessonIds]);

  // Preview plan for setup screen
  const previewPlan = useMemo(() => {
    return buildAdaptiveQuizDeck({
      progress,
      modules,
      masteryMap,
      scope,
      selectedModuleId,
      selectedLessonId,
      count: scope === "timed-blitz" ? 12 : questionCount,
      difficulty: difficultyPref,
    });
  }, [
    progress,
    modules,
    masteryMap,
    scope,
    selectedModuleId,
    selectedLessonId,
    questionCount,
    difficultyPref,
  ]);

  const currentQuestion: DynamicQuizQuestion | undefined = deck[currentIdx];
  const inspectedAttempt: QuizQuestionAttempt | undefined =
    reviewingIdx !== null ? attempts[reviewingIdx] : undefined;

  const finishQuizSession = useCallback(
    (
      finalAttempts: QuizQuestionAttempt[],
      finalXp: number,
      finalBestStreak: number,
      finalElapsed: number,
      currentScope: QuizScope,
      currentScopeLabel: string
    ) => {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }

      const totalQ = finalAttempts.length || 1;
      const correctCount = finalAttempts.filter((a) => a.isCorrect).length;
      const scorePercent = Math.round((correctCount / totalQ) * 100);
      const missedLessonIds = Array.from(
        new Set(finalAttempts.filter((a) => !a.isCorrect).map((a) => a.lessonId))
      );

      const sessionRecord: QuizSessionRecord = {
        id: `qsession-${Date.now()}`,
        timestamp: Date.now(),
        scope: currentScope,
        scopeLabel: currentScopeLabel,
        totalQuestions: finalAttempts.length,
        correctCount,
        scorePercent,
        xpEarned: finalXp,
        bestStreak: finalBestStreak,
        durationSeconds: Math.max(1, finalElapsed),
        missedLessonIds,
        questionResults: finalAttempts,
      };

      if (finalAttempts.length > 0) {
        saveQuizSession(sessionRecord).then(setHistory);
        if (finalXp > 0) {
          onUpdateProgress({
            ...progressRef.current,
            totalXp: (progressRef.current.totalXp || 0) + finalXp,
          });
        }
      }

      setReviewingIdx(null);
      setReviewFilter(correctCount < finalAttempts.length ? "missed" : "all");
      setStage("summary");
    },
    [onUpdateProgress]
  );

  // Start a quiz session with optional override scope/lesson/module
  const startQuiz = useCallback(
    (overrides?: {
      scope?: QuizScope;
      lessonId?: string;
      moduleId?: string;
      count?: number;
    }) => {
      const targetScope = overrides?.scope ?? scope;
      const targetLesson = overrides?.lessonId ?? selectedLessonId;
      const targetModule = overrides?.moduleId ?? selectedModuleId;
      const targetCount =
        overrides?.count ?? (targetScope === "timed-blitz" ? 12 : questionCount);

      if (overrides?.scope) setScope(overrides.scope);
      if (overrides?.lessonId) setSelectedLessonId(overrides.lessonId);
      if (overrides?.moduleId) setSelectedModuleId(overrides.moduleId);

      const plan = buildAdaptiveQuizDeck({
        progress,
        modules,
        masteryMap,
        scope: targetScope,
        selectedModuleId: targetModule,
        selectedLessonId: targetLesson,
        count: targetCount,
        difficulty: difficultyPref,
      });

      setDeck(plan.questions);
      setScopeLabel(plan.scopeLabel);
      setSelectionReason(plan.selectionReason);
      setCurrentIdx(0);
      setReviewingIdx(null);
      setSelectedOption(null);
      setShowHint(false);
      setAttempts([]);
      setStreak(0);
      setBestStreak(0);
      setSessionXp(0);
      setElapsedSeconds(0);
      setBlitzRemaining(90);
      setAiStatusNote(null);
      setActiveTab("quiz");
      setStage("active");
    },
    [
      scope,
      selectedLessonId,
      selectedModuleId,
      questionCount,
      progress,
      modules,
      masteryMap,
      difficultyPref,
    ]
  );

  // Handle requestedLessonId from CurriculumLessonReader ("Quiz Me")
  useEffect(() => {
    if (requestedLessonId) {
      startQuiz({
        scope: "current-lesson",
        lessonId: requestedLessonId,
        count: 5,
      });
      onClearRequestedLesson?.();
    }
  }, [requestedLessonId, startQuiz, onClearRequestedLesson]);

  // Active quiz timer (elapsed + countdown in timed-blitz mode)
  useEffect(() => {
    if (stage !== "active") {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    timerRef.current = window.setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
      if (scope === "timed-blitz") {
        setBlitzRemaining((prev) => Math.max(0, prev - 1));
      }
    }, 1000);

    return () => {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [stage, scope]);

  // Auto-finish timed blitz when timer reaches 0
  useEffect(() => {
    if (stage === "active" && scope === "timed-blitz" && blitzRemaining === 0) {
      finishQuizSession(
        attempts,
        sessionXp,
        bestStreak,
        elapsedSeconds,
        scope,
        scopeLabel
      );
    }
  }, [
    stage,
    scope,
    blitzRemaining,
    attempts,
    sessionXp,
    bestStreak,
    elapsedSeconds,
    scopeLabel,
    finishQuizSession,
  ]);

  const handleSelectAnswer = useCallback(
    (optionIdx: number) => {
      if (!currentQuestion || selectedOption !== null || reviewingIdx !== null) return;

      const isCorrect = optionIdx === currentQuestion.correctIndex;
      const nextStreak = isCorrect ? streak + 1 : 0;
      const nextBestStreak = Math.max(bestStreak, nextStreak);
      const baseXp =
        currentQuestion.difficulty === "advanced"
          ? 20
          : currentQuestion.difficulty === "intermediate"
          ? 15
          : 10;
      const multiplier = nextStreak >= 5 ? 2 : nextStreak >= 3 ? 1.5 : 1;
      const xpEarned = isCorrect ? Math.round(baseXp * multiplier) : 0;

      setSelectedOption(optionIdx);
      setStreak(nextStreak);
      setBestStreak(nextBestStreak);
      setSessionXp((prev) => prev + xpEarned);

      const lessonMeta = allLessons.find(
        (l) => l.lesson.id === currentQuestion.lessonId
      );
      const updatedMastery = recordLessonQuestionAttempt(masteryMap, {
        lessonId: currentQuestion.lessonId,
        lessonTitle:
          lessonMeta?.lesson.title || currentQuestion.topicTitle || "Python Topic",
        moduleId:
          lessonMeta?.module.id || currentQuestion.moduleId || "general",
        moduleTitle:
          lessonMeta?.module.title ||
          currentQuestion.moduleTitle ||
          "Python Curriculum",
        isCorrect,
      });
      setMasteryMap(updatedMastery);

      const attempt: QuizQuestionAttempt = {
        questionId: currentQuestion.id,
        lessonId: currentQuestion.lessonId,
        topicTitle: currentQuestion.topicTitle,
        question: currentQuestion.question,
        codeSnippet: currentQuestion.codeSnippet,
        options: currentQuestion.options,
        selectedIndex: optionIdx,
        correctIndex: currentQuestion.correctIndex,
        isCorrect,
        explanation: currentQuestion.explanation,
        xpEarned,
      };
      setAttempts((prev) => [...prev, attempt]);
    },
    [
      currentQuestion,
      selectedOption,
      reviewingIdx,
      streak,
      bestStreak,
      allLessons,
      masteryMap,
    ]
  );

  const handleNextQuestion = useCallback(() => {
    if (reviewingIdx !== null) {
      setReviewingIdx(null);
      return;
    }
    if (selectedOption === null) return;

    if (currentIdx + 1 >= deck.length) {
      finishQuizSession(
        attempts,
        sessionXp,
        bestStreak,
        elapsedSeconds,
        scope,
        scopeLabel
      );
    } else {
      setCurrentIdx((prev) => prev + 1);
      setSelectedOption(null);
      setShowHint(false);
      setAiStatusNote(null);
    }
  }, [
    reviewingIdx,
    selectedOption,
    currentIdx,
    deck.length,
    finishQuizSession,
    attempts,
    sessionXp,
    bestStreak,
    elapsedSeconds,
    scope,
    scopeLabel,
  ]);

  // Keyboard shortcuts during active quiz (1-4 / A-D to answer, H for hint, Enter / Right Arrow to advance)
  useEffect(() => {
    if (stage !== "active" || activeTab !== "quiz" || reviewingIdx !== null) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }

      if (selectedOption === null && currentQuestion) {
        const keyMap: Record<string, number> = {
          "1": 0,
          a: 0,
          A: 0,
          "2": 1,
          b: 1,
          B: 1,
          "3": 2,
          c: 2,
          C: 2,
          "4": 3,
          d: 3,
          D: 3,
        };
        if (e.key in keyMap) {
          const idx = keyMap[e.key];
          if (idx < currentQuestion.options.length) {
            e.preventDefault();
            handleSelectAnswer(idx);
          }
          return;
        }
        if (e.key === "h" || e.key === "H") {
          e.preventDefault();
          setShowHint((prev) => !prev);
        }
      } else if (selectedOption !== null) {
        if (e.key === "Enter" || e.key === "ArrowRight") {
          e.preventDefault();
          handleNextQuestion();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    stage,
    activeTab,
    reviewingIdx,
    selectedOption,
    currentQuestion,
    handleSelectAnswer,
    handleNextQuestion,
  ]);

  // Generate an instant local Bonus Question appended directly into the current deck ($0 API cost)
  const handleAddAiChallengeQuestion = () => {
    setIsGeneratingAiQ(true);
    setAiStatusNote(null);

    try {
      const targetLessonItem =
        allLessons.find((l) => l.lesson.id === selectedLessonId) ||
        allLessons.find((l) => l.lesson.id === progress.lastActiveLessonId) ||
        allLessons[0];

      const topicTitle = targetLessonItem?.lesson.title || "Python Fundamentals";
      const topicConcept =
        targetLessonItem?.lesson.summary ||
        targetLessonItem?.lesson.learningObjectives?.join("; ") ||
        "Variables, conditionals, loops, lists, dictionaries, and functions";

      const localQ = generateRandomQuiz(
        targetLessonItem?.lesson.id || "custom",
        topicTitle,
        topicConcept,
        difficultyPref === "beginner" ? "beginner" : "intermediate",
        targetLessonItem
          ? { id: targetLessonItem.module.id, title: targetLessonItem.module.title }
          : undefined
      );

      if (stage === "active") {
        const insertAt = currentIdx + 1;
        setDeck((prev) => [
          ...prev.slice(0, insertAt),
          localQ,
          ...prev.slice(insertAt),
        ]);
        setAiStatusNote(`Added a new question on "${topicTitle}" next.`);
      } else {
        setDeck([localQ]);
        setScopeLabel(`Quick Quiz: ${topicTitle}`);
        setSelectionReason(`Practice question for ${topicTitle}.`);
        setCurrentIdx(0);
        setReviewingIdx(null);
        setSelectedOption(null);
        setShowHint(false);
        setAttempts([]);
        setStreak(0);
        setBestStreak(0);
        setSessionXp(0);
        setElapsedSeconds(0);
        setStage("active");
      }
    } finally {
      setIsGeneratingAiQ(false);
    }
  };

  const renderCodeBlock = (code: string) => {
    const highlighted = Prism.highlight(
      code,
      Prism.languages.python,
      "python"
    );
    const lines = code.split("\n");
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#050608] overflow-hidden">
        <div className="flex items-center justify-between px-3.5 py-2 border-b border-slate-200 dark:border-slate-800/80 bg-slate-100/70 dark:bg-[#15171E]">
          <span className="text-xs font-mono text-slate-500 dark:text-[#BFC4CE]">
            Python snippet
          </span>
          <CopyCodeButton code={code} compact />
        </div>
        <div className="flex overflow-x-auto p-3 sm:p-3.5 text-xs sm:text-sm font-mono leading-relaxed">
          <div
            aria-hidden="true"
            className="select-none pr-3 mr-3 border-r border-slate-200 dark:border-slate-800 text-slate-400 dark:text-slate-600 text-right tabular-nums shrink-0"
          >
            {lines.map((_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <pre className="m-0 bg-transparent text-slate-900 dark:text-slate-100 whitespace-pre">
            <code dangerouslySetInnerHTML={{ __html: highlighted }} />
          </pre>
        </div>
      </div>
    );
  };

  const handleStartMissedPractice = () => {
    const missedIds = Array.from(
      new Set(attempts.filter((a) => !a.isCorrect).map((a) => a.lessonId))
    );
    if (missedIds.length > 0) {
      startQuiz({ scope: "weak-spots", count: Math.max(5, missedIds.length * 2) });
    } else {
      startQuiz({ scope: "adaptive" });
    }
  };

  const handleResetAllStats = async () => {
    if (!confirmResetStats) {
      setConfirmResetStats(true);
      return;
    }
    await clearAllQuizTracking();
    setMasteryMap({});
    setHistory([]);
    setConfirmResetStats(false);
  };

  // Topic Mastery summary metrics
  const topicSummaryCounts = useMemo(() => {
    let mastered = 0;
    let weak = 0;
    let untried = 0;
    for (const item of allLessons) {
      const rec = masteryMap[item.lesson.id];
      if (!rec || rec.attempts === 0) {
        untried += 1;
      } else {
        const acc = Math.round((rec.correct / rec.attempts) * 100);
        if (acc >= 75) mastered += 1;
        else weak += 1;
      }
    }
    return { mastered, weak, untried };
  }, [allLessons, masteryMap]);

  // Filtered modules for Topics tab
  const filteredTopicModules = useMemo(() => {
    const q = topicSearch.trim().toLowerCase();
    return modules
      .map((mod) => {
        const filteredLessons = mod.lessons.filter((lesson) => {
          if (q && !lesson.title.toLowerCase().includes(q) && !mod.title.toLowerCase().includes(q)) {
            return false;
          }
          const rec = masteryMap[lesson.id];
          const isDone = progress.completedLessonIds.includes(lesson.id);
          const hasAttempts = Boolean(rec && rec.attempts > 0);
          const acc = hasAttempts ? Math.round((rec.correct / rec.attempts) * 100) : null;

          if (topicFilter === "weak") return acc !== null && acc < 75;
          if (topicFilter === "completed") return isDone;
          if (topicFilter === "untried") return !hasAttempts;
          return true;
        });
        return { ...mod, lessons: filteredLessons };
      })
      .filter((mod) => mod.lessons.length > 0);
  }, [modules, topicSearch, topicFilter, masteryMap, progress.completedLessonIds]);

  const allTopicModulesExpanded = useMemo(() => {
    return (
      filteredTopicModules.length > 0 &&
      filteredTopicModules.every((m) => expandedTopicModules[m.id])
    );
  }, [filteredTopicModules, expandedTopicModules]);

  const handleToggleAllTopicModules = () => {
    const nextState = !allTopicModulesExpanded;
    const next: Record<string, boolean> = {};
    modules.forEach((m) => {
      next[m.id] = nextState;
    });
    setExpandedTopicModules(next);
  };

  // Filtered History
  const filteredHistory = useMemo(() => {
    if (historyFilter === "all") return history;
    return history.filter((s) => s.scope === historyFilter);
  }, [history, historyFilter]);

  const totalHistoryXp = useMemo(
    () => history.reduce((sum, s) => sum + (s.xpEarned || 0), 0),
    [history]
  );

  const modeOptions = useMemo(
    () =>
      [
        {
          id: "adaptive" as QuizScope,
          title: "Recommended",
          desc: "Mix of your finished lessons and weak spots",
          icon: Target,
        },
        {
          id: "current-lesson" as QuizScope,
          title: "One Lesson",
          desc: "Focus on questions from a single lesson",
          icon: BookOpen,
        },
        {
          id: "module" as QuizScope,
          title: "Full Module",
          desc: "Practice across an entire course module",
          icon: Layers,
        },
        {
          id: "weak-spots" as QuizScope,
          title: "Review Mistakes",
          desc:
            overallStats.weakLessonIds.length > 0
              ? `${overallStats.weakLessonIds.length} topic${overallStats.weakLessonIds.length === 1 ? "" : "s"} below 75%`
              : "Revisit earlier lessons you finished",
          icon: AlertTriangle,
        },
        {
          id: "timed-blitz" as QuizScope,
          title: "90s Sprint",
          desc: "Rapid-fire round against a 90 second clock",
          icon: Clock,
        },
      ] as const,
    [overallStats.weakLessonIds.length]
  );

  const difficultyLabelMap: Record<typeof difficultyPref, string> = {
    adaptive: "Auto",
    beginner: "Easy",
    intermediate: "Medium",
    mixed: "Mixed",
  };

  const activeWizardModule = useMemo(
    () => modules.find((m) => m.id === wizardLessonModuleId) || modules[0],
    [modules, wizardLessonModuleId]
  );

  const openSetupWizard = () => {
    setWizardStep(1);
    setStage("setup");
  };

  return (
    <div className="flex-1 overflow-y-auto bg-slate-50 dark:bg-[#08090D] text-slate-900 dark:text-[#F3F4F6]">
      <div className="max-w-6xl mx-auto px-3.5 sm:px-6 lg:px-8 py-4 sm:py-7 space-y-5 sm:space-y-6 pb-24 md:pb-10">
        {/* Top Page Header */}
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-3.5 pb-4 border-b border-slate-200 dark:border-slate-800">
          <div className="space-y-1">
            <h1 className="text-xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-[#F3F4F6] text-balance">
              Python Quiz
            </h1>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs sm:text-sm text-slate-600 dark:text-[#BFC4CE] tabular-nums">
              <span>
                {completedCount}/{totalCurriculumLessons} lessons done
              </span>
              <span aria-hidden="true">·</span>
              <span>{progress.totalXp || 0} XP</span>
              <span aria-hidden="true">·</span>
              <span>
                {overallStats.totalQuestionsAnswered > 0
                  ? `${overallStats.overallAccuracy}% right (${overallStats.totalQuestionsAnswered} answered)`
                  : "No quizzes taken yet"}
              </span>
            </div>
          </div>

          {/* Interactive Sub-View Navigation */}
          <div className="grid grid-cols-3 md:flex items-center gap-1 p-1 bg-slate-200/70 dark:bg-[#15171E] border border-slate-200 dark:border-slate-800 rounded-xl w-full md:w-auto">
            <button
              type="button"
              onClick={() => setActiveTab("quiz")}
              className={`min-h-[44px] flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                activeTab === "quiz"
                  ? "bg-white dark:bg-[#252933] text-slate-900 dark:text-white shadow-xs"
                  : "text-slate-600 dark:text-[#BFC4CE] hover:text-slate-900 dark:hover:text-white"
              }`}
            >
              <Target className="w-4 h-4 text-blue-600 dark:text-[#8BBEFF] shrink-0" />
              <span>Quiz</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("mastery")}
              className={`min-h-[44px] flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                activeTab === "mastery"
                  ? "bg-white dark:bg-[#252933] text-slate-900 dark:text-white shadow-xs"
                  : "text-slate-600 dark:text-[#BFC4CE] hover:text-slate-900 dark:hover:text-white"
              }`}
            >
              <BarChart3 className="w-4 h-4 text-emerald-600 dark:text-[#65D9D0] shrink-0" />
              <span>Topics</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("history")}
              className={`min-h-[44px] flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                activeTab === "history"
                  ? "bg-white dark:bg-[#252933] text-slate-900 dark:text-white shadow-xs"
                  : "text-slate-600 dark:text-[#BFC4CE] hover:text-slate-900 dark:hover:text-white"
              }`}
            >
              <History className="w-4 h-4 text-amber-500 dark:text-[#F2BC72] shrink-0" />
              <span className="tabular-nums">History ({history.length})</span>
            </button>
          </div>
        </header>

        {activeTab === "quiz" && (
          <>
            {/* ============================================================
                STAGE 1: STEP-BY-STEP QUIZ SETUP WIZARD
               ============================================================ */}
            {stage === "setup" && (
              <div className="space-y-5">
                {/* Wizard Card */}
                <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] overflow-hidden">
                  {/* Interactive 3-Step Wizard Progress Stepper */}
                  <div className="p-3 sm:p-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#08090D]/60">
                    <nav aria-label="Quiz setup steps" className="grid grid-cols-3 gap-2">
                      {(
                        [
                          { step: 1 as const, short: "Mode", full: "Choose Mode" },
                          { step: 2 as const, short: "Options", full: "Focus & Length" },
                          { step: 3 as const, short: "Start", full: "Review & Start" },
                        ] as const
                      ).map((item) => {
                        const isCurrent = wizardStep === item.step;
                        const isDone = wizardStep > item.step;
                        return (
                          <button
                            key={item.step}
                            type="button"
                            onClick={() => setWizardStep(item.step)}
                            className={`min-h-[48px] px-2.5 sm:px-4 py-2 rounded-xl border text-left transition-colors cursor-pointer flex items-center gap-2 sm:gap-3 ${
                              isCurrent
                                ? "border-blue-500 dark:border-[#8BBEFF] bg-white dark:bg-[#252933] text-slate-900 dark:text-white shadow-xs"
                                : isDone
                                ? "border-emerald-300 dark:border-emerald-800/70 bg-emerald-50/60 dark:bg-emerald-950/20 text-emerald-900 dark:text-emerald-200 hover:bg-emerald-50 dark:hover:bg-emerald-950/35"
                                : "border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-[#15171E] text-slate-500 dark:text-[#BFC4CE] hover:text-slate-900 dark:hover:text-white"
                            }`}
                          >
                            <span
                              className={`w-6 h-6 rounded-lg text-xs font-mono font-bold flex items-center justify-center shrink-0 tabular-nums ${
                                isCurrent
                                  ? "bg-blue-600 dark:bg-[#8BBEFF] text-white dark:text-[#08090D]"
                                  : isDone
                                  ? "bg-emerald-600 text-white"
                                  : "bg-slate-200 dark:bg-[#08090D] text-slate-600 dark:text-[#BFC4CE]"
                              }`}
                            >
                              {isDone ? <Check className="w-3.5 h-3.5" /> : item.step}
                            </span>
                            <div className="min-w-0">
                              <div className="text-xs sm:text-sm font-bold truncate sm:hidden">
                                {item.short}
                              </div>
                              <div className="hidden sm:block text-xs sm:text-sm font-bold truncate">
                                {item.full}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </nav>
                  </div>

                  {/* Step 1: Choose Quiz Mode */}
                  {wizardStep === 1 && (
                    <div className="p-4 sm:p-6 space-y-5">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <div>
                          <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
                            Step 1 of 3: Choose how you want to practice
                          </h2>
                          <p className="text-xs sm:text-sm text-slate-600 dark:text-[#BFC4CE] mt-0.5">
                            Pick a quiz style below, then set your topic and length next.
                          </p>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {modeOptions.map((item) => {
                          const Icon = item.icon;
                          const isActive = scope === item.id;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => setScope(item.id)}
                              className={`min-h-[96px] text-left p-4 rounded-xl border transition-all cursor-pointer flex flex-col justify-between gap-3 ${
                                isActive
                                  ? "border-blue-500 bg-blue-50/80 dark:bg-[#8BBEFF]/12 dark:border-[#8BBEFF]"
                                  : "border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 bg-slate-50/50 dark:bg-[#08090D]/50"
                              }`}
                            >
                              <div className="flex items-start justify-between gap-3 w-full">
                                <div className="w-9 h-9 rounded-lg border border-slate-200 dark:border-slate-700/80 bg-white dark:bg-[#15171E] flex items-center justify-center shrink-0">
                                  <Icon
                                    className={`w-4 h-4 ${
                                      isActive
                                        ? "text-blue-600 dark:text-[#8BBEFF]"
                                        : "text-slate-500 dark:text-slate-400"
                                    }`}
                                  />
                                </div>
                                {isActive && (
                                  <span className="inline-flex items-center gap-1 text-xs font-bold text-blue-600 dark:text-[#8BBEFF]">
                                    <Check className="w-4 h-4" />
                                    <span>Selected</span>
                                  </span>
                                )}
                              </div>
                              <div>
                                <div className="text-sm font-bold text-slate-900 dark:text-white leading-tight">
                                  {item.title}
                                </div>
                                <div className="text-xs text-slate-600 dark:text-[#BFC4CE] mt-1 leading-snug">
                                  {item.desc}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>

                      {/* Wizard Step 1 Footer */}
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-4 border-t border-slate-200 dark:border-slate-800">
                        <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                          Selected:{" "}
                          <span className="font-semibold text-slate-900 dark:text-white">
                            {modeOptions.find((m) => m.id === scope)?.title}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setWizardStep(2)}
                          className="w-full sm:w-auto min-h-[48px] flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 dark:bg-[#8BBEFF] dark:hover:bg-[#73aef8] text-white dark:text-[#08090D] font-bold text-sm shadow-xs transition-colors cursor-pointer whitespace-nowrap"
                        >
                          <span>Next: Focus & Options</span>
                          <ArrowRight className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Step 2: Focus Target + Length & Difficulty */}
                  {wizardStep === 2 && (
                    <div className="p-4 sm:p-6 space-y-6">
                      <div>
                        <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
                          Step 2 of 3: Pick focus and session options
                        </h2>
                        <p className="text-xs sm:text-sm text-slate-600 dark:text-[#BFC4CE] mt-0.5">
                          Customize what is covered and how long this quiz runs.
                        </p>
                      </div>

                      {/* Conditional Target Section */}
                      {scope === "current-lesson" && (
                        <div className="space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs sm:text-sm font-bold text-slate-800 dark:text-white">
                              Choose Lesson
                            </span>
                            <div className="flex flex-wrap items-center gap-2">
                              {progress.lastActiveLessonId && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleSelectLessonTarget(progress.lastActiveLessonId!)
                                  }
                                  className={`min-h-[44px] px-3 py-2 rounded-xl text-xs font-semibold border transition-colors cursor-pointer whitespace-nowrap ${
                                    selectedLessonId === progress.lastActiveLessonId
                                      ? "border-blue-500 bg-blue-50 dark:bg-[#8BBEFF]/15 text-blue-700 dark:text-[#8BBEFF]"
                                      : "border-slate-200 dark:border-slate-700 text-slate-600 dark:text-[#BFC4CE] hover:bg-slate-100 dark:hover:bg-[#252933]"
                                  }`}
                                >
                                  Last studied
                                </button>
                              )}
                              {weakestLessonId && (
                                <button
                                  type="button"
                                  onClick={() => handleSelectLessonTarget(weakestLessonId)}
                                  className={`min-h-[44px] px-3 py-2 rounded-xl text-xs font-semibold border transition-colors cursor-pointer whitespace-nowrap ${
                                    selectedLessonId === weakestLessonId
                                      ? "border-amber-500 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-[#F2BC72]"
                                      : "border-slate-200 dark:border-slate-700 text-slate-600 dark:text-[#BFC4CE] hover:bg-slate-100 dark:hover:bg-[#252933]"
                                  }`}
                                >
                                  Lowest score
                                </button>
                              )}
                              {nextUnfinishedLessonId && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleSelectLessonTarget(nextUnfinishedLessonId)
                                  }
                                  className={`min-h-[44px] px-3 py-2 rounded-xl text-xs font-semibold border transition-colors cursor-pointer whitespace-nowrap ${
                                    selectedLessonId === nextUnfinishedLessonId
                                      ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-[#65D9D0]"
                                      : "border-slate-200 dark:border-slate-700 text-slate-600 dark:text-[#BFC4CE] hover:bg-slate-100 dark:hover:bg-[#252933]"
                                  }`}
                                >
                                  Next lesson
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Module Dropdown Filter + Responsive Lesson Cards Grid */}
                          <select
                            id="quiz-wizard-module-filter"
                            aria-label="Filter lessons by module"
                            value={wizardLessonModuleId}
                            onChange={(e) => setWizardLessonModuleId(e.target.value)}
                            className="w-full min-h-[44px] px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#08090D] text-sm font-medium text-slate-900 dark:text-white focus:outline-hidden focus:border-blue-500"
                          >
                            {modules.map((mod) => (
                              <option key={mod.id} value={mod.id}>
                                {mod.title} ({mod.lessons.length} lessons)
                              </option>
                            ))}
                          </select>

                          {activeWizardModule && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                              {activeWizardModule.lessons.map((l) => {
                                const isChosen = selectedLessonId === l.id;
                                const isDone = progress.completedLessonIds.includes(l.id);
                                const rec = masteryMap[l.id];
                                const accText =
                                  rec && rec.attempts > 0
                                    ? `${Math.round((rec.correct / rec.attempts) * 100)}% accuracy`
                                    : "Not quizzed";
                                return (
                                  <button
                                    key={l.id}
                                    type="button"
                                    onClick={() => setSelectedLessonId(l.id)}
                                    className={`min-h-[56px] p-3.5 rounded-xl border text-left transition-colors cursor-pointer flex items-center justify-between gap-3 ${
                                      isChosen
                                        ? "border-blue-500 bg-blue-50/80 dark:bg-[#8BBEFF]/12 dark:border-[#8BBEFF]"
                                        : "border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-[#08090D]/50 hover:border-slate-300 dark:hover:border-slate-700"
                                    }`}
                                  >
                                    <div className="min-w-0">
                                      <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                                        {l.title}
                                      </div>
                                      <div className="text-xs text-slate-500 dark:text-[#BFC4CE] mt-0.5 tabular-nums">
                                        {isDone ? "Completed" : "In progress"} · {accText}
                                      </div>
                                    </div>
                                    {isChosen && (
                                      <Check className="w-4 h-4 text-blue-600 dark:text-[#8BBEFF] shrink-0" />
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}

                      {scope === "module" && (
                        <div className="space-y-3">
                          <span className="text-xs sm:text-sm font-bold text-slate-800 dark:text-white block">
                            Choose Module
                          </span>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                            {modules.map((mod) => {
                              const isChosen = selectedModuleId === mod.id;
                              const doneInMod = mod.lessons.filter((l) =>
                                progress.completedLessonIds.includes(l.id)
                              ).length;
                              const modAttempts = mod.lessons.reduce(
                                (sum, l) => sum + (masteryMap[l.id]?.attempts || 0),
                                0
                              );
                              const modCorrect = mod.lessons.reduce(
                                (sum, l) => sum + (masteryMap[l.id]?.correct || 0),
                                0
                              );
                              const modAcc =
                                modAttempts > 0
                                  ? `${Math.round((modCorrect / modAttempts) * 100)}% accuracy`
                                  : "Not quizzed";
                              return (
                                <button
                                  key={mod.id}
                                  type="button"
                                  onClick={() => setSelectedModuleId(mod.id)}
                                  className={`min-h-[64px] p-3.5 rounded-xl border text-left transition-colors cursor-pointer flex items-center justify-between gap-3 ${
                                    isChosen
                                      ? "border-blue-500 bg-blue-50/80 dark:bg-[#8BBEFF]/12 dark:border-[#8BBEFF]"
                                      : "border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-[#08090D]/50 hover:border-slate-300 dark:hover:border-slate-700"
                                  }`}
                                >
                                  <div className="min-w-0">
                                    <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                                      {mod.title}
                                    </div>
                                    <div className="text-xs text-slate-500 dark:text-[#BFC4CE] mt-0.5 tabular-nums">
                                      {doneInMod}/{mod.lessons.length} lessons done · {modAcc}
                                    </div>
                                  </div>
                                  {isChosen && (
                                    <Check className="w-4 h-4 text-blue-600 dark:text-[#8BBEFF] shrink-0" />
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {(scope === "adaptive" ||
                        scope === "weak-spots" ||
                        scope === "timed-blitz") && (
                        <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#08090D]/60 space-y-1">
                          <div className="text-xs font-bold text-slate-900 dark:text-white">
                            Topic Selection: {previewPlan.scopeLabel}
                          </div>
                          <p className="text-xs text-slate-600 dark:text-[#BFC4CE] leading-relaxed">
                            {previewPlan.selectionReason}
                          </p>
                        </div>
                      )}

                      {/* Length & Difficulty Responsive Card Grids */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 pt-2 border-t border-slate-200 dark:border-slate-800">
                        <div className="space-y-2.5">
                          <span className="text-xs sm:text-sm font-bold text-slate-800 dark:text-white block">
                            Session Length
                          </span>
                          {scope === "timed-blitz" ? (
                            <div className="min-h-[48px] px-4 py-3 rounded-xl border border-amber-300 dark:border-amber-800/70 bg-amber-50/70 dark:bg-amber-950/20 text-xs font-semibold text-amber-800 dark:text-[#F2BC72] flex items-center justify-between">
                              <span>Fixed Sprint Round</span>
                              <span className="font-mono tabular-nums">12 Qs · 90s</span>
                            </div>
                          ) : (
                            <div className="grid grid-cols-3 gap-2">
                              {[
                                { cnt: 5, tag: "Quick" },
                                { cnt: 8, tag: "Standard" },
                                { cnt: 12, tag: "Deep" },
                              ].map((opt) => {
                                const active = questionCount === opt.cnt;
                                return (
                                  <button
                                    key={opt.cnt}
                                    type="button"
                                    onClick={() => setQuestionCount(opt.cnt)}
                                    className={`min-h-[52px] py-2 px-2.5 rounded-xl border text-center transition-colors cursor-pointer ${
                                      active
                                        ? "border-blue-500 bg-blue-50/80 dark:bg-[#8BBEFF]/12 dark:border-[#8BBEFF] text-slate-900 dark:text-white"
                                        : "border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-[#08090D]/50 text-slate-600 dark:text-[#BFC4CE] hover:border-slate-300 dark:hover:border-slate-700"
                                    }`}
                                  >
                                    <div className="text-sm font-bold tabular-nums">
                                      {opt.cnt} Qs
                                    </div>
                                    <div className="text-[11px] opacity-80">{opt.tag}</div>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        <div className="space-y-2.5">
                          <span className="text-xs sm:text-sm font-bold text-slate-800 dark:text-white block">
                            Difficulty Level
                          </span>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            {(
                              [
                                { id: "adaptive", label: "Auto" },
                                { id: "beginner", label: "Easy" },
                                { id: "intermediate", label: "Medium" },
                                { id: "mixed", label: "Mixed" },
                              ] as const
                            ).map((d) => {
                              const active = difficultyPref === d.id;
                              return (
                                <button
                                  key={d.id}
                                  type="button"
                                  onClick={() => setDifficultyPref(d.id)}
                                  className={`min-h-[52px] py-2 px-3 rounded-xl border text-xs sm:text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                                    active
                                      ? "border-blue-500 bg-blue-50/80 dark:bg-[#8BBEFF]/12 dark:border-[#8BBEFF] text-slate-900 dark:text-white"
                                      : "border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-[#08090D]/50 text-slate-600 dark:text-[#BFC4CE] hover:border-slate-300 dark:hover:border-slate-700"
                                  }`}
                                >
                                  {d.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>

                      {/* Wizard Step 2 Footer */}
                      <div className="flex flex-col-reverse sm:flex-row sm:items-center justify-between gap-2.5 pt-4 border-t border-slate-200 dark:border-slate-800">
                        <button
                          type="button"
                          onClick={() => setWizardStep(1)}
                          className="w-full sm:w-auto min-h-[48px] flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-[#252933] text-slate-700 dark:text-[#F3F4F6] text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap"
                        >
                          <ArrowLeft className="w-4 h-4" />
                          <span>Back</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setWizardStep(3)}
                          className="w-full sm:w-auto min-h-[48px] flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 dark:bg-[#8BBEFF] dark:hover:bg-[#73aef8] text-white dark:text-[#08090D] font-bold text-sm shadow-xs transition-colors cursor-pointer whitespace-nowrap"
                        >
                          <span>Next: Review Plan</span>
                          <ArrowRight className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Step 3: Review Plan & Launch */}
                  {wizardStep === 3 && (
                    <div className="p-4 sm:p-6 space-y-5">
                      <div>
                        <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
                          Step 3 of 3: Ready to start
                        </h2>
                        <p className="text-xs sm:text-sm text-slate-600 dark:text-[#BFC4CE] mt-0.5">
                          {previewPlan.selectionReason}
                        </p>
                      </div>

                      {/* 3-Card Session Overview Grid */}
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#08090D]/60">
                          <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                            Quiz Mode
                          </div>
                          <div className="text-sm font-bold text-slate-900 dark:text-white mt-0.5 truncate">
                            {previewPlan.scopeLabel}
                          </div>
                        </div>
                        <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#08090D]/60">
                          <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                            Format
                          </div>
                          <div className="text-sm font-bold text-slate-900 dark:text-white mt-0.5 tabular-nums">
                            {previewPlan.questions.length} Qs · {difficultyLabelMap[difficultyPref]}
                          </div>
                        </div>
                        <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#08090D]/60">
                          <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                            Topics Covered
                          </div>
                          <div className="text-sm font-bold text-slate-900 dark:text-white mt-0.5 tabular-nums">
                            {previewPlan.targetLessonIds.length} lesson
                            {previewPlan.targetLessonIds.length === 1 ? "" : "s"}
                          </div>
                        </div>
                      </div>

                      {/* Included Lessons Grid */}
                      <div className="space-y-2.5">
                        <div className="text-xs font-bold text-slate-600 dark:text-[#BFC4CE]">
                          Lessons in this session
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                          {previewPlan.targetLessonIds.slice(0, 6).map((lid) => {
                            const found = allLessons.find((l) => l.lesson.id === lid);
                            const rec = masteryMap[lid];
                            const acc =
                              rec && rec.attempts > 0
                                ? `${Math.round((rec.correct / rec.attempts) * 100)}%`
                                : "New";
                            return (
                              <div
                                key={lid}
                                className="flex items-center justify-between gap-3 px-3.5 py-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-[#08090D]/50 text-xs"
                              >
                                <span className="font-medium text-slate-800 dark:text-slate-200 truncate">
                                  {found?.lesson.title || lid}
                                </span>
                                <span className="font-mono text-slate-500 dark:text-[#BFC4CE] tabular-nums shrink-0">
                                  {acc}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      {/* Wizard Step 3 Launch Footer */}
                      <div className="flex flex-col-reverse sm:flex-row sm:items-center justify-between gap-2.5 pt-4 border-t border-slate-200 dark:border-slate-800">
                        <div className="grid grid-cols-2 sm:flex items-center gap-2.5">
                          <button
                            type="button"
                            onClick={() => setWizardStep(2)}
                            className="min-h-[48px] flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-[#252933] text-slate-700 dark:text-[#F3F4F6] text-xs sm:text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap"
                          >
                            <ArrowLeft className="w-4 h-4" />
                            <span>Back</span>
                          </button>

                          <button
                            type="button"
                            onClick={handleAddAiChallengeQuestion}
                            disabled={isGeneratingAiQ}
                            className="min-h-[48px] flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-[#252933] text-slate-700 dark:text-[#F3F4F6] text-xs sm:text-sm font-semibold transition-colors cursor-pointer disabled:opacity-60 whitespace-nowrap"
                          >
                            {isGeneratingAiQ ? (
                              <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                <span>Loading...</span>
                              </>
                            ) : (
                              <>
                                <RefreshCw className="w-4 h-4 text-blue-600 dark:text-[#8BBEFF]" />
                                <span>1-Q Warmup</span>
                              </>
                            )}
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={() => startQuiz()}
                          className="w-full sm:w-auto min-h-[48px] flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 dark:bg-[#8BBEFF] dark:hover:bg-[#73aef8] text-white dark:text-[#08090D] font-bold text-sm shadow-sm transition-colors cursor-pointer whitespace-nowrap"
                        >
                          <Play className="w-4 h-4 fill-current" />
                          <span>Start Quiz ({previewPlan.questions.length} Qs)</span>
                        </button>
                      </div>
                    </div>
                  )}
                </section>

                {/* Lifetime Quick Stats Cards Row */}
                <div className="grid grid-cols-3 gap-2.5 sm:gap-4">
                  <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] p-3.5 sm:p-5">
                    <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                      Quizzes Taken
                    </div>
                    <div className="text-xl sm:text-2xl font-bold tabular-nums text-slate-900 dark:text-white mt-0.5">
                      {overallStats.totalQuizzes}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] p-3.5 sm:p-5">
                    <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                      Accuracy
                    </div>
                    <div className="text-xl sm:text-2xl font-bold tabular-nums text-emerald-600 dark:text-[#65D9D0] mt-0.5">
                      {overallStats.totalQuestionsAnswered > 0
                        ? `${overallStats.overallAccuracy}%`
                        : "—"}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] p-3.5 sm:p-5">
                    <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                      Best Streak
                    </div>
                    <div className="text-xl sm:text-2xl font-bold tabular-nums text-amber-600 dark:text-[#F2BC72] mt-0.5">
                      {overallStats.bestSessionStreak}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ============================================================
                STAGE 2: ACTIVE INTERACTIVE QUIZ STAGE
               ============================================================ */}
            {stage === "active" && currentQuestion && (
              <div className="space-y-4">
                {/* Mobile & Tablet Live HUD + Touch Progress Stepper (< lg) */}
                <div className="lg:hidden rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] p-3.5 space-y-3">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-bold text-slate-900 dark:text-white truncate">
                        {scopeLabel}
                      </span>
                      <span className="text-slate-400" aria-hidden="true">·</span>
                      {scope === "timed-blitz" ? (
                        <span
                          className={`font-mono font-bold tabular-nums shrink-0 ${
                            blitzRemaining <= 15
                              ? "text-rose-600 dark:text-rose-400"
                              : "text-amber-600 dark:text-[#F2BC72]"
                          }`}
                        >
                          {blitzRemaining}s left
                        </span>
                      ) : (
                        <span className="font-mono text-slate-500 dark:text-[#BFC4CE] tabular-nums shrink-0">
                          {formatDuration(elapsedSeconds)}
                        </span>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={openSetupWizard}
                      className="min-h-[44px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-[#BFC4CE] hover:text-slate-900 dark:hover:text-white bg-slate-50 dark:bg-[#08090D] cursor-pointer shrink-0 whitespace-nowrap"
                    >
                      Setup
                    </button>
                  </div>

                  {/* Mobile Live Metrics Row */}
                  <div className="flex items-center justify-between gap-3 text-xs tabular-nums">
                    <div className="flex items-center gap-3">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        {attempts.filter((a) => a.isCorrect).length}/{attempts.length} right
                      </span>
                      <span className="flex items-center gap-1 font-semibold text-amber-600 dark:text-[#F2BC72]">
                        <Flame className="w-3.5 h-3.5" />
                        {streak}
                      </span>
                      <span className="font-semibold text-emerald-600 dark:text-[#65D9D0]">
                        +{sessionXp} XP
                      </span>
                    </div>
                    {attempts.length > 0 && currentIdx + 1 < deck.length && (
                      <button
                        type="button"
                        onClick={() =>
                          finishQuizSession(
                            attempts,
                            sessionXp,
                            bestStreak,
                            elapsedSeconds,
                            scope,
                            scopeLabel
                          )
                        }
                        className="min-h-[36px] px-2.5 py-1 rounded-lg text-xs font-semibold text-blue-600 dark:text-[#8BBEFF] hover:bg-blue-50 dark:hover:bg-[#8BBEFF]/10 cursor-pointer whitespace-nowrap"
                      >
                        Finish now
                      </button>
                    )}
                  </div>

                  {/* Mobile Scrollable Touch Progress Stepper (44x44px hit targets) */}
                  <div className="pt-2 border-t border-slate-100 dark:border-slate-800/80">
                    <div
                      className="flex items-center gap-2 overflow-x-auto py-1 no-scrollbar snap-x"
                      role="navigation"
                      aria-label="Question progress stepper"
                    >
                      {deck.map((q, i) => {
                        const att = attempts[i];
                        const isViewingThis =
                          reviewingIdx !== null ? reviewingIdx === i : i === currentIdx;
                        const canClick = Boolean(att) || i === currentIdx;
                        let stepCls =
                          "border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#08090D] text-slate-400";
                        if (att) {
                          stepCls = att.isCorrect
                            ? "border-emerald-500/70 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-bold"
                            : "border-rose-500/70 bg-rose-500/15 text-rose-700 dark:text-rose-300 font-bold";
                        } else if (i === currentIdx) {
                          stepCls =
                            "border-blue-600 dark:border-[#8BBEFF] bg-blue-50 dark:bg-[#8BBEFF]/15 text-blue-700 dark:text-[#8BBEFF] font-bold";
                        }
                        return (
                          <button
                            key={q.id}
                            ref={(el) => {
                              stepperBtnRefs.current[i] = el;
                            }}
                            type="button"
                            disabled={!canClick}
                            onClick={() => {
                              if (i === currentIdx) setReviewingIdx(null);
                              else if (att) setReviewingIdx(i);
                            }}
                            aria-label={
                              att
                                ? `Review question ${i + 1}`
                                : `Question ${i + 1}`
                            }
                            className={`min-w-[44px] h-11 rounded-xl border text-xs font-mono tabular-nums flex items-center justify-center shrink-0 snap-center transition-colors ${stepCls} ${
                              isViewingThis ? "ring-2 ring-blue-500/45" : ""
                            } ${canClick ? "cursor-pointer" : "cursor-default"}`}
                          >
                            {att ? (
                              att.isCorrect ? (
                                <span className="flex items-center gap-0.5">
                                  <span>{i + 1}</span>
                                </span>
                              ) : (
                                <span>{i + 1}</span>
                              )
                            ) : (
                              i + 1
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-[1.65fr_1fr] gap-5 lg:gap-6 items-start">
                  {/* Inspecting Previously Answered Question vs Active Question */}
                  {inspectedAttempt && reviewingIdx !== null ? (
                    <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] p-4 sm:p-6 space-y-5">
                      <div className="flex flex-wrap items-center justify-between gap-2.5 pb-3 border-b border-slate-200 dark:border-slate-800">
                        <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-[#BFC4CE]">
                          <span className="font-bold text-slate-900 dark:text-white">
                            Reviewing Question {reviewingIdx + 1}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{inspectedAttempt.topicTitle}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setReviewingIdx(null)}
                          className="min-h-[44px] inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 dark:bg-[#8BBEFF] dark:hover:bg-[#73aef8] text-white dark:text-[#08090D] text-xs font-bold cursor-pointer whitespace-nowrap"
                        >
                          <ArrowLeft className="w-4 h-4" />
                          <span>Back to Question {currentIdx + 1}</span>
                        </button>
                      </div>

                      <h2 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white leading-snug text-balance">
                        {inspectedAttempt.question}
                      </h2>

                      {inspectedAttempt.codeSnippet &&
                        renderCodeBlock(inspectedAttempt.codeSnippet)}

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                        <div
                          className={`p-3.5 rounded-xl border ${
                            inspectedAttempt.isCorrect
                              ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/25 text-emerald-900 dark:text-emerald-200"
                              : "border-rose-300 dark:border-rose-800 bg-rose-50/60 dark:bg-rose-950/25 text-rose-900 dark:text-rose-200"
                          }`}
                        >
                          <span className="font-semibold">Your answer: </span>
                          <span>
                            {inspectedAttempt.options[inspectedAttempt.selectedIndex]}
                          </span>
                        </div>
                        {!inspectedAttempt.isCorrect && (
                          <div className="p-3.5 rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/25 text-emerald-900 dark:text-emerald-200">
                            <span className="font-semibold">Correct answer: </span>
                            <span>
                              {inspectedAttempt.options[inspectedAttempt.correctIndex]}
                            </span>
                          </div>
                        )}
                      </div>

                      <p className="text-xs sm:text-sm text-slate-700 dark:text-slate-200 leading-relaxed whitespace-pre-line">
                        {inspectedAttempt.explanation}
                      </p>

                      <QuizFeedbackActionsBar
                        codeSnippet={inspectedAttempt.codeSnippet}
                        lessonId={inspectedAttempt.lessonId}
                        hasLesson={allLessons.some(
                          (l) => l.lesson.id === inspectedAttempt.lessonId
                        )}
                        topicTitle={inspectedAttempt.topicTitle}
                        question={inspectedAttempt.question}
                        options={inspectedAttempt.options}
                        selectedIndex={inspectedAttempt.selectedIndex}
                        correctIndex={inspectedAttempt.correctIndex}
                        isCorrect={inspectedAttempt.isCorrect}
                        explanation={inspectedAttempt.explanation}
                        onPracticeClick={(snippet) =>
                          onPracticeClick(snippet, {
                            topicTitle: inspectedAttempt.topicTitle,
                            question: inspectedAttempt.question,
                          })
                        }
                        onOpenLesson={(lid) =>
                          onOpenLesson(lid, {
                            topicTitle: inspectedAttempt.topicTitle,
                            question: inspectedAttempt.question,
                          })
                        }
                        onOpenAiAssist={onOpenAiAssist}
                      />
                    </section>
                  ) : (
                    /* Primary Question Zone */
                    <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] p-4 sm:p-6 space-y-5">
                      {/* Question Progress Header */}
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-[#BFC4CE]">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="font-bold text-slate-900 dark:text-white tabular-nums">
                              Question {currentIdx + 1} of {deck.length}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>{currentQuestion.topicTitle}</span>
                            {currentQuestion.conceptTag && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span>{currentQuestion.conceptTag}</span>
                              </>
                            )}
                            <span aria-hidden="true">·</span>
                            <span className="capitalize">{currentQuestion.difficulty}</span>
                          </div>

                          {scope === "timed-blitz" ? (
                            <div
                              className={`hidden lg:flex items-center gap-1.5 font-mono font-bold tabular-nums ${
                                blitzRemaining <= 15
                                  ? "text-rose-600 dark:text-rose-400"
                                  : "text-amber-600 dark:text-[#F2BC72]"
                              }`}
                            >
                              <Clock className="w-3.5 h-3.5" />
                              <span>{blitzRemaining}s left</span>
                            </div>
                          ) : (
                            <div className="hidden lg:flex items-center gap-1.5 font-mono tabular-nums">
                              <Clock className="w-3.5 h-3.5" />
                              <span>{formatDuration(elapsedSeconds)}</span>
                            </div>
                          )}
                        </div>

                        {/* Smooth Progress Bar */}
                        <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-[#08090D] overflow-hidden">
                          <div
                            className="h-full bg-blue-600 dark:bg-[#8BBEFF] transition-all duration-200"
                            style={{
                              width: `${Math.round(
                                ((currentIdx + (selectedOption !== null ? 1 : 0)) /
                                  Math.max(1, deck.length)) *
                                  100
                              )}%`,
                            }}
                          />
                        </div>
                      </div>

                      {/* Question Prompt */}
                      <h2 className="text-base sm:text-xl font-bold text-slate-900 dark:text-white leading-snug text-balance">
                        {currentQuestion.question}
                      </h2>

                      {/* Syntax-Highlighted Python Code Block */}
                      {currentQuestion.codeSnippet &&
                        renderCodeBlock(currentQuestion.codeSnippet)}

                      {/* Hint Control & Drawer (44px+ hit area) */}
                      {selectedOption === null && currentQuestion.hint && (
                        <div>
                          <button
                            type="button"
                            onClick={() => setShowHint((prev) => !prev)}
                            className="min-h-[44px] inline-flex items-center gap-2 px-3 py-2 -ml-3 rounded-xl text-xs font-semibold text-amber-700 dark:text-[#F2BC72] hover:bg-amber-50 dark:hover:bg-amber-950/25 transition-colors cursor-pointer"
                          >
                            <Lightbulb className="w-4 h-4 shrink-0" />
                            <span>{showHint ? "Hide Hint (H)" : "Show Hint (H)"}</span>
                          </button>
                          {showHint && (
                            <div className="mt-2 p-3.5 rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50/70 dark:bg-amber-950/25 text-xs sm:text-sm text-amber-900 dark:text-amber-200 leading-relaxed">
                              {currentQuestion.hint}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Responsive Card Grid for Answer Choices */}
                      {(() => {
                        const useTwoColGrid = currentQuestion.options.every(
                          (opt) => !opt.includes("\n") && opt.length <= 42
                        );
                        return (
                          <div
                            className={`grid gap-2.5 sm:gap-3 pt-1 ${
                              useTwoColGrid ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"
                            }`}
                            role="radiogroup"
                            aria-label="Answer options"
                          >
                            {currentQuestion.options.map((opt, idx) => {
                              const hasAnswered = selectedOption !== null;
                              const isSelected = selectedOption === idx;
                              const isCorrect = idx === currentQuestion.correctIndex;

                              let cardClass =
                                "border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-[#08090D]/60 hover:border-blue-400 dark:hover:border-[#8BBEFF]/60 hover:bg-white dark:hover:bg-[#1c1f28] text-slate-900 dark:text-slate-100";

                              if (hasAnswered) {
                                if (isCorrect) {
                                  cardClass =
                                    "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/35 text-emerald-950 dark:text-emerald-100";
                                } else if (isSelected) {
                                  cardClass =
                                    "border-rose-500 bg-rose-50 dark:bg-rose-950/35 text-rose-950 dark:text-rose-100";
                                } else {
                                  cardClass =
                                    "border-slate-200/70 dark:border-slate-800/70 bg-slate-50/30 dark:bg-[#08090D]/30 text-slate-500 dark:text-slate-500 opacity-75";
                                }
                              }

                              return (
                                <button
                                  key={idx}
                                  type="button"
                                  disabled={hasAnswered}
                                  onClick={() => handleSelectAnswer(idx)}
                                  className={`w-full min-h-[56px] text-left px-3.5 sm:px-4 py-3.5 rounded-xl border transition-all duration-150 flex items-center justify-between gap-3 ${
                                    hasAnswered ? "cursor-default" : "cursor-pointer active:scale-[0.99]"
                                  } ${cardClass}`}
                                >
                                  <div className="flex items-start gap-3 min-w-0">
                                    <span
                                      className={`w-7 h-7 rounded-lg border text-xs font-mono font-bold flex items-center justify-center shrink-0 mt-0.5 ${
                                        hasAnswered && isCorrect
                                          ? "border-emerald-600 bg-emerald-600 text-white"
                                          : hasAnswered && isSelected && !isCorrect
                                          ? "border-rose-600 bg-rose-600 text-white"
                                          : "border-slate-300 dark:border-slate-700 bg-white dark:bg-[#15171E] text-slate-700 dark:text-slate-300"
                                      }`}
                                    >
                                      {OPTION_LETTERS[idx] || idx + 1}
                                    </span>
                                    <span className="text-sm font-medium whitespace-pre-wrap break-words font-sans leading-snug">
                                      {opt}
                                    </span>
                                  </div>

                                  <div className="shrink-0 flex items-center gap-1.5">
                                    {hasAnswered && isCorrect && (
                                      <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                                    )}
                                    {hasAnswered && isSelected && !isCorrect && (
                                      <XCircle className="w-4 h-4 text-rose-600 dark:text-rose-400" />
                                    )}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        );
                      })()}

                      {/* Immediate Feedback Box */}
                      {selectedOption !== null && (
                        <div
                          className={`rounded-xl border p-4 space-y-3.5 ${
                            selectedOption === currentQuestion.correctIndex
                              ? "border-emerald-300 dark:border-emerald-800/70 bg-emerald-50/70 dark:bg-emerald-950/25"
                              : "border-rose-300 dark:border-rose-800/70 bg-rose-50/70 dark:bg-rose-950/25"
                          }`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2 font-bold text-sm">
                              {selectedOption === currentQuestion.correctIndex ? (
                                <>
                                  <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                                  <span className="text-emerald-900 dark:text-emerald-200">
                                    Correct
                                  </span>
                                  <span className="text-xs font-mono text-emerald-700 dark:text-emerald-400 tabular-nums">
                                    · +{attempts[attempts.length - 1]?.xpEarned || 10} XP
                                    {streak >= 3 ? ` (${streak} streak)` : ""}
                                  </span>
                                </>
                              ) : (
                                <>
                                  <XCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
                                  <span className="text-rose-900 dark:text-rose-200">
                                    Not quite — answer is{" "}
                                    {OPTION_LETTERS[currentQuestion.correctIndex]}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>

                          <p className="text-xs sm:text-sm text-slate-700 dark:text-slate-200 leading-relaxed whitespace-pre-line">
                            {currentQuestion.explanation}
                          </p>

                          {/* Interactive Action Bar & Live Mini-Sandbox */}
                          <QuizFeedbackActionsBar
                            codeSnippet={currentQuestion.codeSnippet}
                            lessonId={currentQuestion.lessonId}
                            hasLesson={allLessons.some(
                              (l) => l.lesson.id === currentQuestion.lessonId
                            )}
                            topicTitle={currentQuestion.topicTitle}
                            question={currentQuestion.question}
                            options={currentQuestion.options}
                            selectedIndex={selectedOption}
                            correctIndex={currentQuestion.correctIndex}
                            isCorrect={selectedOption === currentQuestion.correctIndex}
                            explanation={currentQuestion.explanation}
                            onPracticeClick={(snippet) =>
                              onPracticeClick(snippet, {
                                topicTitle: currentQuestion.topicTitle,
                                question: currentQuestion.question,
                              })
                            }
                            onOpenLesson={(lid) =>
                              onOpenLesson(lid, {
                                topicTitle: currentQuestion.topicTitle,
                                question: currentQuestion.question,
                              })
                            }
                            onOpenAiAssist={onOpenAiAssist}
                            rightAction={
                              <button
                                type="button"
                                onClick={handleNextQuestion}
                                className="w-full sm:w-auto min-h-[48px] flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 dark:bg-[#8BBEFF] dark:hover:bg-[#73aef8] text-white dark:text-[#08090D] font-bold text-sm shadow-xs transition-colors cursor-pointer sm:ml-auto whitespace-nowrap"
                              >
                                <span>
                                  {currentIdx + 1 >= deck.length
                                    ? "Finish Quiz"
                                    : "Next Question"}
                                </span>
                                <ArrowRight className="w-4 h-4" />
                              </button>
                            }
                          />
                        </div>
                      )}

                      {aiStatusNote && (
                        <div className="text-xs text-blue-700 dark:text-[#8BBEFF]">
                          {aiStatusNote}
                        </div>
                      )}
                    </section>
                  )}

                  {/* Desktop Quiz Telemetry & Interactive Question Stepper Sidebar */}
                  <aside className="hidden lg:block rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] p-5 space-y-5 lg:sticky lg:top-6">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                          Mode
                        </div>
                        <div className="text-sm font-bold text-slate-900 dark:text-white truncate">
                          {scopeLabel}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={openSetupWizard}
                        className="min-h-[44px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-600 hover:text-slate-900 dark:text-[#BFC4CE] dark:hover:text-white hover:bg-slate-50 dark:hover:bg-[#252933] cursor-pointer shrink-0"
                      >
                        Setup
                      </button>
                    </div>

                    <div className="grid grid-cols-3 gap-2.5">
                      <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#08090D]/60">
                        <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                          Score
                        </div>
                        <div className="text-lg font-bold tabular-nums text-slate-900 dark:text-white">
                          {attempts.filter((a) => a.isCorrect).length}/{attempts.length}
                        </div>
                      </div>
                      <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#08090D]/60">
                        <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                          Streak
                        </div>
                        <div className="text-lg font-bold tabular-nums flex items-center gap-1 text-amber-600 dark:text-[#F2BC72]">
                          <Flame className="w-4 h-4 shrink-0" />
                          <span>{streak}</span>
                        </div>
                      </div>
                      <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#08090D]/60">
                        <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                          XP
                        </div>
                        <div className="text-lg font-bold tabular-nums text-emerald-600 dark:text-[#65D9D0]">
                          +{sessionXp}
                        </div>
                      </div>
                    </div>

                    {/* Interactive Question Progress Map */}
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-[#BFC4CE]">
                        <span className="font-semibold">Question Stepper</span>
                        {attempts.length > 0 && (
                          <span className="text-[11px]">Click answered to review</span>
                        )}
                      </div>
                      <div className="grid grid-cols-5 gap-2">
                        {deck.map((q, i) => {
                          const att = attempts[i];
                          const isCurr = i === currentIdx;
                          const isViewing =
                            reviewingIdx !== null ? reviewingIdx === i : isCurr;
                          const canClick = Boolean(att) || isCurr;
                          let boxCls =
                            "border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#08090D] text-slate-500 dark:text-slate-400";
                          if (att) {
                            boxCls = att.isCorrect
                              ? "border-emerald-500/70 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-bold hover:bg-emerald-500/25"
                              : "border-rose-500/70 bg-rose-500/15 text-rose-700 dark:text-rose-300 font-bold hover:bg-rose-500/25";
                          } else if (isCurr) {
                            boxCls =
                              "border-blue-600 dark:border-[#8BBEFF] bg-blue-50 dark:bg-[#8BBEFF]/15 text-blue-700 dark:text-[#8BBEFF] font-bold";
                          }
                          return (
                            <button
                              key={q.id}
                              type="button"
                              disabled={!canClick}
                              onClick={() => {
                                if (isCurr) setReviewingIdx(null);
                                else if (att) setReviewingIdx(i);
                              }}
                              className={`h-10 rounded-xl border text-xs font-mono tabular-nums flex items-center justify-center transition-all ${boxCls} ${
                                isViewing ? "ring-2 ring-blue-500/40" : ""
                              } ${canClick ? "cursor-pointer" : "cursor-default"}`}
                              title={
                                att
                                  ? `Review Q${i + 1}: ${q.topicTitle}`
                                  : q.topicTitle
                              }
                            >
                              {i + 1}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Mid-session actions */}
                    <div className="space-y-2">
                      <button
                        type="button"
                        onClick={handleAddAiChallengeQuestion}
                        disabled={isGeneratingAiQ}
                        className="w-full min-h-[44px] flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-[#252933] text-xs font-semibold text-slate-700 dark:text-[#F3F4F6] transition-colors cursor-pointer disabled:opacity-60"
                      >
                        {isGeneratingAiQ ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>Loading...</span>
                          </>
                        ) : (
                          <>
                            <RefreshCw className="w-4 h-4 text-blue-600 dark:text-[#8BBEFF]" />
                            <span>Add Extra Question</span>
                          </>
                        )}
                      </button>

                      {attempts.length > 0 && currentIdx + 1 < deck.length && (
                        <button
                          type="button"
                          onClick={() =>
                            finishQuizSession(
                              attempts,
                              sessionXp,
                              bestStreak,
                              elapsedSeconds,
                              scope,
                              scopeLabel
                            )
                          }
                          className="w-full min-h-[44px] py-2 px-3 rounded-xl text-xs font-semibold text-slate-600 dark:text-[#BFC4CE] hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-[#252933] transition-colors cursor-pointer"
                        >
                          Finish & Save Now ({attempts.length} answered)
                        </button>
                      )}
                    </div>

                    {/* Keyboard Shortcuts */}
                    <div className="pt-3 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-[#BFC4CE] flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span>
                        <kbd className="font-mono font-bold text-slate-700 dark:text-slate-300">
                          1-4
                        </kbd>{" "}
                        Answer
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        <kbd className="font-mono font-bold text-slate-700 dark:text-slate-300">
                          H
                        </kbd>{" "}
                        Hint
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        <kbd className="font-mono font-bold text-slate-700 dark:text-slate-300">
                          Enter
                        </kbd>{" "}
                        Next
                      </span>
                    </div>
                  </aside>
                </div>
              </div>
            )}

            {/* ============================================================
                STAGE 3: ORGANIZED CARD-BASED QUIZ SUMMARY
               ============================================================ */}
            {stage === "summary" && (
              <div className="space-y-5">
                {(() => {
                  const totalQ = attempts.length || 1;
                  const correctCount = attempts.filter((a) => a.isCorrect).length;
                  const missedCount = attempts.length - correctCount;
                  const pct = Math.round((correctCount / totalQ) * 100);
                  const verdict =
                    pct >= 90
                      ? "Great Score!"
                      : pct >= 75
                      ? "Well Done!"
                      : pct >= 50
                      ? "Good Start"
                      : "Keep Practicing";

                  const topicStats = Array.from(
                    attempts.reduce((map, a) => {
                      const prev = map.get(a.lessonId) || {
                        lessonId: a.lessonId,
                        topicTitle: a.topicTitle,
                        correct: 0,
                        total: 0,
                      };
                      prev.total += 1;
                      if (a.isCorrect) prev.correct += 1;
                      map.set(a.lessonId, prev);
                      return map;
                    }, new Map<string, { lessonId: string; topicTitle: string; correct: number; total: number }>())
                  ).map(([, v]) => v);

                  const filteredAttempts = attempts.filter((a) => {
                    if (reviewFilter === "missed") return !a.isCorrect;
                    if (reviewFilter === "correct") return a.isCorrect;
                    return true;
                  });

                  return (
                    <>
                      <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] p-5 sm:p-7 space-y-5">
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-2 text-xs font-semibold text-blue-600 dark:text-[#8BBEFF]">
                            <Trophy className="w-4 h-4" />
                            <span>{scopeLabel}</span>
                          </div>
                          <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white">
                            {verdict}
                          </h2>
                          <p className="text-sm text-slate-600 dark:text-[#BFC4CE]">
                            Your scores and XP are saved locally on this device.
                          </p>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                          <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#08090D]/60">
                            <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                              Score
                            </div>
                            <div className="text-lg sm:text-xl font-bold tabular-nums text-slate-900 dark:text-white mt-0.5">
                              {correctCount}/{attempts.length} ({pct}%)
                            </div>
                          </div>
                          <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#08090D]/60">
                            <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                              XP Earned
                            </div>
                            <div className="text-lg sm:text-xl font-bold tabular-nums text-emerald-600 dark:text-[#65D9D0] mt-0.5">
                              +{sessionXp}
                            </div>
                          </div>
                          <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#08090D]/60">
                            <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                              Best Streak
                            </div>
                            <div className="text-lg sm:text-xl font-bold tabular-nums text-amber-600 dark:text-[#F2BC72] mt-0.5">
                              {bestStreak}
                            </div>
                          </div>
                          <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#08090D]/60">
                            <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                              Time
                            </div>
                            <div className="text-lg sm:text-xl font-bold tabular-nums text-slate-900 dark:text-white mt-0.5">
                              {formatDuration(elapsedSeconds)}
                            </div>
                          </div>
                        </div>
                      </section>

                      {/* Topics Covered Breakdown */}
                      {topicStats.length > 0 && (
                        <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] p-4 sm:p-5 space-y-3">
                          <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                            Breakdown by Topic
                          </h3>
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            {topicStats.map((ts) => {
                              const tPct = Math.round((ts.correct / ts.total) * 100);
                              const hasLessonMatch = allLessons.some(
                                (l) => l.lesson.id === ts.lessonId
                              );
                              return (
                                <div
                                  key={ts.lessonId}
                                  className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-[#08090D]/50 flex items-center justify-between gap-3"
                                >
                                  <div className="min-w-0 flex-1 space-y-1.5">
                                    <div className="text-xs sm:text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                                      {ts.topicTitle}
                                    </div>
                                    <div className="h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                                      <div
                                        className={`h-full rounded-full ${
                                          tPct >= 75
                                            ? "bg-emerald-500 dark:bg-[#65D9D0]"
                                            : "bg-rose-500"
                                        }`}
                                        style={{ width: `${tPct}%` }}
                                      />
                                    </div>
                                    <div
                                      className={`text-xs font-mono tabular-nums ${
                                        tPct >= 75
                                          ? "text-emerald-600 dark:text-[#65D9D0]"
                                          : "text-rose-600 dark:text-rose-400"
                                      }`}
                                    >
                                      {ts.correct}/{ts.total} right ({tPct}%)
                                    </div>
                                  </div>
                                  {hasLessonMatch && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        onOpenLesson(ts.lessonId, {
                                          topicTitle: ts.topicTitle,
                                        })
                                      }
                                      className="min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-[#252933] text-xs font-semibold text-slate-700 dark:text-[#BFC4CE] shrink-0 cursor-pointer"
                                    >
                                      Lesson
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </section>
                      )}

                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => startQuiz()}
                            className={`min-h-[44px] flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 dark:bg-[#8BBEFF] dark:hover:bg-[#73aef8] text-white dark:text-[#08090D] font-bold text-sm transition-colors cursor-pointer whitespace-nowrap ${
                              missedCount === 0 ? "col-span-2" : ""
                            }`}
                          >
                            <RotateCcw className="w-4 h-4" />
                            <span>Try Another</span>
                          </button>

                          {missedCount > 0 && (
                            <button
                              type="button"
                              onClick={handleStartMissedPractice}
                              className="min-h-[44px] flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#15171E] hover:bg-slate-100 dark:hover:bg-[#252933] text-slate-800 dark:text-white text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap"
                            >
                              <AlertTriangle className="w-4 h-4 text-amber-500" />
                              <span>Retry Missed</span>
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={openSetupWizard}
                            className="col-span-2 sm:col-span-1 min-h-[44px] px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] text-slate-600 dark:text-[#BFC4CE] hover:text-slate-900 dark:hover:text-white text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap"
                          >
                            New Setup
                          </button>
                        </div>

                        {/* Review Filter */}
                        <div className="grid grid-cols-3 sm:flex items-center gap-1 p-1 bg-slate-200/70 dark:bg-[#15171E] border border-slate-200 dark:border-slate-800 rounded-xl w-full sm:w-auto">
                          <button
                            type="button"
                            onClick={() => setReviewFilter("all")}
                            className={`min-h-[44px] px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer tabular-nums whitespace-nowrap ${
                              reviewFilter === "all"
                                ? "bg-white dark:bg-[#252933] text-slate-900 dark:text-white shadow-xs"
                                : "text-slate-600 dark:text-[#BFC4CE]"
                            }`}
                          >
                            All ({attempts.length})
                          </button>
                          <button
                            type="button"
                            onClick={() => setReviewFilter("missed")}
                            className={`min-h-[44px] px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer tabular-nums whitespace-nowrap ${
                              reviewFilter === "missed"
                                ? "bg-white dark:bg-[#252933] text-slate-900 dark:text-white shadow-xs"
                                : "text-slate-600 dark:text-[#BFC4CE]"
                            }`}
                          >
                            Missed ({missedCount})
                          </button>
                          <button
                            type="button"
                            onClick={() => setReviewFilter("correct")}
                            className={`min-h-[44px] px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer tabular-nums whitespace-nowrap ${
                              reviewFilter === "correct"
                                ? "bg-white dark:bg-[#252933] text-slate-900 dark:text-white shadow-xs"
                                : "text-slate-600 dark:text-[#BFC4CE]"
                            }`}
                          >
                            Correct ({correctCount})
                          </button>
                        </div>
                      </div>

                      {/* Detailed Question Review Cards */}
                      <div className="space-y-4">
                        {filteredAttempts.length === 0 ? (
                          <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] p-8 text-center text-sm text-slate-500 dark:text-[#BFC4CE]">
                            No questions in this filter.
                          </div>
                        ) : (
                          filteredAttempts.map((att, idx) => (
                            <div
                              key={`${att.questionId}-${idx}`}
                              className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] p-4 sm:p-5 space-y-3"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="text-xs font-semibold text-slate-900 dark:text-white">
                                  {att.topicTitle}
                                </span>
                                {att.isCorrect ? (
                                  <span className="flex items-center gap-1 text-xs font-bold text-emerald-600 dark:text-emerald-400">
                                    <CheckCircle2 className="w-4 h-4" />
                                    <span>Correct</span>
                                  </span>
                                ) : (
                                  <span className="flex items-center gap-1 text-xs font-bold text-rose-600 dark:text-rose-400">
                                    <XCircle className="w-4 h-4" />
                                    <span>Missed</span>
                                  </span>
                                )}
                              </div>

                              <h3 className="text-sm sm:text-base font-semibold text-slate-900 dark:text-white">
                                {att.question}
                              </h3>

                              {att.codeSnippet && renderCodeBlock(att.codeSnippet)}

                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                                <div
                                  className={`p-3 rounded-xl border ${
                                    att.isCorrect
                                      ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/25 text-emerald-900 dark:text-emerald-200"
                                      : "border-rose-300 dark:border-rose-800 bg-rose-50/60 dark:bg-rose-950/25 text-rose-900 dark:text-rose-200"
                                  }`}
                                >
                                  <span className="font-semibold">Your answer: </span>
                                  <span>{att.options[att.selectedIndex]}</span>
                                </div>
                                {!att.isCorrect && (
                                  <div className="p-3 rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/25 text-emerald-900 dark:text-emerald-200">
                                    <span className="font-semibold">Correct answer: </span>
                                    <span>{att.options[att.correctIndex]}</span>
                                  </div>
                                )}
                              </div>

                              <p className="text-xs sm:text-sm text-slate-600 dark:text-[#BFC4CE] leading-relaxed">
                                {att.explanation}
                              </p>

                              <QuizFeedbackActionsBar
                                codeSnippet={att.codeSnippet}
                                lessonId={att.lessonId}
                                hasLesson={allLessons.some(
                                  (l) => l.lesson.id === att.lessonId
                                )}
                                topicTitle={att.topicTitle}
                                question={att.question}
                                options={att.options}
                                selectedIndex={att.selectedIndex}
                                correctIndex={att.correctIndex}
                                isCorrect={att.isCorrect}
                                explanation={att.explanation}
                                onPracticeClick={(snippet) =>
                                  onPracticeClick(snippet, {
                                    topicTitle: att.topicTitle,
                                    question: att.question,
                                  })
                                }
                                onOpenLesson={(lid) =>
                                  onOpenLesson(lid, {
                                    topicTitle: att.topicTitle,
                                    question: att.question,
                                  })
                                }
                                onOpenAiAssist={onOpenAiAssist}
                              />
                            </div>
                          ))
                        )}
                      </div>
                    </>
                  );
                })()}
              </div>
            )}
          </>
        )}

        {/* ============================================================
            TAB 2: CARD-BASED TOPICS MATRIX
           ============================================================ */}
        {activeTab === "mastery" && (
          <div className="space-y-5">
            {/* Overview Summary Grid Cards */}
            <div className="grid grid-cols-3 gap-2.5 sm:gap-4">
              <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] p-3.5 sm:p-5">
                <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                  Strong (75%+)
                </div>
                <div className="text-xl sm:text-2xl font-bold tabular-nums text-emerald-600 dark:text-[#65D9D0] mt-0.5">
                  {topicSummaryCounts.mastered}
                </div>
              </div>
              <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] p-3.5 sm:p-5">
                <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                  Needs Review
                </div>
                <div className="text-xl sm:text-2xl font-bold tabular-nums text-amber-600 dark:text-[#F2BC72] mt-0.5">
                  {topicSummaryCounts.weak}
                </div>
              </div>
              <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] p-3.5 sm:p-5">
                <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                  Not Quizzed
                </div>
                <div className="text-xl sm:text-2xl font-bold tabular-nums text-slate-900 dark:text-white mt-0.5">
                  {topicSummaryCounts.untried}
                </div>
              </div>
            </div>

            {/* Search & Filter Controls */}
            <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] p-4 sm:p-5 space-y-3.5">
              <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={topicSearch}
                    onChange={(e) => setTopicSearch(e.target.value)}
                    placeholder="Filter modules or lessons..."
                    className="w-full min-h-[44px] pl-10 pr-11 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#08090D] text-xs sm:text-sm text-slate-900 dark:text-white focus:outline-hidden focus:border-blue-500"
                  />
                  {topicSearch && (
                    <button
                      type="button"
                      onClick={() => setTopicSearch("")}
                      className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white absolute right-0.5 top-1/2 -translate-y-1/2 cursor-pointer"
                      aria-label="Clear topic filter"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  onClick={handleToggleAllTopicModules}
                  className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-[#252933] text-xs font-semibold text-blue-600 dark:text-[#8BBEFF] cursor-pointer whitespace-nowrap"
                >
                  {allTopicModulesExpanded ? "Collapse all modules" : "Expand all modules"}
                </button>
              </div>

              <div className="grid grid-cols-2 sm:flex items-center gap-1 p-1 bg-slate-100 dark:bg-[#08090D] border border-slate-200 dark:border-slate-800 rounded-xl">
                {(
                  [
                    { id: "all", label: "All Topics" },
                    { id: "weak", label: "Needs Review" },
                    { id: "untried", label: "Not Quizzed" },
                    { id: "completed", label: "Completed" },
                  ] as const
                ).map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setTopicFilter(f.id)}
                    className={`min-h-[44px] px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap cursor-pointer transition-colors ${
                      topicFilter === f.id
                        ? "bg-white dark:bg-[#252933] text-slate-900 dark:text-white shadow-xs"
                        : "text-slate-600 dark:text-[#BFC4CE] hover:text-slate-900 dark:hover:text-white"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </section>

            {filteredTopicModules.length === 0 ? (
              <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] p-10 text-center space-y-3">
                <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                  No matching topics found.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setTopicSearch("");
                    setTopicFilter("all");
                  }}
                  className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-semibold text-blue-600 dark:text-[#8BBEFF] hover:bg-slate-50 dark:hover:bg-[#252933] cursor-pointer"
                >
                  Clear filters
                </button>
              </div>
            ) : (
              filteredTopicModules.map((mod) => {
                const modLessons = mod.lessons;
                const modCompleted = modLessons.filter((l) =>
                  progress.completedLessonIds.includes(l.id)
                ).length;
                const modAttempts = modLessons.reduce(
                  (sum, l) => sum + (masteryMap[l.id]?.attempts || 0),
                  0
                );
                const modCorrect = modLessons.reduce(
                  (sum, l) => sum + (masteryMap[l.id]?.correct || 0),
                  0
                );
                const modAcc =
                  modAttempts > 0 ? Math.round((modCorrect / modAttempts) * 100) : null;
                const isExpanded =
                  Boolean(expandedTopicModules[mod.id]) ||
                  topicSearch.trim().length > 0 ||
                  topicFilter !== "all";

                return (
                  <section
                    key={mod.id}
                    className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] overflow-hidden"
                  >
                    <div className="px-4 sm:px-5 py-3.5 sm:py-4 flex flex-wrap items-center justify-between gap-3">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedTopicModules((prev) => ({
                            ...prev,
                            [mod.id]: !isExpanded,
                          }))
                        }
                        className="flex-1 min-w-0 min-h-[44px] flex items-center gap-3 text-left cursor-pointer"
                      >
                        <ChevronDown
                          className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${
                            isExpanded ? "rotate-0" : "-rotate-90"
                          }`}
                        />
                        <div className="min-w-0 space-y-0.5">
                          <h3 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white truncate">
                            {mod.title}
                          </h3>
                          <div className="text-xs text-slate-500 dark:text-[#BFC4CE] flex flex-wrap items-center gap-x-2 gap-y-0.5 tabular-nums">
                            <span>
                              {modCompleted}/{modLessons.length} done
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>
                              {modAcc !== null
                                ? `${modAcc}% quiz accuracy (${modAttempts} Qs)`
                                : "Not quizzed yet"}
                            </span>
                          </div>
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          startQuiz({
                            scope: "module",
                            moduleId: mod.id,
                            count: Math.min(8, Math.max(5, mod.lessons.length * 2)),
                          })
                        }
                        className="min-h-[44px] flex items-center gap-1.5 px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-[#252933] text-xs font-semibold text-slate-800 dark:text-white transition-colors cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <Play className="w-3.5 h-3.5 text-blue-600 dark:text-[#8BBEFF]" />
                        <span>Quiz Module</span>
                      </button>
                    </div>

                    {isExpanded && (
                      <div className="p-4 sm:p-5 border-t border-slate-200 dark:border-slate-800 grid grid-cols-1 md:grid-cols-2 gap-3 bg-slate-50/40 dark:bg-[#08090D]/30">
                        {modLessons.map((lesson) => {
                          const isDone = progress.completedLessonIds.includes(lesson.id);
                          const rec = masteryMap[lesson.id];
                          const acc =
                            rec && rec.attempts > 0
                              ? Math.round((rec.correct / rec.attempts) * 100)
                              : null;

                          return (
                            <div
                              key={lesson.id}
                              className="p-3.5 sm:p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] flex flex-col justify-between gap-3"
                            >
                              <div className="flex items-start gap-3 min-w-0">
                                {isDone ? (
                                  <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                                ) : (
                                  <div className="w-4 h-4 rounded-full border border-slate-300 dark:border-slate-700 shrink-0 mt-0.5" />
                                )}
                                <div className="min-w-0 flex-1 space-y-1">
                                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 leading-snug">
                                    {lesson.title}
                                  </div>
                                  <div className="text-xs text-slate-500 dark:text-[#BFC4CE] tabular-nums">
                                    {isDone ? "Completed" : "Not completed"}
                                    {rec && rec.attempts > 0
                                      ? ` · ${rec.correct}/${rec.attempts} right (${acc}%)`
                                      : " · No quiz attempts"}
                                  </div>
                                  {acc !== null && (
                                    <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-[#08090D] overflow-hidden pt-0">
                                      <div
                                        className={`h-full rounded-full ${
                                          acc >= 75
                                            ? "bg-emerald-500 dark:bg-[#65D9D0]"
                                            : "bg-amber-500 dark:bg-[#F2BC72]"
                                        }`}
                                        style={{ width: `${acc}%` }}
                                      />
                                    </div>
                                  )}
                                </div>
                              </div>

                              <div className="grid grid-cols-2 gap-2">
                                <button
                                  type="button"
                                  onClick={() => onOpenLesson(lesson.id)}
                                  className="min-h-[44px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-[#252933] text-xs font-semibold text-slate-700 dark:text-[#BFC4CE] cursor-pointer text-center whitespace-nowrap"
                                >
                                  Open Lesson
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    startQuiz({
                                      scope: "current-lesson",
                                      lessonId: lesson.id,
                                      count: 5,
                                    })
                                  }
                                  className="min-h-[44px] px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 dark:bg-[#8BBEFF] dark:hover:bg-[#73aef8] text-white dark:text-[#08090D] text-xs font-bold cursor-pointer text-center whitespace-nowrap"
                                >
                                  Quiz Topic
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              })
            )}
          </div>
        )}

        {/* ============================================================
            TAB 3: CARD-BASED QUIZ SESSION HISTORY
           ============================================================ */}
        {activeTab === "history" && (
          <div className="space-y-5">
            {/* History Header Card + Stats Grid */}
            <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] p-4 sm:p-6 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                    Past Quizzes
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                    Saved locally in your browser so you can review anytime offline.
                  </p>
                </div>

                {history.length > 0 && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleResetAllStats}
                      className={`min-h-[44px] flex items-center gap-1.5 px-3.5 py-2 rounded-xl border text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                        confirmResetStats
                          ? "border-rose-500 bg-rose-600 text-white"
                          : "border-slate-200 dark:border-slate-700 text-slate-600 dark:text-[#BFC4CE] hover:text-rose-600 dark:hover:text-rose-400"
                      }`}
                    >
                      <Trash2 className="w-4 h-4" />
                      <span>{confirmResetStats ? "Confirm Reset?" : "Reset Stats"}</span>
                    </button>
                    {confirmResetStats && (
                      <button
                        type="button"
                        onClick={() => setConfirmResetStats(false)}
                        className="min-h-[44px] px-3 py-2 rounded-xl text-xs font-semibold text-slate-500 hover:text-slate-800 dark:hover:text-white cursor-pointer"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                )}
              </div>

              {history.length > 0 && (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#08090D]/60">
                      <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                        Sessions
                      </div>
                      <div className="text-lg sm:text-xl font-bold tabular-nums text-slate-900 dark:text-white mt-0.5">
                        {history.length}
                      </div>
                    </div>
                    <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#08090D]/60">
                      <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                        Average Score
                      </div>
                      <div className="text-lg sm:text-xl font-bold tabular-nums text-emerald-600 dark:text-[#65D9D0] mt-0.5">
                        {overallStats.overallAccuracy}%
                      </div>
                    </div>
                    <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#08090D]/60">
                      <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                        Best Streak
                      </div>
                      <div className="text-lg sm:text-xl font-bold tabular-nums text-amber-600 dark:text-[#F2BC72] mt-0.5">
                        {overallStats.bestSessionStreak}
                      </div>
                    </div>
                    <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#08090D]/60">
                      <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                        Quiz XP
                      </div>
                      <div className="text-lg sm:text-xl font-bold tabular-nums text-blue-600 dark:text-[#8BBEFF] mt-0.5">
                        +{totalHistoryXp}
                      </div>
                    </div>
                  </div>

                  {/* Mode Filter Bar */}
                  <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-[#08090D] border border-slate-200 dark:border-slate-800 rounded-xl overflow-x-auto no-scrollbar">
                    {(
                      [
                        { id: "all", label: "All Modes" },
                        { id: "adaptive", label: "Recommended" },
                        { id: "current-lesson", label: "Lesson" },
                        { id: "module", label: "Module" },
                        { id: "weak-spots", label: "Mistakes" },
                        { id: "timed-blitz", label: "Sprint" },
                      ] as const
                    ).map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setHistoryFilter(f.id)}
                        className={`min-h-[44px] px-3.5 py-2 rounded-lg text-xs font-semibold whitespace-nowrap cursor-pointer transition-colors ${
                          historyFilter === f.id
                            ? "bg-white dark:bg-[#252933] text-slate-900 dark:text-white shadow-xs"
                            : "text-slate-600 dark:text-[#BFC4CE] hover:text-slate-900 dark:hover:text-white"
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </>
              )}

              {history.length === 0 ? (
                <div className="py-10 text-center space-y-3">
                  <p className="text-sm text-slate-600 dark:text-[#BFC4CE]">
                    You haven't completed a quiz session yet.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveTab("quiz");
                      openSetupWizard();
                    }}
                    className="min-h-[44px] px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 dark:bg-[#8BBEFF] dark:hover:bg-[#73aef8] text-white dark:text-[#08090D] text-xs font-bold cursor-pointer"
                  >
                    Take Your First Quiz
                  </button>
                </div>
              ) : filteredHistory.length === 0 ? (
                <div className="py-10 text-center text-sm text-slate-500 dark:text-[#BFC4CE]">
                  No quiz sessions match this filter.
                </div>
              ) : null}
            </section>

            {/* Individual Session Cards */}
            {filteredHistory.length > 0 && (
              <div className="space-y-3">
                {filteredHistory.map((session) => {
                  const isExpanded = expandedHistoryId === session.id;
                  const hasQuestions =
                    Array.isArray(session.questionResults) &&
                    session.questionResults.length > 0;
                  const visibleQuestions = hasQuestions
                    ? session.questionResults.filter((att) =>
                        historyQuestionFilter === "missed" ? !att.isCorrect : true
                      )
                    : [];

                  return (
                    <div
                      key={session.id}
                      className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] overflow-hidden"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (!hasQuestions) return;
                          setHistoryQuestionFilter("all");
                          setExpandedHistoryId(isExpanded ? null : session.id);
                        }}
                        className={`w-full min-h-[64px] p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-left transition-colors ${
                          hasQuestions
                            ? "hover:bg-slate-50/80 dark:hover:bg-[#1a1d26] cursor-pointer"
                            : "cursor-default"
                        }`}
                      >
                        <div className="space-y-1 min-w-0">
                          <div className="text-sm font-bold text-slate-900 dark:text-white flex flex-wrap items-center gap-2">
                            <span className="truncate">{session.scopeLabel}</span>
                            {hasQuestions && (
                              <span className="text-xs font-medium text-blue-600 dark:text-[#8BBEFF] shrink-0">
                                {isExpanded ? "Hide questions" : "Review questions"}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-[#BFC4CE] flex flex-wrap items-center gap-2 tabular-nums">
                            <span>{new Date(session.timestamp).toLocaleDateString()}</span>
                            <span aria-hidden="true">·</span>
                            <span>{formatDuration(session.durationSeconds)}</span>
                            <span aria-hidden="true">·</span>
                            <span>Best streak {session.bestStreak}</span>
                          </div>
                        </div>

                        <div className="flex items-center justify-between sm:justify-end gap-3 tabular-nums shrink-0">
                          <div className="sm:text-right">
                            <div
                              className={`text-base font-bold ${
                                session.scorePercent >= 75
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : "text-amber-600 dark:text-[#F2BC72]"
                              }`}
                            >
                              {session.correctCount}/{session.totalQuestions} ({session.scorePercent}%)
                            </div>
                            <div className="text-xs text-slate-500 dark:text-[#BFC4CE]">
                              +{session.xpEarned} XP
                            </div>
                          </div>
                          {hasQuestions && (
                            <ChevronDown
                              className={`w-4 h-4 text-slate-400 transition-transform ${
                                isExpanded ? "rotate-180" : ""
                              }`}
                            />
                          )}
                        </div>
                      </button>

                      {isExpanded && hasQuestions && (
                        <div className="p-4 sm:p-5 border-t border-slate-200 dark:border-slate-800 space-y-3 bg-slate-50/40 dark:bg-[#08090D]/30">
                          {session.questionResults.some((q) => !q.isCorrect) && (
                            <div className="flex items-center gap-1 p-1 bg-white dark:bg-[#15171E] border border-slate-200 dark:border-slate-800 rounded-xl w-fit">
                              <button
                                type="button"
                                onClick={() => setHistoryQuestionFilter("all")}
                                className={`min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${
                                  historyQuestionFilter === "all"
                                    ? "bg-slate-100 dark:bg-[#252933] text-slate-900 dark:text-white"
                                    : "text-slate-600 dark:text-[#BFC4CE]"
                                }`}
                              >
                                All ({session.questionResults.length})
                              </button>
                              <button
                                type="button"
                                onClick={() => setHistoryQuestionFilter("missed")}
                                className={`min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${
                                  historyQuestionFilter === "missed"
                                    ? "bg-slate-100 dark:bg-[#252933] text-slate-900 dark:text-white"
                                    : "text-slate-600 dark:text-[#BFC4CE]"
                                }`}
                              >
                                Missed (
                                {session.questionResults.filter((q) => !q.isCorrect).length}
                                )
                              </button>
                            </div>
                          )}

                          {visibleQuestions.map((att, qIdx) => (
                            <div
                              key={`${session.id}-${att.questionId}-${qIdx}`}
                              className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#15171E] p-4 space-y-2.5"
                            >
                              <div className="flex items-center justify-between gap-2 text-xs">
                                <span className="font-semibold text-slate-700 dark:text-slate-200">
                                  {att.topicTitle}
                                </span>
                                <span
                                  className={`font-bold flex items-center gap-1 ${
                                    att.isCorrect
                                      ? "text-emerald-600 dark:text-emerald-400"
                                      : "text-rose-600 dark:text-rose-400"
                                  }`}
                                >
                                  {att.isCorrect ? (
                                    <>
                                      <CheckCircle2 className="w-3.5 h-3.5" />
                                      <span>Correct</span>
                                    </>
                                  ) : (
                                    <>
                                      <XCircle className="w-3.5 h-3.5" />
                                      <span>Missed</span>
                                    </>
                                  )}
                                </span>
                              </div>

                              <p className="text-xs sm:text-sm font-semibold text-slate-900 dark:text-white">
                                {att.question}
                              </p>

                              {att.codeSnippet && renderCodeBlock(att.codeSnippet)}

                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                                <div
                                  className={`p-3 rounded-xl border ${
                                    att.isCorrect
                                      ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/25 text-emerald-900 dark:text-emerald-200"
                                      : "border-rose-300 dark:border-rose-800 bg-rose-50/60 dark:bg-rose-950/25 text-rose-900 dark:text-rose-200"
                                  }`}
                                >
                                  <span className="font-semibold">Your answer: </span>
                                  <span>{att.options[att.selectedIndex]}</span>
                                </div>
                                {!att.isCorrect && (
                                  <div className="p-3 rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/25 text-emerald-900 dark:text-emerald-200">
                                    <span className="font-semibold">Correct answer: </span>
                                    <span>{att.options[att.correctIndex]}</span>
                                  </div>
                                )}
                              </div>

                              <p className="text-xs sm:text-sm text-slate-600 dark:text-[#BFC4CE] leading-relaxed">
                                {att.explanation}
                              </p>

                              <QuizFeedbackActionsBar
                                codeSnippet={att.codeSnippet}
                                lessonId={att.lessonId}
                                hasLesson={allLessons.some(
                                  (l) => l.lesson.id === att.lessonId
                                )}
                                topicTitle={att.topicTitle}
                                question={att.question}
                                options={att.options}
                                selectedIndex={att.selectedIndex}
                                correctIndex={att.correctIndex}
                                isCorrect={att.isCorrect}
                                explanation={att.explanation}
                                onPracticeClick={(snippet) =>
                                  onPracticeClick(snippet, {
                                    topicTitle: att.topicTitle,
                                    question: att.question,
                                  })
                                }
                                onOpenLesson={(lid) =>
                                  onOpenLesson(lid, {
                                    topicTitle: att.topicTitle,
                                    question: att.question,
                                  })
                                }
                                onOpenAiAssist={onOpenAiAssist}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
