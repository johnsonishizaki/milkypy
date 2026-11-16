/**
 * Compact, runtime-agnostic MilkyPy Curriculum Outline & Shared AI Helpers.
 * Zero Node.js dependencies so it runs cleanly in Express, Cloudflare Workers, and Browser.
 */

export const MILKY_CURRICULUM_OUTLINE = `MilkyPy Python Curriculum (7 Modules, 24 Lessons):

Module 1: 1. Python Basics & Syntax
  - 1.1 Python Introduction (beginner): What Python is, why people use it, and top-to-bottom code execution with print().
  - 1.2 The print() Function (beginner): Printing multiple values, numbers vs strings, sep= and end= parameters.
  - 1.3 Numbers & Basic Math (beginner): int and float types, arithmetic (+, -, *, /, //, %, **), and order of operations.
  - 1.4 Python Comments (beginner): Writing # comments for documentation and temporarily disabling lines while testing.

Module 2: 2. Variables & Core Data Types
  - 2.1 Python Variables (beginner): Assigning values with =, storing text/numbers, and updating variable values.
  - 2.2 Variable Naming Rules (beginner): Allowed characters, no leading digits, and snake_case conventions.
  - 2.3 Python Data Types (beginner): Core types str, int, float, bool (True/False), and inspecting types with type().
  - 2.4 Type Casting (Conversion) (beginner): Converting values with int(), float(), and str(), especially for input/math.

Module 3: 3. Operators & Booleans
  - 3.1 Comparison Operators (beginner): ==, !=, >, <, >=, <= returning True or False.
  - 3.2 Logical Operators (and, or, not) (beginner): Combining boolean rules with and, or, and inverting with not.
  - 3.3 F-Strings (Formatted Strings) (beginner): Embedding variables and expressions cleanly inside f"...{var}...".

Module 4: 4. Conditions & Decisions (If...Else)
  - 4.1 The if Statement & Indentation (beginner): Conditional branching with colons (:) and 4-space indentation blocks.
  - 4.2 The else and elif Statements (beginner): Handling fallback branches with else and multi-way choices with elif.

Module 5: 5. Loops (Repeating Things)
  - 5.1 The while Loop (intermediate): Condition-controlled repetition, updating counters, and avoiding infinite loops.
  - 5.2 The for Loop & range() (intermediate): Iterating fixed counts with range(stop) and range(start, stop).
  - 5.3 break and continue (intermediate): Exiting loops early with break and skipping to the next iteration with continue.

Module 6: 6. Collections (Lists & Dictionaries)
  - 6.1 Python Lists & Indexing (intermediate): Creating [ ] lists, 0-based indexing, and negative indexing ([-1]).
  - 6.2 List Methods (append, len, remove) (intermediate): Measuring length with len(), adding with .append(), removing with .remove().
  - 6.3 Looping Through Lists (intermediate): Iterating items with for item in my_list, filtering, and aggregating.
  - 6.4 Python Dictionaries (intermediate): Key-value mappings with { }, accessing/updating keys, and contact-book patterns.

Module 7: 7. Functions & Reusable Blocks
  - 7.1 Creating & Calling Functions (intermediate): Defining reusable functions with def and invoking them with ().
  - 7.2 Function Parameters & Arguments (intermediate): Passing inputs into functions for flexible behavior.
  - 7.3 The return Statement (intermediate): Returning computed results with return vs printing with print(), saving returned values.
  - 7.4 Variable Scope & Functions Recap (intermediate): Local vs global scope and default parameter values (e.g. def greet(name='Friend'):).`;

export const MILKY_CURRICULUM_COMPACT = `MilkyPy Modules: 1. Basics & Syntax (print, math, # comments), 2. Variables & Types (int/float/str/bool, casting), 3. Operators & F-Strings (comparisons, and/or/not, f"..."), 4. Conditions (if/elif/else), 5. Loops (while, for, range, break/continue), 6. Collections (lists, methods, dicts), 7. Functions (def, params, return, scope).`;

export interface MilkyChatQuizContext {
  question: string;
  userChoice?: string;
  correctAnswer: string;
  explanation?: string;
  isCorrect?: boolean;
}

export interface MilkyChatInstructionOptions {
  code?: string;
  lessonContext?: {
    title?: string;
    description?: string;
    expectedOutput?: string;
    learningObjectives?: string[];
    quizQuestion?: MilkyChatQuizContext;
  };
  customSystem?: string;
  latestUserMessage?: string;
}

function clampText(text: string | undefined, maxChars: number): string {
  const clean = (text || "").trim();
  if (!clean || clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars)}\n... (truncated)`;
}

export function buildMilkyChatSystemInstruction(
  options: MilkyChatInstructionOptions
): string {
  if (options.customSystem && options.customSystem.trim()) {
    return `${clampText(options.customSystem, 1000)}\n\nRules: Be concise. Never use emojis. Return complete code blocks.`;
  }

  const query = (options.latestUserMessage || "").toLowerCase();
  const wantsSyllabus =
    !query ||
    /\b(curriculum|syllabus|module|modules|lesson|lessons|roadmap|course|next|topic|topics|study|learn next|start)\b/.test(
      query
    );

  const trimmedCode = clampText(options.code, 2200);
  const qCtx = options.lessonContext?.quizQuestion;
  const quizBlock = qCtx
    ? `\nQUIZ CONTEXT:
- Q: ${clampText(qCtx.question, 300)}${
        qCtx.userChoice !== undefined
          ? `\n- Picked: ${clampText(qCtx.userChoice, 120)} (${qCtx.isCorrect ? "Correct" : "Wrong"})`
          : ""
      }
- Answer: ${clampText(qCtx.correctAnswer, 120)}${
        qCtx.explanation ? `\n- Note: ${clampText(qCtx.explanation, 280)}` : ""
      }`
    : "";

  const lessonBlock = options.lessonContext?.title
    ? `\nLESSON: ${clampText(options.lessonContext.title, 120)}${
        options.lessonContext.description
          ? ` — ${clampText(options.lessonContext.description, 260)}`
          : ""
      }${
        options.lessonContext.expectedOutput
          ? `\nTarget output: ${clampText(options.lessonContext.expectedOutput, 180)}`
          : ""
      }${
        options.lessonContext.learningObjectives?.length
          ? `\nObjectives: ${options.lessonContext.learningObjectives.slice(0, 4).join("; ")}`
          : ""
      }`
    : "";

  const curriculumBlock = wantsSyllabus
    ? `\n${MILKY_CURRICULUM_OUTLINE}`
    : `\n${MILKY_CURRICULUM_COMPACT}`;

  const codeBlock = trimmedCode
    ? `\nUSER CODE (only reference if relevant):\n\`\`\`python\n${trimmedCode}\n\`\`\``
    : "";

  return `You are Milky, a concise Python tutor and general assistant.
Rules:
1. Answer what the user asked directly and briefly (skip filler). If non-Python, answer normally without forcing code.
2. For Python/lesson questions, give clear steps and clean runnable code. Reference MilkyPy lessons when helpful.
3. Never use emojis. Never cut off code blocks mid-way.${curriculumBlock}${lessonBlock}${quizBlock}${codeBlock}`;
}

/**
 * Strips decorative emojis from prose outside fenced code blocks while keeping Markdown indentation intact.
 */
export function stripDecorativeEmojis(text: string): string {
  if (!text) return text;
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, idx) => {
      if (idx % 2 === 1) return part; // Keep fenced code blocks untouched
      return part
        .replace(/ *[\p{Extended_Pictographic}\uFE0F\u200D]+ */gu, (match) =>
          match.startsWith(" ") && match.endsWith(" ") ? " " : ""
        )
        .replace(/ +\n/g, "\n");
    })
    .join("")
    .trim();
}
