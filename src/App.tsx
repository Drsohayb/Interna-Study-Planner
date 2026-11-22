import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  CalendarDays,
  CalendarX,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Brain,
  Download,
  Eye,
  Folder,
  GripVertical,
  House,
  Plus,
  RotateCcw,
  PencilLine,
  Play,
  Search,
  Stethoscope,
  StickyNote,
  Trash2,
  Upload,
} from "lucide-react";
import seed from "./courses.json";
import JSZip from "jszip";
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar as RadarSeries,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

type Course = {
  id: string;
  title: string;
  sourceSection: string;
  system: string;
  addedAt: string;
  checks: Record<string, boolean>;
  // Manual drag & drop moves (calendar edit mode).
  dateOverrides?: Record<string, string>;
  // Moves created by the sick-day spreading (kept separate so "Effacer les
  // déplacements" only removes manual edits, not sick-day reports).
  sickOverrides?: Record<string, string>;
  difficulty?: "easy" | "medium" | "hard";
  note?: string;
  custom?: boolean;
};

type Difficulty = "easy" | "medium" | "hard";

const stages = [
  { k: "J0", d: 0 },
  { k: "J1", d: 1 },
  { k: "J3", d: 3 },
  { k: "J7", d: 7 },
  { k: "J15", d: 15 },
  { k: "J30", d: 30 },
] as const;

const difficultyMeta: Record<
  Difficulty,
  { label: string; color: string; bg: string; text: string }
> = {
  easy: { label: "Facile", color: "#16a34a", bg: "#dcfce7", text: "#166534" },
  medium: { label: "Moyen", color: "#d97706", bg: "#fef3c7", text: "#92400e" },
  hard: { label: "Difficile", color: "#dc2626", bg: "#fee2e2", text: "#991b1b" },
};

// The 6 exam modules, matched from the course source section.
const modules = [
  {
    key: "anatomie",
    label: "Anatomie",
    short: "Anatomie",
    color: "#15803d",
    match: (section: string) => section.startsWith("Anatomie"),
  },
  {
    key: "biologie",
    label: "Biologie",
    short: "Biologie",
    color: "#0f766e",
    match: (section: string) => section.startsWith("Biologie"),
  },
  {
    key: "patho-med",
    label: "Pathologie médicale",
    short: "Patho méd.",
    color: "#1d4ed8",
    match: (section: string) => section.startsWith("Médecine — Admissibilité"),
  },
  {
    key: "patho-chir",
    label: "Pathologie chirurgicale",
    short: "Patho chir.",
    color: "#7c3aed",
    match: (section: string) => section.startsWith("Chirurgie — Admissibilité"),
  },
  {
    key: "urg-med",
    label: "Urgences médicales",
    short: "Urg. méd.",
    color: "#be123c",
    match: (section: string) => section.startsWith("Médecine — Admission"),
  },
  {
    key: "urg-chir",
    label: "Urgences chirurgicales",
    short: "Urg. chir.",
    color: "#c2410c",
    match: (section: string) => section.startsWith("Chirurgie — Admission"),
  },
] as const;

// Custom radar tick: module short name rendered in the module's unique color.
const radarTick = (props: {
  x?: string | number;
  y?: string | number;
  payload?: { value?: string };
}) => {
  const x = Number(props.x ?? 0);
  const y = Number(props.y ?? 0);
  const { payload } = props;
  const mod = modules.find((entry) => entry.short === payload?.value);
  return (
    <text
      x={x}
      y={y}
      textAnchor="middle"
      fill={mod?.color ?? "#18382c"}
      fontSize={12}
      fontWeight={700}
    >
      {payload?.value ?? ""}
    </text>
  );
};

// Custom radar vertex dot: filled with the module's unique color.
const radarDot = (props: {
  cx?: number;
  cy?: number;
  payload?: { module?: string; color?: string };
}) => {
  const { cx = 0, cy = 0, payload } = props;
  const mod = modules.find((entry) => entry.short === payload?.module);
  return (
    <circle
      cx={cx}
      cy={cy}
      r={5}
      fill={payload?.color ?? mod?.color ?? "#1e6248"}
      stroke="#ffffff"
      strokeWidth={2}
    />
  );
};

// ======================= MODE REVISION (active recall) =======================

type RevSection = {
  id: string;
  heading: string;
  level: number; // 1 = top-level title (I., Introduction...), 2, 3...
  content: string; // full text under the heading, shown only as the "answer"
  selected?: boolean; // included in the quiz (default true)
  grades?: ("easy" | "hard")[]; // all grades given, across sessions
  times?: number[]; // seconds taken to answer, aligned with grades
};

type RevCourse = {
  id: string;
  title: string;
  path: string; // folder path, used to rebuild the uploaded folder structure
  tag?: "easy" | "medium" | "hard"; // overall difficulty impression
  sections: RevSection[];
};

type RevTreeNode = {
  name: string;
  dirs: Map<string, RevTreeNode>;
  courses: RevCourse[];
};

const RECALL_MINUTES = 3; // hard sections re-pop after this delay
const MAX_TRIES = 3; // then the section stops re-popping and lands in "à retravailler"

// Detect a heading level from several signals, in priority order:
// 1. explicit numbering in the text (I., 1., a))
// 2. structural keywords (Plan, Introduction, Conclusion...)
// 3. whole-paragraph bold + short line: titles typed without numbering
//    (very common in course docs); list indentation gives the depth when the
//    paragraph is part of an auto-numbered list (the number is not in the text)
// 4. Word heading styles (HeadingN / TitreN)
const headingLevelOf = (
  text: string,
  style: string,
  opts: { bold?: boolean; listLevel?: number } = {},
): number => {
  const t = text.trim();
  if (!t || t.length > 90) return 0; // long lines are never headings
  if (/^[IVXLCDM]{1,8}\s*[.)]/i.test(t)) return 1;
  if (/^\d+\s*[.)]\s+\S/.test(t)) return 2;
  if (/^[a-z]\s*[).]\s+\S/i.test(t)) return 3;
  if (/^(plan|introduction|conclusion|généralités|rappels?)\b/i.test(t)) return 1;
  if (opts.bold) {
    if (opts.listLevel !== undefined) return Math.min(3, opts.listLevel + 2);
    const styleMatch = style.toLowerCase().match(/(?:heading|titre)\s*(\d)/);
    if (styleMatch) {
      return Math.min(6, Math.max(1, parseInt(styleMatch[1], 10)));
    }
    return 2; // short bold line without other signal: sub-title
  }
  const styleMatch = style.toLowerCase().match(/(?:heading|titre)\s*(\d)/);
  if (styleMatch) return Math.min(6, Math.max(1, parseInt(styleMatch[1], 10)));
  return 0;
};

const linesToSections = (
  lines: {
    text: string;
    style: string;
    bold?: boolean;
    listLevel?: number;
  }[],
): RevSection[] => {
  const sections: RevSection[] = [];
  for (const line of lines) {
    const level = headingLevelOf(line.text, line.style, {
      bold: line.bold,
      listLevel: line.listLevel,
    });
    if (level > 0) {
      sections.push({ id: "", heading: line.text.trim(), level, content: "" });
    } else if (sections.length > 0) {
      const last = sections[sections.length - 1];
      const text = line.text.trim();
      last.content = last.content ? `${last.content}\n${text}` : text;
    }
  }
  return sections.map((section, index) => ({ ...section, id: String(index) }));
};

// .docx = zip of XML: read paragraphs with their text runs, style, whole-line
// boldness and list indentation (auto-numbered lists don't put the number in
// the text, so indentation is the only depth signal for those).
const parseDocxFile = async (file: File): Promise<RevSection[]> => {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const entry = zip.file("word/document.xml");
  if (!entry) return [];
  const xml = await entry.async("text");
  const dom = new DOMParser().parseFromString(xml, "application/xml");

  const isRunBold = (run: Element): boolean => {
    const rPr = run.getElementsByTagName("w:rPr")[0];
    if (!rPr) return false;
    const b = rPr.getElementsByTagName("w:b")[0];
    if (b && b.getAttribute("w:val") !== "false") return true;
    const rStyle = rPr
      .getElementsByTagName("w:rStyle")[0]
      ?.getAttribute("w:val")
      ?.toLowerCase();
    return rStyle === "strong" || rStyle === "gras";
  };

  const lines = [...dom.getElementsByTagName("w:p")]
    .map((paragraph) => {
      const text = [...paragraph.getElementsByTagName("w:t")]
        .map((node) => node.textContent ?? "")
        .join("");
      const style =
        paragraph
          .getElementsByTagName("w:pStyle")[0]
          ?.getAttribute("w:val") ?? "";
      const ilvlAttr = paragraph
        .getElementsByTagName("w:numPr")[0]
        ?.getElementsByTagName("w:ilvl")[0]
        ?.getAttribute("w:val");
      const listLevel =
        ilvlAttr !== undefined && ilvlAttr !== null
          ? parseInt(ilvlAttr, 10)
          : undefined;
      const textRuns = [...paragraph.getElementsByTagName("w:r")].filter(
        (run) =>
          [...run.getElementsByTagName("w:t")].some((node) =>
            (node.textContent ?? "").trim(),
          ),
      );
      const wholeBold =
        text.trim().length > 0 &&
        textRuns.length > 0 &&
        textRuns.every(isRunBold);
      return { text, style, bold: wholeBold, listLevel };
    })
    .filter((line) => line.text.trim());
  return linesToSections(lines);
};

// .txt / .md: markdown # headings, or numbered headings (I., 1., a)).
const parseTextFile = (text: string): RevSection[] => {
  const none = { bold: false, listLevel: undefined as number | undefined };
  const lines = text.split(/\r?\n/).map((raw) => {
    const mdBold = raw.match(/^\s*\*\*(.+?)\*\*\s*:?\s*$/);
    if (mdBold) return { text: mdBold[1], style: "", ...none, bold: true };
    const match = raw.match(/^(#{1,6})\s+(.*)$/);
    return match
      ? { text: match[2], style: `heading${match[1].length}`, ...none }
      : { text: raw, style: "", ...none };
  });
  return linesToSections(lines);
};

const shuffle = <T,>(list: T[]): T[] => {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

// ---- Revision stats & rendering helpers ----
const sectionStats = (section: RevSection) => {
  const grades = section.grades ?? [];
  const times = section.times ?? [];
  const hard = grades.filter((g) => g === "hard").length;
  const avgTime = times.length
    ? times.reduce((sum, value) => sum + value, 0) / times.length
    : 0;
  return {
    attempts: grades.length,
    hardCount: hard,
    easyCount: grades.length - hard,
    avgTime,
    last: grades[grades.length - 1],
    lastTime: times[times.length - 1] ?? 0,
  };
};

const courseStats = (course: RevCourse) => {
  const stats = course.sections.map(sectionStats);
  const attempted = stats.filter((s) => s.attempts > 0);
  return {
    attempted: attempted.length,
    total: course.sections.length,
    easy: attempted.reduce((sum, s) => sum + (s.last === "easy" ? 1 : 0), 0),
    hard: attempted.reduce((sum, s) => sum + (s.last === "hard" ? 1 : 0), 0),
    avgTime: attempted.length
      ? attempted.reduce((sum, s) => sum + s.avgTime, 0) / attempted.length
      : 0,
  };
};

// Render **bold** markers found in plain-text content.
const renderInline = (text: string) =>
  text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={index}>{part.slice(2, -2)}</strong>
    ) : (
      part
    ),
  );

// Imitate the default Microsoft Word look for the preview mode.
const wordHeadingStyle = (level: number) => ({
  color: level <= 2 ? "#2F5496" : level === 3 ? "#1F4E79" : "#404040",
  fontSize: [20, 16, 14, 13, 12, 12][Math.min(6, Math.max(1, level)) - 1],
  fontWeight: 600,
  marginTop: 14,
  marginBottom: 4,
  fontFamily: "'Calibri Light', Calibri, 'Segoe UI', sans-serif",
});

const wordBodyStyle = {
  fontSize: 14,
  color: "#000000",
  whiteSpace: "pre-wrap",
  margin: "2px 0 8px",
  fontFamily: "Calibri, 'Segoe UI', sans-serif",
} as const;

const buildRevTree = (courses: RevCourse[]): RevTreeNode => {
  const root: RevTreeNode = { name: "", dirs: new Map(), courses: [] };
  courses.forEach((course) => {
    let node = root;
    course.path
      .split("/")
      .filter(Boolean)
      .forEach((part) => {
        const existing = node.dirs.get(part);
        if (existing) {
          node = existing;
        } else {
          const created: RevTreeNode = {
            name: part,
            dirs: new Map(),
            courses: [],
          };
          node.dirs.set(part, created);
          node = created;
        }
      });
    node.courses.push(course);
  });
  return root;
};

// Recursive folder tree, preserving the uploaded folder structure.
function CourseTree({
  node,
  onStart,
  onPreview,
  onEdit,
  onDelete,
}: {
  node: RevTreeNode;
  onStart: (id: string) => void;
  onPreview: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="mt-1 space-y-0.5">
      {[...node.dirs.values()].map((dir) => (
        <details key={dir.name} open className="py-0.5">
          <summary className="flex cursor-pointer items-center gap-1.5 text-sm font-semibold text-[#18382c]">
            <Folder size={14} className="shrink-0 text-amber-600" />
            {dir.name}
          </summary>
          <div className="ml-3 border-l border-[#edf0ed] pl-2">
            <CourseTree
              node={dir}
              onStart={onStart}
              onPreview={onPreview}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          </div>
        </details>
      ))}
      {node.courses.map((course) => {
        const stats = courseStats(course);
        return (
          <div key={course.id} className="py-1">
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5 text-sm">
                {course.tag && (
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: difficultyMeta[course.tag].color }}
                    title={difficultyMeta[course.tag].label}
                  />
                )}
                <span className="truncate">{course.title}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => onStart(course.id)}
                  title="Réviser"
                  aria-label={`Réviser ${course.title}`}
                  className="rounded-lg bg-[#e8f2eb] p-1.5 text-[#205e45]"
                >
                  <Play size={13} />
                </button>
                <button
                  onClick={() => onPreview(course.id)}
                  title="Aperçu (style Word)"
                  aria-label={`Aperçu ${course.title}`}
                  className="rounded-lg bg-[#eef2fb] p-1.5 text-[#1d4ed8]"
                >
                  <Eye size={13} />
                </button>
                <button
                  onClick={() => onEdit(course.id)}
                  title="Modifier les questions"
                  aria-label={`Modifier ${course.title}`}
                  className="rounded-lg bg-[#fef3c7] p-1.5 text-[#92400e]"
                >
                  <PencilLine size={13} />
                </button>
                <button
                  onClick={() => onDelete(course.id)}
                  aria-label={`Supprimer ${course.title}`}
                  title="Supprimer"
                  className="p-1.5 text-red-400"
                >
                  <Trash2 size={13} />
                </button>
              </span>
            </div>
            <div className="ml-4 text-[11px] muted">
              {course.sections.length} sections
              {stats.attempted > 0 &&
                ` · ${stats.attempted} vues · ${stats.easy} faciles / ${stats.hard} difficiles · moy ${Math.round(stats.avgTime)}s`}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const todayISO = () => {
  const date = new Date();
  const localDate = new Date(
    date.getTime() - date.getTimezoneOffset() * 60_000,
  );
  return localDate.toISOString().slice(0, 10);
};

const plus = (iso: string, days: number) => {
  const date = new Date(`${iso}T12:00:00`);
  date.setDate(date.getDate() + days);
  const localDate = new Date(
    date.getTime() - date.getTimezoneOffset() * 60_000,
  );
  return localDate.toISOString().slice(0, 10);
};

const fmt = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
  });

const fmtLong = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

const monthKey = (date: Date) => {
  const localDate = new Date(
    date.getTime() - date.getTimezoneOffset() * 60_000,
  );
  return localDate.toISOString().slice(0, 7);
};

const shiftMonth = (month: string, amount: number) => {
  const date = new Date(`${month}-01T12:00:00`);
  date.setMonth(date.getMonth() + amount);
  return monthKey(date);
};

const initial: Course[] = (seed as Course[]).map((course) => ({
  ...course,
  addedAt: "",
  checks: {},
}));

// Effective date of a stage: manual override (sick-day spreading) or the
// default schedule computed from the course start date.
// Effective date of a stage: manual overrides (drag & drop) keep their exact
// day — you may deliberately work on a day off. Only the default schedule
// (J0 + offset) is shifted to the next non-off day.
const stageDate = (
  course: Course,
  stage: (typeof stages)[number],
  isDayOff: (iso: string) => boolean = () => false,
) => {
  const override =
    course.dateOverrides?.[stage.k] ?? course.sickOverrides?.[stage.k];
  if (override) return override;
  let date = plus(course.addedAt, stage.d);
  while (isDayOff(date)) date = plus(date, 1);
  return date;
};

const scheduledForDate = (
  courses: Course[],
  date: string,
  isDayOff: (iso: string) => boolean = () => false,
) =>
  courses.flatMap((course) =>
    course.addedAt
      ? stages
        .filter((stage) => stageDate(course, stage, isDayOff) === date)
        .map((stage) => ({ course, stage }))
      : [],
  );

type SortMode = "module" | "system" | "progress" | "due" | "difficulty";

// One manual drag & drop step: which stage of which course was moved, and the
// manual override it replaced (undefined = there was none).
type MoveRecord = {
  courseId: string;
  stageKey: string;
  previous: string | undefined;
};

const moduleOf = (course: Course) =>
  modules.find((mod) => mod.match(course.sourceSection));

const progressCount = (course: Course) =>
  stages.filter((stage) => course.checks[stage.k]).length;

// Earliest unchecked stage date; unstarted courses sort last.
const nextDueDate = (
  course: Course,
  isDayOff: (iso: string) => boolean = () => false,
): string => {
  if (!course.addedAt) return "9999-12-31";
  const pending = stages
    .filter((stage) => !course.checks[stage.k])
    .map((stage) => stageDate(course, stage, isDayOff));
  return pending.length ? pending.sort()[0] : "9999-12-31";
};

const difficultyRank = (course: Course) =>
  course.difficulty === "hard"
    ? 0
    : course.difficulty === "medium"
      ? 1
      : course.difficulty === "easy"
        ? 2
        : 3;

const normalizeCourse = (entry: Partial<Course>): Course => ({
  ...entry,
  addedAt: typeof entry.addedAt === "string" ? entry.addedAt : "",
  checks:
    entry.checks && typeof entry.checks === "object" ? entry.checks : {},
  dateOverrides:
    entry.dateOverrides && typeof entry.dateOverrides === "object"
      ? entry.dateOverrides
      : {},
  sickOverrides:
    entry.sickOverrides && typeof entry.sickOverrides === "object"
      ? entry.sickOverrides
      : {},
  difficulty:
    entry.difficulty === "easy" ||
    entry.difficulty === "medium" ||
    entry.difficulty === "hard"
      ? entry.difficulty
      : undefined,
  note: typeof entry.note === "string" ? entry.note : undefined,
} as Course);


export default function App() {
  const [items, setItems] = useState<Course[]>(() => {
    try {
      const saved = localStorage.getItem("interna-courses");
      if (!saved) return initial;
      const parsed: unknown = JSON.parse(saved);
      if (!Array.isArray(parsed)) return initial;
      return parsed.map((entry) => normalizeCourse(entry as Partial<Course>));
    } catch {
      return initial;
    }
  });

  const [tab, setTab] = useState("today");
  const [query, setQuery] = useState("");
  const [system, setSystem] = useState("Tous les systèmes");
  const [section, setSection] = useState("Tous les parcours");
  const [sortMode, setSortMode] = useState<SortMode>("module");
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newSystem, setNewSystem] = useState("Anatomie générale / Régions");
  const [newSection, setNewSection] = useState("Anatomie — Admissibilité");
  const [notice, setNotice] = useState("");
  const [startDateDrafts, setStartDateDrafts] = useState<
    Record<string, string>
  >({});
  const [calendarCourseId, setCalendarCourseId] = useState("");
  const [selectedDate, setSelectedDate] = useState(todayISO);
  const [editMode, setEditMode] = useState(false);
  const [dragItem, setDragItem] = useState<{
    courseId: string;
    stageKey: string;
  } | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);
  // Undo stack for manual moves: each drop pushes one batch.
  const [moveHistory, setMoveHistory] = useState<MoveRecord[][]>(() => {
    try {
      const saved = localStorage.getItem("interna-move-history");
      const parsed: unknown = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed) ? (parsed as MoveRecord[][]) : [];
    } catch {
      return [];
    }
  });
  const [visibleMonth, setVisibleMonth] = useState(() =>
    todayISO().slice(0, 7),
  );

  // Days off: skipped by the automatic "sick day" spreading — the planner
  // never moves anything onto them. Manual drag & drop (dateOverrides) is
  // still allowed, so you can deliberately place work on a day off.
  const [dayOffs, setDayOffs] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem("interna-dayoffs");
      const parsed: unknown = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  });
  const dayOffSet = useMemo(() => new Set(dayOffs), [dayOffs]);
  const isDayOff = (iso: string) => dayOffSet.has(iso);
  const toggleDayOff = (iso: string) => {
    setDayOffs((current) =>
      current.includes(iso)
        ? current.filter((entry) => entry !== iso)
        : [...current, iso],
    );
  };

  useEffect(() => {
    localStorage.setItem("interna-courses", JSON.stringify(items));
  }, [items]);

  useEffect(() => {
    try {
      localStorage.setItem("interna-move-history", JSON.stringify(moveHistory));
    } catch {
      return;
    }
  }, [moveHistory]);

  useEffect(() => {
    try {
      localStorage.setItem("interna-dayoffs", JSON.stringify(dayOffs));
    } catch {
      return;
    }
  }, [dayOffs]);

  // ---- Revision mode (active recall) state ----
  const [revCourses, setRevCourses] = useState<RevCourse[]>(() => {
    try {
      const saved = localStorage.getItem("interna-revision-courses");
      const parsed: unknown = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed) ? (parsed as RevCourse[]) : [];
    } catch {
      return [];
    }
  });
  const [selectedRevCourseId, setSelectedRevCourseId] = useState<string | null>(
    null,
  );
  const [revSeconds, setRevSeconds] = useState(30);
  const [revView, setRevView] = useState<"setup" | "preview" | "edit">("setup");
  const [quiz, setQuiz] = useState<{
    courseId: string;
    order: string[]; // quizzable section ids; recalls get appended
    cursor: number; // current position in order
    gradedNow: Record<string, boolean>; // graded during this session
    hardPending: Record<string, number>; // sectionId -> re-pop timestamp
    secondsPerSection: number;
    recalled: Record<string, boolean>; // hard sections later answered easy
    sectionStart: number; // when the current section was shown
  } | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [lastGrade, setLastGrade] = useState<"easy" | "hard" | null>(null);
  const [deadline, setDeadline] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    try {
      localStorage.setItem("interna-revision-courses", JSON.stringify(revCourses));
    } catch {
      alert("Stockage plein : supprime des cours de révision pour en ajouter d'autres.");
    }
  }, [revCourses]);

  const today = todayISO();
  const unstarted = items.filter((course) => !course.addedAt);

  const outstanding = items.flatMap((course) =>
    course.addedAt
      ? stages
        .map((stage) => ({
          course,
          stage,
          date: stageDate(course, stage, isDayOff),
        }))
        .filter(
          (entry) => entry.date <= today && !course.checks[entry.stage.k],
        )
      : [],
  );

  const startedCourses = items.filter(
    (course) => course.addedAt && course.checks.J0
  ).length;

  const totalCourses = items.length;

  const totalRevisions = items.length * (stages.length - 1);

  const completedRevisions = items.reduce(
    (count, course) =>
      count +
      stages
        .filter((stage) => stage.d > 0 && course.checks[stage.k])
        .length,
    0
  );

  // ---- Statistics per module (for the radar + module cards) ----
  // Only courses with J0 checked (actually studied) are taken into account,
  // so the mastery reflects what you really learned, not the whole library.
  const moduleStats = modules.map((mod) => {
    const courses = items.filter((course) => mod.match(course.sourceSection));
    const studied = courses.filter((course) => course.checks.J0);
    // Progress = coverage of the module: studied courses (J0 validated)
    // over the total number of courses in the module.
    const mastery = courses.length
      ? Math.round((studied.length / courses.length) * 100)
      : 0;
    const counts: Record<Difficulty, number> = { easy: 0, medium: 0, hard: 0 };
    studied.forEach((course) => {
      if (course.difficulty) counts[course.difficulty] += 1;
    });
    return { ...mod, courses, studied: studied.length, mastery, counts };
  });

  const globalDifficulty: Record<Difficulty, number> = {
    easy: 0,
    medium: 0,
    hard: 0,
  };
  items.forEach((course) => {
    if (course.difficulty) globalDifficulty[course.difficulty] += 1;
  });

  // ---- Revision mode derived values ----
  const revTree = useMemo(() => buildRevTree(revCourses), [revCourses]);
  const selectedRevCourse =
    revCourses.find((course) => course.id === selectedRevCourseId) ?? null;
  const quizCourse = quiz
    ? revCourses.find((course) => course.id === quiz.courseId) ?? null
    : null;
  const quizSectionMap = useMemo(
    () => new Map((quizCourse?.sections ?? []).map((s) => [s.id, s])),
    [quizCourse],
  );
  const currentSectionId =
    quiz && quiz.order.length > 0
      ? quiz.order[Math.min(quiz.cursor, quiz.order.length - 1)]
      : null;
  const currentSection = currentSectionId
    ? quizSectionMap.get(currentSectionId) ?? null
    : null;
  const parents = useMemo(() => {
    if (!quizCourse || !currentSection) return [] as RevSection[];
    const index = quizCourse.sections.findIndex(
      (section) => section.id === currentSection.id,
    );
    const chain: RevSection[] = [];
    for (let i = index - 1; i >= 0; i--) {
      const section = quizCourse.sections[i];
      if (
        section.level < currentSection.level &&
        (chain.length === 0 ||
          section.level < chain[chain.length - 1].level)
      ) {
        chain.push(section);
      }
    }
    return chain.reverse();
  }, [quizCourse, currentSection]);
  const pendingCount = quiz ? Object.keys(quiz.hardPending).length : 0;
  const allGraded = quiz
    ? quiz.order.every((id) => quiz.gradedNow[id])
    : false;
  const finished =
    !!quiz && allGraded && pendingCount === 0 && !lastGrade;
  const waiting =
    !!quiz &&
    !finished &&
    !lastGrade &&
    quiz.cursor >= quiz.order.length - 1 &&
    !!currentSectionId &&
    !!quiz.gradedNow[currentSectionId] &&
    pendingCount > 0;
  const nextRecallIn =
    quiz && pendingCount > 0
      ? Math.max(0, Math.min(...Object.values(quiz.hardPending)) - now)
      : 0;
  const quizzableCount =
    quizCourse && quiz
      ? quizCourse.sections.filter(
        (section) =>
          section.selected !== false && section.content.trim().length > 0,
      ).length
      : 0;
  const gradedCount = quiz ? Object.keys(quiz.gradedNow).length : 0;
  // Session summary: sections graded this session (their last grade = session grade).
  const sessionStats = quiz
    ? quiz.order
      .filter((id, index) => quiz.gradedNow[id] && quiz.order.indexOf(id) === index)
      .map((id) => ({ id, stats: sectionStats(quizSectionMap.get(id) ?? { id, heading: "", level: 1, content: "" }) }))
    : [];
  const easyFirstTry = sessionStats.filter(
    (entry) => entry.stats.last === "easy" && entry.stats.attempts === 1,
  ).length;
  const recalledCount = quiz ? Object.keys(quiz.recalled).length : 0;
  const toReview =
    quiz && quizCourse
      ? quizCourse.sections.filter((section) => {
        const attempt = quiz.gradedNow[section.id];
        const stats = sectionStats(section);
        return attempt && stats.last === "hard" && !quiz.recalled[section.id];
      })
      : [];

  const systems = useMemo(
    () => [
      "Tous les systèmes",
      ...Array.from(new Set(items.map((course) => course.system))).sort(),
    ],
    [items],
  );

  const filtered = items.filter(
    (course) =>
      course.title.toLowerCase().includes(query.toLowerCase()) &&
      (system === "Tous les systèmes" || course.system === system) &&
      (section === "Tous les parcours" ||
        course.sourceSection === section),
  );

  // Group + sort the library for display. Default grouping follows the exam
  // module order (like the radar); other modes group by system and sort
  // courses inside each group by the chosen criterion.
  const groupedCourses = useMemo(() => {
    const byTitle = (a: Course, b: Course) => a.title.localeCompare(b.title, "fr");
    const sorted = [...filtered].sort((a, b) => {
      switch (sortMode) {
        case "progress":
          return progressCount(b) - progressCount(a) || byTitle(a, b);
        case "due":
          return nextDueDate(a, isDayOff).localeCompare(nextDueDate(b, isDayOff)) || byTitle(a, b);
        case "difficulty":
          return difficultyRank(a) - difficultyRank(b) || byTitle(a, b);
        default:
          return byTitle(a, b);
      }
    });

    const groups = new Map<string, { title: string; order: number; courses: Course[] }>();
    sorted.forEach((course) => {
      let key: string;
      let title: string;
      let order: number;
      if (sortMode === "module") {
        const mod = moduleOf(course);
        key = mod?.key ?? "autre";
        title = mod?.label ?? "Autre";
        order = mod ? modules.findIndex((entry) => entry.key === mod.key) : 99;
      } else {
        key = course.system;
        title = course.system;
        order = 0;
      }
      const group = groups.get(key) ?? { title, order, courses: [] };
      group.courses.push(course);
      groups.set(key, group);
    });

    return [...groups.values()].sort(
      (a, b) => a.order - b.order || a.title.localeCompare(b.title, "fr"),
    );
  }, [filtered, sortMode, isDayOff]);

  const toggle = (id: string, stageKey: string) => {
    setItems((current) =>
      current.map((course) =>
        course.id === id
          ? {
            ...course,
            checks: {
              ...course.checks,
              [stageKey]: !course.checks[stageKey],
            },
          }
          : course,
      ),
    );
  };

  const setDifficulty = (id: string, level?: Difficulty) => {
    setItems((current) =>
      current.map((course) =>
        course.id === id ? { ...course, difficulty: level } : course,
      ),
    );
  };

  const updateNote = (id: string, note: string) => {
    setItems((current) =>
      current.map((course) =>
        course.id === id ? { ...course, note } : course,
      ),
    );
  };

  const exportData = () => {
    const blob = new Blob([JSON.stringify(items, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "interna-backup.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const resetProgress = () => {
    if (
      !window.confirm(
        "Réinitialiser toute la progression ? Tous les cours redeviendront non commencés et toutes les révisions seront effacées. Les cours de la bibliothèque seront conservés."
      )
    ) {
      return;
    }

    setItems(current =>
      current.map(course => ({
        ...course,
        addedAt: "",
        checks: {},
        dateOverrides: {},
        sickOverrides: {},
      }))
    );

    setStartDateDrafts({});
    setCalendarCourseId("");
    setMoveHistory([]);

    setNotice(
      "Toute la progression a été réinitialisée. Tous les cours sont de nouveau disponibles."
    );
  };



  const resetCourseStart = (id: string) => {
    if (!window.confirm(
      "Annuler le démarrage de ce cours ? Toutes ses révisions cochées seront également effacées."
    )) return;

    setItems(current =>
      current.map(course =>
        course.id === id
          ? {
            ...course,
            addedAt: "",
            checks: {},
            dateOverrides: {},
            sickOverrides: {},
          }
          : course
      )
    );

    setNotice("Le cours est revenu dans la bibliothèque.");
  };

  // Sick-day spreading: move everything scheduled on `dateISO` to later days.
  // - Unchecked J0 (new courses) are moved to the nearest day with no new course.
  // - Revisions are moved stage by stage (J1 first, then J3, J7, J15, J30),
  //   each one placed strictly BEFORE the effective date of the next stage,
  //   on the least-loaded available day (real spreading, not just +1 day).
  const spreadSickDay = (dateISO: string) => {
    const dayProgram = scheduledForDate(items, dateISO, isDayOff);
    if (dayProgram.length === 0) {
      setNotice("Aucun cours ni révision n'était prévu ce jour-là.");
      return;
    }
    if (
      !window.confirm(
        `Reporter la journée du ${fmt(dateISO)} ?\n\n` +
        "- Les nouveaux cours seront déplacés vers un jour sans nouveau cours.\n" +
        "- Chaque révision sera replacée avant son étape suivante " +
        "(J1 avant J3, J3 avant J7, J7 avant J15, J15 avant J30).",
      )
    ) {
      return;
    }

    const working = items.map((course) => ({
      ...course,
      checks: { ...course.checks },
      dateOverrides: { ...course.dateOverrides },
      sickOverrides: { ...course.sickOverrides },
    }));

    const j0Days = new Set(
      working.filter((course) => course.addedAt).map((course) => course.addedAt),
    );

    let movedNew = 0;
    let movedRevisions = 0;

    // 1) New courses (J0 not yet done) -> nearest day with no new course.
    for (const { course } of dayProgram.filter(({ stage }) => stage.k === "J0")) {
      const target = working.find((entry) => entry.id === course.id);
      if (!target || target.checks.J0) continue; // already studied today
      let candidate = plus(dateISO, 1);
      while (j0Days.has(candidate) || isDayOff(candidate))
        candidate = plus(candidate, 1);
      j0Days.delete(target.addedAt);
      j0Days.add(candidate);
      target.addedAt = candidate;
      movedNew += 1;
    }

    // 2) Revisions, in stage order, each kept before the NEXT stage's date.
    for (const stage of stages.filter((entry) => entry.d > 0)) {
      const entries = dayProgram.filter(
        ({ course, stage: entryStage }) =>
          entryStage.k === stage.k && !course.checks[stage.k],
      );
      for (const { course } of entries) {
        const target = working.find((entry) => entry.id === course.id);
        if (!target) continue;
        const nextStage = stages.find((entry) => entry.d > stage.d);
        const nextDate = nextStage ? stageDate(target, nextStage, isDayOff) : null;
        const upperBound = nextDate ?? plus(dateISO, 45);
        const scanLimit = plus(dateISO, 45);

        let best: string | null = null;
        let bestLoad = Number.POSITIVE_INFINITY;
        let candidate = plus(dateISO, 1);
        while (candidate < upperBound && candidate <= scanLimit) {
          if (candidate > today && !isDayOff(candidate)) {
            const dayItems = scheduledForDate(working, candidate, isDayOff);
            const sameCourseConflict = dayItems.some(
              (entry) => entry.course.id === target.id,
            );
            if (!sameCourseConflict) {
              const load = dayItems.filter(
                (entry) => entry.stage.k !== "J0" && !entry.course.checks[entry.stage.k],
              ).length;
              if (load < bestLoad) {
                bestLoad = load;
                best = candidate;
              }
            }
          }
          candidate = plus(candidate, 1);
        }

        if (!best) {
          // Fallback: earliest future day with no other revision of this course.
          candidate = plus(dateISO, 1);
          while (
            candidate <= today ||
            isDayOff(candidate) ||
            scheduledForDate(working, candidate, isDayOff).some(
              (entry) => entry.course.id === target.id,
            )
          ) {
            candidate = plus(candidate, 1);
          }
          best = candidate;
        }

        // The planner date may live in dateOverrides (imported schedules):
        // clear it so the sick-day move actually takes effect, and the
        // calendar falls back to sickOverrides for this stage.
        delete target.dateOverrides[stage.k];
        target.sickOverrides[stage.k] = best;
        movedRevisions += 1;
      }
    }

    setItems(working);
    setNotice(
      `Journée du ${fmt(dateISO)} reportée : ${movedNew} nouveau(x) cours déplacé(s) vers un jour libre, ` +
      `${movedRevisions} révision(s) étalée(s) sur les jours suivants en respectant l'ordre J1 → J3 → J7 → J15 → J30.`,
    );
  };

  // Drag & drop in the calendar edit mode: pin a stage (J0..J30) to a chosen
  // day by writing a dateOverride for that stage only.
  const handleDropOnDay = (day: string) => {
    if (!dragItem) return;
    const course = items.find((entry) => entry.id === dragItem.courseId);
    const stage = stages.find((entry) => entry.k === dragItem.stageKey);
    // Remember the previous manual value so this drop can be undone alone.
    const previous = course?.dateOverrides?.[dragItem.stageKey];
    setMoveHistory((history) =>
      [...history.slice(-49), [{ ...dragItem, previous }]],
    );
    setItems((current) =>
      current.map((entry) =>
        entry.id === dragItem.courseId
          ? {
            ...entry,
            dateOverrides: {
              ...entry.dateOverrides,
              [dragItem.stageKey]: day,
            },
          }
          : entry,
      ),
    );
    if (course && stage) {
      let warning = "";
      const next = stages.find((entry) => entry.d > stage.d);
      const prev = [...stages].reverse().find((entry) => entry.d < stage.d);
      const effectiveDate = (stageKey: string, offset: number) =>
        course.dateOverrides?.[stageKey] ??
        course.sickOverrides?.[stageKey] ??
        plus(course.addedAt, offset);
      const nextDate = next ? effectiveDate(next.k, next.d) : null;
      const prevDate = prev ? effectiveDate(prev.k, prev.d) : null;
      if (nextDate && day >= nextDate) {
        warning = " ⚠️ Attention : placé APRÈS son étape suivante.";
      } else if (prevDate && day <= prevDate) {
        warning = " ⚠️ Attention : placé AVANT son étape précédente.";
      }
      setNotice(
        `Déplacé : ${stage.k} de « ${course.title} » → ${fmt(day)}.${warning}`,
      );
    }
    setDragItem(null);
    setDropDay(null);
  };

  const hasOverrides = items.some(
    (course) =>
      course.dateOverrides && Object.keys(course.dateOverrides).length > 0,
  );

  const hasSickOverrides = items.some(
    (course) =>
      course.sickOverrides && Object.keys(course.sickOverrides).length > 0,
  );

  // Undo ONLY the most recent drag & drop move, restoring whatever manual
  // value existed before it (earlier moves and sick-day reports stay intact).
  const undoLastMove = () => {
    const batch = moveHistory[moveHistory.length - 1];
    if (!batch) return;
    setItems((current) =>
      current.map((course) => {
        const records = batch.filter(
          (record) => record.courseId === course.id,
        );
        if (!records.length) return course;
        const dateOverrides = { ...course.dateOverrides };
        records.forEach((record) => {
          if (record.previous === undefined) {
            delete dateOverrides[record.stageKey];
          } else {
            dateOverrides[record.stageKey] = record.previous;
          }
        });
        return { ...course, dateOverrides };
      }),
    );
    setMoveHistory((history) => history.slice(0, -1));
    setNotice(
      `Dernier déplacement annulé (${batch.length} étape(s)). Les déplacements précédents sont conservés.`,
    );
  };

  const clearSickOverrides = () => {
    if (!window.confirm("Effacer tous les reports de journées malades ?\n\nLes révisions replacées par les boutons « Je suis malade » reviendront à leur date calculée (J0 → J30). Les déplacements manuels resteront.")) {
      return;
    }
    setItems((current) =>
      current.map((course) => ({ ...course, sickOverrides: {} })),
    );
    setNotice("Reports de journées malades effacés — les déplacements manuels sont conservés.");
  };

  // ---- Revision mode handlers ----
  const handleRevisionUpload = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const added: RevCourse[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    for (const file of Array.from(files)) {
      if (!/\.(docx|txt|md)$/i.test(file.name)) continue;
      try {
        const sections = /\.docx$/i.test(file.name)
          ? await parseDocxFile(file)
          : parseTextFile(await file.text());
        if (sections.length < 2) {
          skipped.push(file.name); // not enough structure detected
          continue;
        }
        const relative =
          (file as File & { webkitRelativePath?: string })
            .webkitRelativePath || "";
        const path = relative ? relative.split("/").slice(0, -1).join("/") : "";
        added.push({
          id: crypto.randomUUID(),
          title: file.name.replace(/\.[^.]+$/, ""),
          path,
          sections,
        });
      } catch {
        failed.push(file.name); // unreadable
      }
    }
    if (added.length > 0) {
      setRevCourses((current) => [...current, ...added]);
    }
    const names = (list: string[]) =>
      list.slice(0, 3).join(", ") + (list.length > 3 ? "…" : "");
    const parts: string[] = [];
    if (added.length > 0) {
      parts.push(
        `${added.length} cours ajouté(s) — la structure des dossiers est conservée.`,
      );
    }
    if (skipped.length > 0) {
      parts.push(
        `${skipped.length} ignoré(s), titres non détectés : ${names(skipped)}`,
      );
    }
    if (failed.length > 0) {
      parts.push(`${failed.length} illisible(s) : ${names(failed)}`);
    }
    setNotice(
      parts.join(" · ") ||
      "Aucun cours ajouté : utilise des fichiers .docx, .txt ou .md avec des titres détectables.",
    );
  };

  const deleteRevCourse = (id: string) => {
    setRevCourses((current) => current.filter((course) => course.id !== id));
    if (selectedRevCourseId === id) setSelectedRevCourseId(null);
    if (quiz?.courseId === id) setQuiz(null);
  };

  // ---- Course / section editing (write-through to revCourses) ----
  const updateRevSection = (
    courseId: string,
    sectionId: string,
    patch: Partial<RevSection>,
  ) => {
    setRevCourses((current) =>
      current.map((course) =>
        course.id !== courseId
          ? course
          : {
            ...course,
            sections: course.sections.map((section) =>
              section.id !== sectionId ? section : { ...section, ...patch },
            ),
          },
      ),
    );
  };

  const addRevSection = (courseId: string) => {
    setRevCourses((current) =>
      current.map((course) =>
        course.id !== courseId
          ? course
          : {
            ...course,
            sections: [
              ...course.sections,
              {
                id: crypto.randomUUID(),
                heading: "Nouvelle section",
                level: 2,
                content: "",
                selected: true,
              },
            ],
          },
      ),
    );
  };

  const deleteRevSection = (courseId: string, sectionId: string) => {
    setRevCourses((current) =>
      current.map((course) =>
        course.id !== courseId
          ? course
          : {
            ...course,
            sections: course.sections.filter(
              (section) => section.id !== sectionId,
            ),
          },
      ),
    );
  };

  const setRevTag = (courseId: string, tag?: RevCourse["tag"]) => {
    setRevCourses((current) =>
      current.map((course) =>
        course.id === courseId ? { ...course, tag } : course,
      ),
    );
  };

  // ---- Quiz engine (cursor-based, with navigation) ----
  const moveTo = (index: number) => {
    if (!quiz) return;
    setQuiz((q) =>
      q ? { ...q, cursor: index, sectionStart: Date.now() } : q,
    );
    setRevealed(false);
    setLastGrade(null);
    setDeadline(Date.now() + quiz.secondsPerSection * 1000);
  };

  const startQuiz = (courseId: string, secondsPerSection: number) => {
    const course = revCourses.find((entry) => entry.id === courseId);
    if (!course) return;
    const quizzable = course.sections.filter(
      (section) => section.selected !== false && section.content.trim().length > 0,
    );
    if (quizzable.length === 0) {
      setNotice("Aucune section sélectionnée avec du contenu dans ce cours.");
      return;
    }
    setQuiz({
      courseId,
      order: shuffle(quizzable.map((section) => section.id)),
      cursor: 0,
      gradedNow: {},
      hardPending: {},
      secondsPerSection,
      recalled: {},
      sectionStart: Date.now(),
    });
    setRevealed(false);
    setLastGrade(null);
    setDeadline(Date.now() + secondsPerSection * 1000);
  };

  const grade = (g: "easy" | "hard") => {
    if (!quiz || !quizCourse || lastGrade) return;
    const sectionId = quiz.order[quiz.cursor];
    const section = quizCourse.sections.find(
      (entry) => entry.id === sectionId,
    );
    if (!section) return;
    const elapsed = Math.max(
      1,
      Math.round((Date.now() - quiz.sectionStart) / 1000),
    );
    const tries = (section.grades?.length ?? 0) + 1;
    const wasPending = sectionId in quiz.hardPending;
    // Persist grade + answer time into the course (drives all stats).
    setRevCourses((current) =>
      current.map((course) =>
        course.id !== quiz.courseId
          ? course
          : {
            ...course,
            sections: course.sections.map((entry) =>
              entry.id !== sectionId
                ? entry
                : {
                  ...entry,
                  grades: [...(entry.grades ?? []), g],
                  times: [...(entry.times ?? []), elapsed],
                },
            ),
          },
      ),
    );
    setQuiz((q) => {
      if (!q) return q;
      const hardPending = { ...q.hardPending };
      if (g === "hard" && tries <= MAX_TRIES) {
        hardPending[sectionId] = Date.now() + RECALL_MINUTES * 60 * 1000;
      } else {
        delete hardPending[sectionId];
      }
      return {
        ...q,
        hardPending,
        gradedNow: { ...q.gradedNow, [sectionId]: true },
        recalled:
          wasPending && g === "easy"
            ? { ...q.recalled, [sectionId]: true }
            : q.recalled,
      };
    });
    setLastGrade(g);
    setRevealed(true);
  };

  const advance = () => {
    if (!quiz) return;
    if (quiz.cursor + 1 < quiz.order.length) {
      moveTo(quiz.cursor + 1);
      return;
    }
    // End of the list: pull in due hard recalls if any.
    const dueIds = Object.entries(quiz.hardPending)
      .filter(([, dueAt]) => dueAt <= Date.now())
      .map(([id]) => id);
    if (dueIds.length > 0) {
      setQuiz((q) =>
        q
          ? {
            ...q,
            order: [...q.order, ...dueIds],
            cursor: q.cursor + 1,
            sectionStart: Date.now(),
          }
          : q,
      );
      setRevealed(false);
      setLastGrade(null);
      setDeadline(Date.now() + quiz.secondsPerSection * 1000);
      return;
    }
    // Otherwise wrap to the first section not graded this session (skips).
    const firstUngraded = quiz.order.findIndex((id) => !quiz.gradedNow[id]);
    if (firstUngraded !== -1) {
      moveTo(firstUngraded);
      return;
    }
    // Nothing left to do: release the current question so the
    // waiting / finished screens can take over.
    setLastGrade(null);
    setRevealed(false);
  };

  const goBack = () => {
    if (!quiz || quiz.cursor === 0) return;
    moveTo(quiz.cursor - 1);
  };

  const skipSection = () => {
    if (!quiz) return;
    const sectionId = quiz.order[quiz.cursor];
    setQuiz((q) => {
      if (!q) return q;
      const hardPending = { ...q.hardPending };
      delete hardPending[sectionId]; // abandon recall for this one
      return { ...q, hardPending };
    });
    advance();
  };

  // 1-second ticker while a quiz runs.
  useEffect(() => {
    if (!quiz) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [quiz]);

  // Auto-reveal the response when the countdown reaches 0.
  const secondsLeft =
    quiz && quiz.order.length > 0
      ? Math.max(0, Math.ceil((deadline - now) / 1000))
      : 0;
  useEffect(() => {
    if (quiz && quiz.order.length > 0 && !revealed && secondsLeft === 0) {
      setRevealed(true);
    }
  }, [secondsLeft, revealed, quiz]);

  // Sitting on the last graded section while hard recalls become due:
  // pull them in automatically.
  useEffect(() => {
    if (!quiz || !quizCourse) return;
    if (lastGrade) return; // user is still reading the graded response
    if (quiz.cursor < quiz.order.length - 1) return;
    const currentId = quiz.order[quiz.cursor];
    if (!currentId || !quiz.gradedNow[currentId]) return;
    const dueIds = Object.entries(quiz.hardPending)
      .filter(([, dueAt]) => dueAt <= Date.now())
      .map(([id]) => id);
    if (dueIds.length === 0) return;
    setQuiz((q) =>
      q
        ? {
          ...q,
          order: [...q.order, ...dueIds],
          cursor: q.cursor + 1,
          sectionStart: Date.now(),
        }
        : q,
    );
    setRevealed(false);
    setLastGrade(null);
    setDeadline(Date.now() + quiz.secondsPerSection * 1000);
  }, [now, quiz, quizCourse, lastGrade]);

  const importData = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported: unknown = JSON.parse(String(reader.result));
        if (Array.isArray(imported)) {
          setItems(
            imported.map((entry) => normalizeCourse(entry as Partial<Course>)),
          );
          setNotice("Sauvegarde importée.");
        } else {
          alert("Fichier invalide");
        }
      } catch {
        alert("Impossible de lire ce fichier");
      }
    };
    reader.readAsText(file);
  };

  const startCourse = (id: string, startDate = today) => {
    setItems((current) =>
      current.map((course) =>
        course.id === id && !course.addedAt
          ? {
            ...course,
            addedAt: startDate,
            checks:
              startDate < today
                ? { ...course.checks, J0: true }
                : course.checks,
          }
          : course,
      ),
    );
    setStartDateDrafts((current) => ({ ...current, [id]: startDate }));
    setNotice(
      startDate < today
        ? `Cours marqué comme étudié le ${fmt(startDate)}. J0 est terminé et les révisions suivantes sont planifiées.`
        : "",
    );
  };

  const changeCourseStartDate = (id: string, startDate: string) => {
    if (!startDate) return;
    setItems((current) =>
      current.map((course) =>
        course.id === id
          ? {
            ...course,
            addedAt: startDate,
            dateOverrides: {},
            sickOverrides: {},
            checks:
              startDate < today
                ? { ...course.checks, J0: true }
                : course.checks,
          }
          : course,
      ),
    );
    setStartDateDrafts((current) => ({ ...current, [id]: startDate }));
    setNotice(
      `Révisions recalculées depuis le ${fmt(startDate)}. Les cases cochées sont conservées.`,
    );
  };

  const add = () => {
    if (!newTitle.trim()) return;
    const newCourse: Course = {
      id: crypto.randomUUID(),
      title: newTitle.trim(),
      system: newSystem,
      sourceSection: newSection,
      addedAt: today,
      checks: {},
      custom: true,
    };
    setItems((current) => [newCourse, ...current]);
    setNewTitle("");
    setShowAdd(false);
    setNotice("Cours ajouté et commencé · J0 est prévu aujourd’hui.");
  };

  const firstOfMonth = `${visibleMonth}-01`;
  const firstWeekday = new Date(`${firstOfMonth}T12:00:00`).getDay();
  const calendarStart = plus(firstOfMonth, -((firstWeekday + 6) % 7));
  const calendarDays = Array.from({ length: 42 }, (_, index) =>
    plus(calendarStart, index),
  );
  const selectedDayItems = scheduledForDate(items, selectedDate, isDayOff);
  const monthLabel = new Date(`${firstOfMonth}T12:00:00`).toLocaleDateString(
    "fr-FR",
    { month: "long", year: "numeric" },
  );

  const stat = (label: string, value: string, subtitle: string) => (
    <div className="panel p-4">
      <div className="text-xs muted">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
      <div className="mt-1 text-xs muted">{subtitle}</div>
    </div>
  );

  // Radar data for the animated chart (one entry per module, unique color).
  const radarData = moduleStats.map((mod) => ({
    module: mod.short,
    value: mod.mastery,
    color: mod.color,
  }));

  return (
    <div className="min-h-screen lg:flex">
      <aside className="flex flex-col gap-5 bg-[#10251f] p-4 text-white sm:p-5 lg:min-h-screen lg:w-64">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-[#d5e7d8] p-2 text-[#1b513c]">
            <Stethoscope size={23} />
          </div>
          <div>
            <div className="text-lg font-bold tracking-wide">INTERNA</div>
            <div className="text-xs text-emerald-100/60">
              Study command center
            </div>
          </div>
        </div>

        <nav className="flex gap-1 overflow-x-auto lg:flex-col" aria-label="Navigation principale">
          {[
            { key: "today", label: "Home", Icon: House },
            { key: "courses", label: "Mes cours", Icon: BookOpen },
            { key: "calendar", label: "Calendrier", Icon: CalendarDays },
            { key: "revise", label: "Réviser", Icon: Brain },
          ].map(({ key, label, Icon }) => (
            <button
              key={key}
              className={`navbtn shrink-0 ${tab === key ? "active" : ""}`}
              onClick={() => setTab(key)}
              aria-current={tab === key ? "page" : undefined}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </nav>

        <div className="hidden text-xs leading-5 text-emerald-100/60 lg:block">
          Tes révisions restent sur cet appareil grâce au stockage local.
        </div>
      </aside>

      <main className="max-w-[1500px] min-w-0 flex-1 p-4 md:p-8">
        <header className="mb-7 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm muted">Bonjour — garde le rythme</div>
            <h1 className="text-2xl font-bold text-[#18382c] md:text-3xl">
              {tab === "today"
                ? "Accueil"
                : tab === "courses"
                  ? "Bibliothèque des cours"
                  : tab === "calendar"
                    ? "Calendrier de révision"
                    : "Mode révision"}
            </h1>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={exportData}
              className="field flex items-center gap-2 text-sm"
            >
              <Download size={16} />
              Exporter
            </button>

            <label className="field flex cursor-pointer items-center gap-2 text-sm">
              <Upload size={16} />
              Importer
              <input
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(event) => importData(event.target.files?.[0])}
              />
            </label>
            <button
              onClick={resetProgress}
              className="field flex items-center gap-2 text-sm text-rose-700"
            >
              <RotateCcw size={16} />
              Réinitialiser ma progression
            </button>
          </div>
        </header>



        
        {notice && (
          <div
            role="status"
            className="panel mb-5 flex items-center justify-between gap-3 px-4 py-3 text-sm"
          >
            <span>{notice}</span>
            <button
              className="font-semibold text-[#205e45]"
              onClick={() => setNotice("")}
            >
              Fermer
            </button>
          </div>
        )}

        {tab === "today" && (
          <>
<div className="mb-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
          {stat(
            "Cours dans ta bibliothèque",
            String(items.length),
            `${startedCourses} commencés`
          )}

          {stat(
            "Cours commencés",
            `${totalCourses ? Math.round((startedCourses / totalCourses) * 100) : 0}% `,
            `${startedCourses} / ${totalCourses} du programme`
          )}

          {stat(
            "Révisions terminées",
            `${totalRevisions ? Math.round((completedRevisions / totalRevisions) * 100) : 0}%`,
            `${completedRevisions} / ${totalRevisions} des révisions`
          )}

          {stat(
            "Révisions restantes",
            String(outstanding.length),
            `${outstanding.filter((entry) => entry.date < today).length} en retard · ${outstanding.filter((entry) => entry.date === today).length} aujourd'hui`
          )}
        </div>
            <section className="panel mb-5 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold">Charge du jour</h2>
                  <p className="text-sm muted">{fmtLong(today)}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="pill">
                    {outstanding.filter((entry) => entry.stage.k === "J0").length}{" "}
                    nouveau(x) ·{" "}
                    {outstanding.filter((entry) => entry.stage.k !== "J0").length}{" "}
                    révision(s)
                  </span>
                  <button
                    onClick={() => spreadSickDay(today)}
                    disabled={outstanding.length === 0}
                    title="Malade ? Étale la journée sur les jours suivants"
                    className="field flex items-center gap-2 text-sm text-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <CalendarX size={16} />
                    Je suis malade — étaler la journée
                  </button>
                </div>
              </div>

              {outstanding.length === 0 ? (
                <div className="mt-5 rounded-xl bg-[#f1f6f1] p-6 text-center">
                  <CheckCircle2 className="mx-auto mb-2 text-emerald-700" />
                  <b>Tout est à jour !</b>
                  <p className="mt-1 text-sm muted">
                    Ajoute un nouveau cours ou profite de cette avance.
                  </p>
                </div>
              ) : (
                <div className="mt-5 grid gap-5 lg:grid-cols-2">
                  {[
                    {
                      title: "Nouveaux cours",
                      entries: outstanding.filter(
                        (entry) => entry.stage.k === "J0",
                      ),
                      headerClass: "text-emerald-700",
                    },
                    {
                      title: "Révisions",
                      entries: outstanding
                        .filter((entry) => entry.stage.k !== "J0")
                        .sort((a, b) => a.date.localeCompare(b.date)),
                      headerClass: "text-blue-700",
                    },
                  ].map(({ title, entries, headerClass }) => (
                    <section key={title}>
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <h3 className={`font-semibold ${headerClass}`}>
                          {title}
                        </h3>
                        <span className="pill">{entries.length}</span>
                      </div>
                      {entries.length === 0 ? (
                        <p className="rounded-xl bg-[#f7f9f7] p-4 text-sm muted">
                          Rien dans cette catégorie.
                        </p>
                      ) : (
                        <div className="divide-y">
                          {entries.map(({ course, stage, date }) => (
                            <label
                              key={`${course.id}-${stage.k}`}
                              className="flex cursor-pointer items-center justify-between gap-3 py-3"
                            >
                              <span className="min-w-0">
                                <span className="flex items-center gap-2">
                                  {course.difficulty && (
                                    <span
                                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                                      style={{
                                        background:
                                          difficultyMeta[course.difficulty].color,
                                      }}
                                      title={`Mémorisation : ${difficultyMeta[course.difficulty].label}`}
                                    />
                                  )}
                                  <span className="block truncate font-medium">
                                    {course.title}
                                  </span>
                                </span>
                                <span className="text-xs muted">
                                  {course.system} · {stage.k} · {fmt(date)}
                                </span>
                                {date < today && (
                                  <span className="mt-0.5 inline-block w-fit rounded-full bg-[#fee2e2] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#991b1b]">
                                    en retard
                                  </span>
                                )}
                              </span>
                              <input
                                type="checkbox"
                                className="check"
                                checked={!!course.checks[stage.k]}
                                onChange={() => toggle(course.id, stage.k)}
                                aria-label={`Terminer ${stage.k} · ${course.title}`}
                              />
                            </label>
                          ))}
                        </div>
                      )}
                    </section>
                  ))}
                </div>
              )}
            </section>

            <section className="panel p-4 sm:p-5">
              <h2 className="text-lg font-bold">Radar des modules</h2>
              <p className="mt-1 text-xs muted">
                Avancement = cours étudiés (J0 validé) / total des cours du
                module.
              </p>

              <div
                className="mx-auto mt-2 w-full max-w-[460px]"
                style={{ height: 380 }}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart data={radarData} cx="50%" cy="50%" outerRadius="72%">
                    <PolarGrid stroke="#d6ddd8" />
                    <PolarAngleAxis dataKey="module" tick={radarTick} />
                    <PolarRadiusAxis
                      domain={[0, 100]}
                      tick={false}
                      axisLine={false}
                    />
                    <RadarSeries
                      dataKey="value"
                      stroke="#1e6248"
                      fill="#1e6248"
                      fillOpacity={0.25}
                      strokeWidth={2.5}
                      dot={radarDot}
                      isAnimationActive
                      animationDuration={900}
                      animationEasing="ease-out"
                    />
                    <Tooltip
                      formatter={(value: unknown, _name: unknown, item: unknown) => {
                        const numeric =
                          typeof value === "number" ? value : Number(value) || 0;
                        const moduleName = (
                          item as { payload?: { module?: string } } | undefined
                        )?.payload?.module;
                        return [`${numeric}%`, moduleName ?? ""];
                      }}
                    />
                  </RadarChart>
                </ResponsiveContainer>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-center gap-3 border-t border-[#edf0ed] pt-3 text-xs">
                <span className="flex items-center gap-2">
                  <span className="inline-block h-3 w-3 rounded-sm" style={{ background: "rgba(30,98,72,0.35)", border: "1.5px solid #1e6248" }} />
                  Ta maîtrise actuelle
                </span>
                {(Object.keys(difficultyMeta) as Difficulty[]).map((level) => (
                  <span key={level} className="flex items-center gap-1">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ background: difficultyMeta[level].color }}
                    />
                    {globalDifficulty[level]} {difficultyMeta[level].label.toLowerCase()}
                    {globalDifficulty[level] > 1 ? "s" : ""}
                  </span>
                ))}
              </div>
            </section>

            <section className="panel p-4 sm:p-5">
                        <h2 className="mb-3 text-lg font-bold">Détail par module</h2>
                          <div className="grid gap-3 sm:grid-cols-2">
                            {moduleStats.map((mod) => (
                              <div className="panel p-4" key={mod.key}>
                                <div className="flex items-center justify-between gap-2">
                                  <b className="flex min-w-0 items-center gap-2">
                                    <span
                                      className="inline-block h-3 w-3 shrink-0 rounded-full"
                                      style={{ background: mod.color }}
                                    />
                                    <span className="truncate">{mod.label}</span>
                                  </b>
                                  <span className="text-lg font-bold" style={{ color: mod.color }}>
                                    {mod.mastery}%
                                  </span>
                                </div>
            
                                <div
                                  className="mt-2 h-2 overflow-hidden rounded-full bg-[#e7eee8]"
                                  role="progressbar"
                                  aria-valuenow={mod.mastery}
                                  aria-valuemin={0}
                                  aria-valuemax={100}
                                  aria-label={`Avancement ${mod.label}`}
                                >
                                  <div
                                    className="h-full rounded-full transition-all"
                                    style={{
                                      width: `${mod.mastery}%`,
                                      background: mod.color,
                                    }}
                                  />
                                </div>
            
                                <div className="mt-2 text-xs muted">
                                  {mod.studied} / {mod.courses.length} cours étudiés (J0
                                  validé)
                                </div>
            
                                <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                                  {(Object.keys(difficultyMeta) as Difficulty[]).map(
                                    (level) => (
                                      <span
                                        key={level}
                                        className="flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold"
                                        style={{
                                          background: difficultyMeta[level].bg,
                                          color: difficultyMeta[level].text,
                                        }}
                                      >
                                        <span
                                          className="inline-block h-1.5 w-1.5 rounded-full"
                                          style={{
                                            background: difficultyMeta[level].color,
                                          }}
                                        />
                                        {mod.counts[level]} {difficultyMeta[level].label.toLowerCase()}
                                        {mod.counts[level] > 1 ? "s" : ""}
                                      </span>
                                    ),
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
            
                          <p className="mt-3 text-xs muted">
                            Astuce : marque chaque cours comme Facile / Moyen / Difficile
                            dans « Mes cours » pour repérer en un coup d'œil ce qui te
                            résiste. Les notes personnelles t'aident à mémoriser ce que tu
                            as déjà su retenir.
                          </p>
                        </section>

            <section className="panel p-5">
              <h2 className="mb-3 font-bold">Cycle de répétition</h2>
              <div className="grid grid-cols-3 gap-2 md:grid-cols-6">
                {stages.map((stage) => (
                  <div className="day" key={stage.k}>
                    <div className="font-bold text-[#245c43]">{stage.k}</div>
                    <div className="text-xs muted">
                      {stage.d === 0 ? "Le jour même" : `+${stage.d} jours`}
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs muted">
                Chaque date est calculée à partir du jour où tu commences le
                cours. Tu peux cocher les étapes en avance ou en retard.
              </p>
            </section>
          </>
        )}

        {tab === "courses" && (
          <>
            <div className="mb-4 flex flex-wrap gap-2">
              <div className="relative min-w-[210px] flex-1">
                <Search
                  className="absolute left-3 top-3 text-gray-400"
                  size={16}
                />
                <input
                  className="field w-full pl-9"
                  placeholder="Rechercher un cours..."
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>

              <select
                className="field"
                value={system}
                onChange={(event) => setSystem(event.target.value)}
              >
                {systems.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>

              <select
                className="field"
                value={section}
                onChange={(event) => setSection(event.target.value)}
              >
                <option>Tous les parcours</option>
                {Array.from(
                  new Set(items.map((course) => course.sourceSection)),
                ).map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>

              <select
                className="field"
                value={sortMode}
                onChange={(event) => setSortMode(event.target.value as SortMode)}
                aria-label="Trier les cours"
                title="Trier les cours"
              >
                <option value="module">Trier : Parcours</option>
                <option value="system">Trier : Système</option>
                <option value="progress">Trier : Progression</option>
                <option value="due">Trier : Prochaine révision</option>
                <option value="difficulty">Trier : Difficulté</option>
              </select>

              <button
                onClick={() => setShowAdd((visible) => !visible)}
                className="flex items-center gap-2 rounded-xl bg-[#1e6248] px-4 text-white"
              >
                <Plus size={17} />
                Ajouter
              </button>
            </div>

            {showAdd && (
              <form
                className="panel mb-4 grid gap-2 p-4 md:grid-cols-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  add();
                }}
              >
                <input
                  className="field md:col-span-2"
                  placeholder="Nom du cours"
                  value={newTitle}
                  onChange={(event) => setNewTitle(event.target.value)}
                  required
                />
                <input
                  className="field"
                  value={newSystem}
                  onChange={(event) => setNewSystem(event.target.value)}
                  placeholder="Système"
                />
                <select
                  className="field"
                  value={newSection}
                  onChange={(event) => setNewSection(event.target.value)}
                >
                  {[
                    "Anatomie — Admissibilité",
                    "Biologie — Admissibilité",
                    "Médecine — Admissibilité",
                    "Chirurgie — Admissibilité",
                    "Médecine — Admission — Urgences",
                    "Médecine — Admission — Conduites à tenir",
                    "Chirurgie — Admission — Urgences",
                    "Chirurgie — Admission — Conduites à tenir",
                  ].map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
                <button
                  type="submit"
                  className="rounded-xl bg-[#1e6248] px-4 py-2 text-white"
                >
                  Enregistrer le cours
                </button>
              </form>
            )}

            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm muted">
              <span>{filtered.length} cours affichés</span>
              <span aria-hidden="true">·</span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: difficultyMeta.easy.color }} />
                {globalDifficulty.easy} faciles
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: difficultyMeta.medium.color }} />
                {globalDifficulty.medium} moyens
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: difficultyMeta.hard.color }} />
                {globalDifficulty.hard} difficiles
              </span>
            </div>

            <div className="space-y-3">
              {groupedCourses.map((group) => (
                <section className="panel overflow-hidden" key={group.title}>
                  <div className="flex justify-between bg-[#f0f5f0] px-4 py-3">
                    <b>{group.title}</b>
                    <span className="text-xs muted">
                      {group.courses.length} cours
                    </span>
                  </div>

                  {group.courses.map((course) => (
                    <div
                      key={course.id}
                      className="border-t border-[#edf0ed] p-4"
                    >
                      <div className="flex justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            {course.difficulty && (
                              <span
                                className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                                style={{
                                  background: difficultyMeta[course.difficulty].bg,
                                  color: difficultyMeta[course.difficulty].text,
                                }}
                              >
                                {difficultyMeta[course.difficulty].label}
                              </span>
                            )}
                            <div className="truncate font-medium">{course.title}</div>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-start gap-2">
                          {course.note && (
                            <span
                              title="Ce cours a une note"
                              className="mt-0.5 text-amber-600"
                            >
                              <StickyNote size={15} />
                            </span>
                          )}
                          {course.addedAt && (
                            <button
                              title="Annuler le démarrage"
                              aria-label={`Annuler le démarrage de ${course.title}`}
                              onClick={() => resetCourseStart(course.id)}
                              className="text-amber-600"
                            >
                              <RotateCcw size={16} />
                            </button>
                          )}
                          {course.custom && (
                            <button
                              title="Supprimer"
                              aria-label={`Supprimer ${course.title}`}
                              onClick={() =>
                                setItems((current) =>
                                  current.filter((item) => item.id !== course.id),
                                )
                              }
                              className="text-red-400"
                            >
                              <Trash2 size={16} />
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="mt-1 text-xs muted">
                        {course.sourceSection}
                      </div>

                      {/* Mémorisation : difficulté + notes */}
                      <div className="mt-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="mr-1 text-xs muted">
                            Mémorisation :
                          </span>
                          {(Object.keys(difficultyMeta) as Difficulty[]).map(
                            (level) => {
                              const meta = difficultyMeta[level];
                              const active = course.difficulty === level;
                              return (
                                <button
                                  key={level}
                                  type="button"
                                  onClick={() =>
                                    setDifficulty(
                                      course.id,
                                      active ? undefined : level,
                                    )
                                  }
                                  aria-pressed={active}
                                  className="rounded-full border px-3 py-1 text-xs font-semibold transition"
                                  style={
                                    active
                                      ? {
                                        background: meta.bg,
                                        color: meta.text,
                                        borderColor: meta.color,
                                      }
                                      : {
                                        borderColor: "#d6ddd8",
                                        color: "#6b7f74",
                                      }
                                  }
                                >
                                  {meta.label}
                                </button>
                              );
                            },
                          )}
                        </div>
                        <details className="mt-2 rounded-xl bg-[#f7f9f7] px-3">
                          <summary className="cursor-pointer py-2.5 text-xs font-semibold text-[#205e45]">
                            Notes & souvenirs{" "}
                            {course.note ? `(${course.note.length} caractères)` : ""}
                          </summary>
                          <textarea
                            className="field mb-3 w-full resize-y text-sm"
                            rows={2}
                            placeholder="Ex. : j'oublie toujours les branches de l'artère axillaire…"
                            value={course.note ?? ""}
                            onChange={(event) =>
                              updateNote(course.id, event.target.value)
                            }
                          />
                        </details>
                      </div>

                      {!course.addedAt ? (
                        <div className="mt-3 flex flex-wrap items-end gap-3">
                          <label className="grid gap-1 text-xs muted">
                            Date d’étude initiale
                            <input
                              className="field text-sm"
                              type="date"
                              value={startDateDrafts[course.id] ?? today}
                              onChange={(event) =>
                                setStartDateDrafts((current) => ({
                                  ...current,
                                  [course.id]: event.target.value,
                                }))
                              }
                            />
                          </label>
                          <button
                            onClick={() =>
                              startCourse(
                                course.id,
                                startDateDrafts[course.id] ?? today,
                              )
                            }
                            className="rounded-lg bg-[#e8f2eb] px-3 py-2 text-sm font-semibold text-[#205e45] disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Planifier les révisions
                          </button>
                          <span className="w-full text-xs muted">
                            Pour un cours déjà étudié, choisis sa date passée.
                            J0 sera terminé et les révisions suivantes seront calculées depuis ce jour.
                          </span>
                        </div>
                      ) : (
                        <>
                          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
                            {stages.map((stage) => {
                              const dueDate = stageDate(course, stage, isDayOff);
                              const isDone = !!course.checks[stage.k];
                              const isOverridden =
                                !!course.dateOverrides?.[stage.k] ||
                                !!course.sickOverrides?.[stage.k];

                              return (
                                <label
                                  key={stage.k}
                                  className={`day cursor-pointer ${isDone ? "done" : ""}`}
                                  title={
                                    isOverridden
                                      ? `Date déplacée (report / déplacement manuel) · initialement ${fmt(plus(course.addedAt, stage.d))}`
                                      : undefined
                                  }
                                >
                                  <input
                                    className="check"
                                    type="checkbox"
                                    checked={isDone}
                                    onChange={() => toggle(course.id, stage.k)}
                                  />
                                  <div className="mt-1 text-sm font-bold">
                                    {stage.k}
                                    {isOverridden && !isDone && (
                                      <span className="ml-1 text-[9px] text-rose-500">
                                        ↷
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[10px] muted">
                                    {fmt(dueDate)}
                                  </div>
                                </label>
                              );
                            })}
                          </div>
                          <details className="mt-3 rounded-xl bg-[#f7f9f7] px-3">
                            <summary className="cursor-pointer py-3 text-sm font-semibold text-[#205e45]">
                              Modifier la date d’étude initiale
                            </summary>
                            <div className="flex flex-wrap items-end gap-3 pb-3">
                              <label className="grid gap-1 text-xs muted">
                                Nouvelle date
                                <input
                                  className="field text-sm"
                                  type="date"
                                  max={today}
                                  value={
                                    startDateDrafts[course.id] ??
                                    course.addedAt
                                  }
                                  onChange={(event) =>
                                    setStartDateDrafts((current) => ({
                                      ...current,
                                      [course.id]: event.target.value,
                                    }))
                                  }
                                />
                              </label>
                              <button
                                onClick={() =>
                                  changeCourseStartDate(
                                    course.id,
                                    startDateDrafts[course.id] ??
                                    course.addedAt,
                                  )
                                }
                                className="rounded-lg bg-[#e8f2eb] px-3 py-2 text-sm font-semibold text-[#205e45]"
                              >
                                Recalculer les révisions
                              </button>
                              <span className="text-xs muted">
                                Les cases déjà cochées seront conservées. Les
                                reports de journées malades seront effacés.
                              </span>
                            </div>
                          </details>
                        </>
                      )}
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </>
        )}

        {tab === "calendar" && (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]">
            <section className="panel p-4 sm:p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold">Calendrier mensuel</h2>
                  <p className="text-sm capitalize muted">{monthLabel}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    className="field p-2"
                    aria-label="Mois précédent"
                    onClick={() => {
                      const month = shiftMonth(visibleMonth, -1);
                      setVisibleMonth(month);
                      setSelectedDate(`${month}-01`);
                    }}
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <button
                    className="field text-sm"
                    onClick={() => {
                      setVisibleMonth(today.slice(0, 7));
                      setSelectedDate(today);
                    }}
                  >
                    Aujourd’hui
                  </button>
                  <button
                    className="field p-2"
                    aria-label="Mois suivant"
                    onClick={() => {
                      const month = shiftMonth(visibleMonth, 1);
                      setVisibleMonth(month);
                      setSelectedDate(`${month}-01`);
                    }}
                  >
                    <ChevronRight size={18} />
                  </button>
                  <button
                    className="field flex items-center gap-2 text-sm"
                    style={
                      editMode
                        ? { background: "#1e6248", color: "#ffffff" }
                        : undefined
                    }
                    aria-pressed={editMode}
                    onClick={() => {
                      setEditMode((active) => !active);
                      setDragItem(null);
                      setDropDay(null);
                    }}
                  >
                    <GripVertical size={16} />
                    Mode édition
                  </button>
                  {editMode && moveHistory.length > 0 && (
                    <button
                      className="field flex items-center gap-2 text-sm text-rose-700"
                      onClick={undoLastMove}
                      title={`${moveHistory.length} déplacement(s) à annuler`}
                    >
                      <RotateCcw size={14} />
                      Annuler le dernier déplacement
                    </button>
                  )}
                  {editMode && hasSickOverrides && (
                    <button
                      className="field text-sm text-amber-700"
                      onClick={clearSickOverrides}
                    >
                      Effacer les reports malades
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-semibold text-[#52645a] sm:gap-2 sm:text-xs">
                {["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"].map(
                  (day) => (
                    <div key={day} className="py-2">
                      {day}
                    </div>
                  ),
                )}
              </div>
              <div className="mb-3 flex flex-wrap gap-4 text-xs">
                <span className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-600" />
                  Nouveaux cours
                </span>
                <span className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-blue-600" />
                  Révisions
                </span>
              </div>
              <div className="grid grid-cols-7 gap-1 sm:gap-2">
                {calendarDays.map((day) => {
                  const scheduled = scheduledForDate(items, day, isDayOff);

                  const newCourses = scheduled.filter(
                    ({ stage }) => stage.k === "J0"
                  );

                  const revisions = scheduled.filter(
                    ({ stage }) => stage.k !== "J0"
                  );

                  const remaining = scheduled.filter(
                    ({ course, stage }) => !course.checks[stage.k]
                  ).length;


                  const inMonth = day.slice(0, 7) === visibleMonth;
                  const isSelected = day === selectedDate;

                  return (
                    <button
                      key={day}
                      onClick={() => {
                        setSelectedDate(day);
                        setVisibleMonth(day.slice(0, 7));
                      }}
                      onDragOver={(event) => {
                        if (editMode && dragItem) {
                          event.preventDefault();
                          setDropDay(day);
                        }
                      }}
                      onDragLeave={() => {
                        if (dropDay === day) setDropDay(null);
                      }}
                      onDrop={(event) => {
                        if (!editMode) return;
                        event.preventDefault();
                        handleDropOnDay(day);
                      }}
                      aria-pressed={isSelected}
                      aria-label={`${fmtLong(day)} · ${remaining} révisions restantes`}
                      className={`min-h-[66px] rounded-xl border p-1 text-left transition sm:min-h-[82px] sm:p-2 ${isSelected
                          ? "border-[#1e6248] bg-[#e8f2eb] ring-1 ring-[#1e6248]"
                          : "border-[#edf0ed] bg-white hover:bg-[#f7f9f7]"
                        } ${!inMonth ? "opacity-45" : ""} ${isDayOff(day) ? "bg-[#f3f4f6]" : ""} ${editMode && dropDay === day && dragItem
                          ? "border-[#1e6248] bg-[#d5e7d8] ring-2 ring-[#1e6248]"
                          : ""
                        } ${editMode ? "border-dashed" : ""}`}
                    >
                      <span
                        className={`text-xs font-semibold sm:text-sm ${day === today ? "text-[#1e6248]" : ""}`}
                      >
                        {new Date(`${day}T12:00:00`).getDate()}
                      </span>
                      {isDayOff(day) && (
                        <span className="mt-0.5 block text-[9px] font-bold uppercase tracking-wide text-[#52645a]">
                          Repos
                        </span>
                      )}
                      {editMode ? (
                        <span className="mt-0.5 block space-y-0.5">
                          {scheduled.slice(0, 3).map(({ course, stage }) => (
                            <span
                              key={`${course.id}-${stage.k}`}
                              draggable
                              onDragStart={(event) => {
                                event.stopPropagation();
                                event.dataTransfer.effectAllowed = "move";
                                setDragItem({
                                  courseId: course.id,
                                  stageKey: stage.k,
                                });
                              }}
                              onDragEnd={() => {
                                setDragItem(null);
                                setDropDay(null);
                              }}
                              title={`${course.title} · ${stage.k} — glisser vers un autre jour`}
                              className={`block cursor-grab truncate rounded px-1 text-[9px] font-semibold active:cursor-grabbing sm:text-[10px] ${stage.k === "J0"
                                  ? "bg-emerald-100 text-emerald-800"
                                  : "bg-blue-100 text-blue-800"
                                }`}
                            >
                              {stage.k} {course.title}
                            </span>
                          ))}
                          {scheduled.length > 3 && (
                            <span className="block text-[9px] muted">
                              + {scheduled.length - 3}…
                            </span>
                          )}
                        </span>
                      ) : (
                        <>
                          {newCourses.length > 0 && (
                            <span className="mt-1 block truncate text-[9px] font-semibold text-emerald-700 sm:text-[11px]">
                              {newCourses.length} nouveau(x)
                            </span>
                          )}

                          {revisions.length > 0 && (
                            <span className="block truncate text-[9px] font-semibold text-blue-700 sm:text-[11px]">
                              {revisions.length} révision(s)
                            </span>
                          )}
                          {scheduled.length === 0 && (
                            <span className="mt-1 hidden text-[10px] text-[#91a097] sm:block">
                              —
                            </span>
                          )}
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="mt-3 text-xs muted">
                Sélectionne une date pour afficher ses révisions. Les cases
                cochées restent visibles dans le détail du jour.
              </p>
              {editMode && (
                <p className="mt-2 rounded-xl bg-[#fef3c7] px-3 py-2 text-xs text-[#92400e]">
                  Mode édition actif : glisse un cours ou une révision (depuis
                  le calendrier ou le panneau de droite) vers n'importe quel
                  jour pour écraser la date calculée. Les cases cochées ne
                  bougent pas. « Annuler le dernier déplacement » défait
                  uniquement ton dernier glisser-déposer — les déplacements
                  précédents et les reports de jours malades sont conservés.
                </p>
              )}
            </section>

            <section className="panel min-w-0 p-4 sm:p-5">
              <div className="mb-4">
                <h2 className="text-lg font-bold">Programme du jour</h2>
                <p className="text-sm capitalize muted">
                  {fmtLong(selectedDate)}
                </p>
              </div>

              {selectedDayItems.length > 0 && (
                <div className="space-y-5">
                  {/* Nouveaux cours */}
                  {selectedDayItems.some(({ stage }) => stage.k === "J0") && (
                    <section>
                      <h3 className="mb-2 font-semibold text-emerald-700">
                        Nouveaux cours
                        <span className="ml-2 text-xs">
                          ({selectedDayItems.filter(({ stage }) => stage.k === "J0").length})
                        </span>
                      </h3>

                      {selectedDayItems
                        .filter(({ stage }) => stage.k === "J0")
                        .map(({ course, stage }) => (
                          <label
                            key={`${course.id}-${stage.k}`}
                            draggable={editMode}
                            onDragStart={(event) => {
                              event.dataTransfer.effectAllowed = "move";
                              setDragItem({
                                courseId: course.id,
                                stageKey: stage.k,
                              });
                            }}
                            onDragEnd={() => {
                              setDragItem(null);
                              setDropDay(null);
                            }}
                            className={`flex items-center justify-between gap-3 border-b py-3 ${editMode
                                ? "cursor-grab active:cursor-grabbing"
                                : "cursor-pointer"
                              }`}
                          >
                            {editMode && (
                              <GripVertical
                                size={14}
                                className="shrink-0 text-[#91a097]"
                              />
                            )}
                            <span className="min-w-0">
                              <span className="flex items-center gap-2">
                                {course.difficulty && (
                                  <span
                                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                                    style={{
                                      background: difficultyMeta[course.difficulty].color,
                                    }}
                                    title={`Mémorisation : ${difficultyMeta[course.difficulty].label}`}
                                  />
                                )}
                                <span className="block truncate font-medium">
                                  {course.title}
                                </span>
                              </span>
                              <span className="text-xs muted">{course.system} · J0</span>
                            </span>
                            <input
                              type="checkbox"
                              className="check"
                              checked={!!course.checks[stage.k]}
                              onChange={() => toggle(course.id, stage.k)}
                            />
                          </label>
                        ))}
                    </section>
                  )}


                  {/* Révisions */}
                  {selectedDayItems.some(({ stage }) => stage.k !== "J0") && (
                    <section>
                      <h3 className="mb-2 font-semibold text-blue-700">
                        Révisions
                        <span className="ml-2 text-xs">
                          ({selectedDayItems.filter(({ stage }) => stage.k !== "J0").length})
                        </span>
                      </h3>

                      {selectedDayItems
                        .filter(({ stage }) => stage.k !== "J0")
                        .map(({ course, stage }) => (
                          <label
                            key={`${course.id}-${stage.k}`}
                            draggable={editMode}
                            onDragStart={(event) => {
                              event.dataTransfer.effectAllowed = "move";
                              setDragItem({
                                courseId: course.id,
                                stageKey: stage.k,
                              });
                            }}
                            onDragEnd={() => {
                              setDragItem(null);
                              setDropDay(null);
                            }}
                            className={`flex items-center justify-between gap-3 border-b py-3 ${editMode
                                ? "cursor-grab active:cursor-grabbing"
                                : "cursor-pointer"
                              }`}
                          >
                            {editMode && (
                              <GripVertical
                                size={14}
                                className="shrink-0 text-[#91a097]"
                              />
                            )}
                            <span className="min-w-0">
                              <span className="flex items-center gap-2">
                                {course.difficulty && (
                                  <span
                                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                                    style={{
                                      background: difficultyMeta[course.difficulty].color,
                                    }}
                                    title={`Mémorisation : ${difficultyMeta[course.difficulty].label}`}
                                  />
                                )}
                                <span className="block truncate font-medium">
                                  {course.title}
                                </span>
                              </span>
                              <span className="text-xs muted">
                                {course.system} · {stage.k}
                              </span>
                            </span>
                            <input
                              type="checkbox"
                              className="check"
                              checked={!!course.checks[stage.k]}
                              onChange={() => toggle(course.id, stage.k)}
                            />
                          </label>
                        ))}
                    </section>
                  )}

                </div>
              )}



              {selectedDayItems.length > 0 && (
                <div className="mt-4 rounded-xl bg-[#f7f9f7] p-3 text-sm">
                  {
                    selectedDayItems.filter(
                      ({ course, stage }) => course.checks[stage.k],
                    ).length
                  }{" "}
                  sur {selectedDayItems.length} terminées
                </div>
              )}

              {selectedDayItems.length > 0 && (
                <div className="mt-4 border-t border-[#edf0ed] pt-4">
                  <button
                    onClick={() => spreadSickDay(selectedDate)}
                    className="field flex items-center gap-2 text-sm text-rose-700"
                  >
                    <CalendarX size={16} />
                    Reporter cette journée (maladie)
                  </button>
                  <p className="mt-2 text-xs muted">
                    Les nouveaux cours seront déplacés vers un jour sans
                    nouveau cours. Chaque révision sera replacée avant son
                    étape suivante (J1 avant J3, J3 avant J7…) et étalée sur
                    les jours les moins chargés.
                  </p>
                </div>
              )}

              <div className="mt-4 border-t border-[#edf0ed] pt-4">
                <button
                  onClick={() => toggleDayOff(selectedDate)}
                  className={`field flex items-center gap-2 text-sm ${isDayOff(selectedDate) ? "text-[#205e45]" : "text-[#52645a]"}`}
                  aria-pressed={isDayOff(selectedDate)}
                >
                  <CalendarX size={16} />
                  {isDayOff(selectedDate)
                    ? "Réactiver ce jour (retirer le repos)"
                    : "Marquer ce jour comme repos"}
                </button>
                <p className="mt-2 text-xs muted">
                  Les jours de repos sont ignorés par le report automatique (« Je
                  suis malade ») et les dates calculées (J1, J3, J7…) glissent
                  au jour suivant si elles tombent dessus. Le glisser-déposer
                  manuel reste possible si tu veux y placer un cours toi-même.
                </p>
              </div>

              <div className="mt-5 border-t border-[#edf0ed] pt-4">
                <h3 className="font-semibold">
                  Un cours a été étudié à cette date ?
                </h3>
                <p className="mt-1 text-sm muted">
                  Choisis un cours pas encore commencé pour créer son J0 ici et
                  calculer les révisions suivantes depuis cette date. Si la
                  date est passée, J0 sera marqué comme terminé.
                </p>
                {unstarted.length > 0 ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <select
                      className="field min-w-0 flex-1"
                      value={calendarCourseId}
                      onChange={(event) =>
                        setCalendarCourseId(event.target.value)
                      }
                    >
                      <option value="">Choisir un cours</option>
                      {unstarted.map((course) => (
                        <option key={course.id} value={course.id}>
                          {course.title}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => {
                        startCourse(calendarCourseId, selectedDate);
                        setCalendarCourseId("");
                      }}
                      disabled={!calendarCourseId}
                      className="rounded-lg bg-[#1e6248] px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Planifier depuis cette date
                    </button>
                  </div>
                ) : (
                  <p className="mt-3 text-sm muted">
                    Tous les cours ont déjà une date d’étude.
                  </p>
                )}

              </div>
            </section>
          </div>
        )}

        

        {tab === "revise" && (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
            {/* ---------------- Left: library ---------------- */}
            <section className="panel p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-bold">Cours de révision</h2>
                <div className="flex flex-wrap gap-2">
                  <label className="field flex cursor-pointer items-center gap-2 text-sm">
                    <Upload size={15} />
                    Dossier
                    <input
                      type="file"
                      hidden
                      {...({ webkitdirectory: "true" } as Record<string, string>)}
                      onChange={(event) => {
                        handleRevisionUpload(event.target.files);
                        event.target.value = "";
                      }}
                    />
                  </label>
                  <label className="field flex cursor-pointer items-center gap-2 text-sm">
                    <Plus size={15} />
                    Fichiers
                    <input
                      type="file"
                      hidden
                      multiple
                      accept=".docx,.txt,.md"
                      onChange={(event) => {
                        handleRevisionUpload(event.target.files);
                        event.target.value = "";
                      }}
                    />
                  </label>
                </div>
              </div>
              <p className="mt-2 text-xs muted">
                Chaque cours est réduit à ses titres. Pendant le quiz, un titre
                s'affiche avec un compte à rebours ; le contenu n'apparaît
                qu'après ton évaluation.
              </p>
              {revCourses.length === 0 ? (
                <p className="mt-4 rounded-xl bg-[#f7f9f7] p-4 text-sm muted">
                  Aucun cours. Importe un dossier entier (sous-dossiers
                  compris) ou des fichiers .docx / .txt / .md.
                </p>
              ) : (
                <div className="mt-3">
                  <CourseTree
                    node={revTree}
                    onStart={(id) => {
                      setSelectedRevCourseId(id);
                      setRevView("setup");
                    }}
                    onPreview={(id) => {
                      setSelectedRevCourseId(id);
                      setRevView("preview");
                    }}
                    onEdit={(id) => {
                      setSelectedRevCourseId(id);
                      setRevView("edit");
                    }}
                    onDelete={deleteRevCourse}
                  />
                </div>
              )}
            </section>

            {/* ---------------- Right: setup / preview / edit / quiz ---------------- */}
            <section className="panel min-w-0 p-4 sm:p-5">
              {!selectedRevCourse && !quiz ? (
                <div className="flex min-h-[220px] flex-col items-center justify-center text-center text-sm muted">
                  <Brain size={32} className="mb-2 text-[#1e6248]" />
                  Sélectionne un cours à gauche : ▶ réviser, 👁 aperçu style
                  Word, ✎ modifier les questions.
                </div>
              ) : quiz && quizCourse ? (
                finished ? (
                  /* ---------- End summary: full course, highlighted & editable ---------- */
                  <div>
                    <h2 className="text-lg font-bold">
                      Session terminée 🎉 · {quizCourse.title}
                    </h2>
                    <div className="mt-3 grid grid-cols-3 gap-3 text-center">
                      {[
                        {
                          label: "Faciles du 1er coup",
                          value: easyFirstTry,
                          color: "#166534",
                        },
                        {
                          label: "Rappels réussis",
                          value: recalledCount,
                          color: "#205e45",
                        },
                        {
                          label: "À retravailler",
                          value: toReview.length,
                          color: "#991b1b",
                        },
                      ].map((item) => (
                        <div
                          key={item.label}
                          className="rounded-xl bg-[#f7f9f7] p-3"
                        >
                          <div
                            className="text-2xl font-bold"
                            style={{ color: item.color }}
                          >
                            {item.value}
                          </div>
                          <div className="mt-1 text-[11px] muted">
                            {item.label}
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="mt-4 max-h-[46vh] overflow-y-auto rounded-xl border border-[#edf0ed] bg-white p-4">
                      <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-[#52645a]">
                        Récapitulatif du cours (modifiable)
                      </div>
                      {quizCourse.sections.map((section) => {
                        const stats = sectionStats(section);
                        const wasHard =
                          quiz.gradedNow[section.id] &&
                          stats.last === "hard" &&
                          !quiz.recalled[section.id];
                        const inTime =
                          quiz.gradedNow[section.id] &&
                          stats.last !== "hard" &&
                          stats.lastTime <= quiz.secondsPerSection;
                        return (
                          <div
                            key={section.id}
                            className={`mb-2 rounded-lg border-l-4 p-2 ${wasHard
                                ? "border-[#dc2626] bg-[#fee2e2]"
                                : inTime
                                  ? "border-[#16a34a] bg-[#f0fdf4]"
                                  : "border-[#e7eee8]"
                              }`}
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <input
                                className="field min-w-0 flex-1 text-sm font-semibold"
                                value={section.heading}
                                onChange={(event) =>
                                  updateRevSection(quiz.courseId, section.id, {
                                    heading: event.target.value,
                                  })
                                }
                              />
                              {stats.attempts > 0 && (
                                <span className="flex shrink-0 gap-1 text-[10px]">
                                  <span
                                    className={`rounded-full px-2 py-0.5 font-bold ${stats.last === "hard"
                                        ? "bg-[#fecaca] text-[#991b1b]"
                                        : "bg-[#bbf7d0] text-[#166534]"
                                      }`}
                                  >
                                    {stats.last === "hard" ? "difficile" : "facile"}
                                  </span>
                                  <span className="rounded-full bg-[#e2e8f0] px-2 py-0.5 font-semibold text-[#475569]">
                                    {stats.attempts}× · moy {Math.round(stats.avgTime)}s
                                  </span>
                                  {quiz.recalled[section.id] && (
                                    <span className="rounded-full bg-[#dbeafe] px-2 py-0.5 font-semibold text-[#1d4ed8]">
                                      rappel ✓
                                    </span>
                                  )}
                                </span>
                              )}
                            </div>
                            {section.content && (
                              <textarea
                                className="field mt-1.5 w-full resize-y text-sm"
                                rows={Math.min(5, section.content.split("\n").length + 1)}
                                value={section.content}
                                onChange={(event) =>
                                  updateRevSection(quiz.courseId, section.id, {
                                    content: event.target.value,
                                  })
                                }
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>

                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        onClick={() =>
                          startQuiz(quiz.courseId, quiz.secondsPerSection)
                        }
                        className="rounded-xl bg-[#1e6248] px-4 py-2 text-sm font-semibold text-white"
                      >
                        Recommencer
                      </button>
                      <button
                        onClick={() => setQuiz(null)}
                        className="field text-sm"
                      >
                        Choisir un autre cours
                      </button>
                    </div>
                  </div>
                ) : waiting ? (
                  /* ---------- Waiting for hard recalls ---------- */
                  <div className="py-10 text-center">
                    <Brain size={32} className="mx-auto mb-3 text-[#1e6248]" />
                    <p className="text-lg font-bold">Pause de consolidation</p>
                    <p className="mt-2 text-sm muted">
                      {pendingCount} section(s) difficile(s) à revoir — prochain
                      rappel dans{" "}
                      <b className="tabular-nums">
                        {Math.floor(nextRecallIn / 60)}:
                        {String(Math.floor(nextRecallIn % 60)).padStart(2, "0")}
                      </b>
                      .
                    </p>
                    <p className="mt-1 text-xs muted">
                      Le quiz reprendra automatiquement quand le délai est écoulé.
                    </p>
                  </div>
                ) : currentSection ? (
                  /* ---------- Quiz card ---------- */
                  <div>
                    {/* Navigation chips: one per question */}
                    <div className="flex max-h-20 flex-wrap gap-1 overflow-y-auto">
                      {quiz.order.map((id, index) => {
                        const stats = sectionStats(
                          quizSectionMap.get(id) ?? {
                            id,
                            heading: "",
                            level: 1,
                            content: "",
                          },
                        );
                        const done = quiz.gradedNow[id];
                        return (
                          <button
                            key={`${id}-${index}`}
                            onClick={() => moveTo(index)}
                            title={quizSectionMap.get(id)?.heading}
                            className={`h-7 w-7 rounded-md text-[11px] font-bold tabular-nums transition ${index === quiz.cursor
                                ? "ring-2 ring-[#1e6248] ring-offset-1"
                                : ""
                              } ${done
                                ? stats.last === "hard"
                                  ? "bg-[#fee2e2] text-[#991b1b]"
                                  : "bg-[#dcfce7] text-[#166534]"
                                : "bg-[#e7eee8] text-[#52645a] hover:bg-[#d6ddd8]"
                              }`}
                          >
                            {index + 1}
                          </button>
                        );
                      })}
                    </div>

                    <div className="mt-3 flex items-center justify-between gap-2 text-xs muted">
                      <span className="truncate">{quizCourse.title}</span>
                      <span className="tabular-nums">
                        {Math.min(gradedCount, quizzableCount)} / {quizzableCount}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[#e7eee8]">
                      <div
                        className="h-full rounded-full bg-[#1e6248] transition-all"
                        style={{
                          width: `${(gradedCount / Math.max(1, quizzableCount)) * 100}%`,
                        }}
                      />
                    </div>

                    {parents.length > 0 && (
                      <p className="mt-3 text-xs font-semibold text-[#205e45]">
                        {parents.map((section) => section.heading).join("  →  ")}
                      </p>
                    )}
                    <h3 className="mt-2 text-xl font-bold leading-snug">
                      {currentSection.heading}
                    </h3>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="pill">Niveau {currentSection.level}</span>
                      {sectionStats(currentSection).attempts > 0 && (
                        <span className="text-[11px] muted">
                          déjà tentée {sectionStats(currentSection).attempts}× ·
                          moy {Math.round(sectionStats(currentSection).avgTime)}s
                        </span>
                      )}
                    </div>

                    <div className="mt-4 flex items-center gap-3">
                      <span
                        className={`text-3xl font-bold tabular-nums ${secondsLeft <= 5 && !revealed
                            ? "text-rose-600"
                            : "text-[#18382c]"
                          }`}
                      >
                        {revealed ? "—" : `${secondsLeft}s`}
                      </span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-[#e7eee8]">
                        <div
                          className="h-full rounded-full bg-[#1e6248] transition-all"
                          style={{
                            width: revealed
                              ? "0%"
                              : `${(secondsLeft / quiz.secondsPerSection) * 100}%`,
                          }}
                        />
                      </div>
                    </div>

                    {revealed ? (
                      <div className="mt-4 max-h-80 overflow-y-auto rounded-xl border border-[#edf0ed] bg-[#f7f9f7] p-3">
                        <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-[#52645a]">
                          Réponse
                        </div>
                        <div style={wordBodyStyle}>
                          {renderInline(
                            currentSection.content ||
                            "Pas de contenu sous ce titre.",
                          )}
                        </div>
                      </div>
                    ) : (
                      <p className="mt-4 rounded-xl bg-[#f7f9f7] p-3 text-sm muted">
                        Récite mentalement tout ce que tu sais sur cette
                        section…
                      </p>
                    )}

                    {lastGrade ? (
                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-bold ${lastGrade === "easy"
                              ? "bg-[#dcfce7] text-[#166534]"
                              : "bg-[#fee2e2] text-[#991b1b]"
                            }`}
                        >
                          {lastGrade === "easy"
                            ? "Facile ✓"
                            : `Difficile — rappel dans ${RECALL_MINUTES} min`}
                        </span>
                        <div className="ml-auto flex gap-2">
                          <button
                            onClick={goBack}
                            disabled={quiz.cursor === 0}
                            className="field text-sm disabled:opacity-40"
                          >
                            ← Précédent
                          </button>
                          <button
                            onClick={advance}
                            className="rounded-xl bg-[#1e6248] px-5 py-2 text-sm font-semibold text-white"
                          >
                            Suivant →
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {!revealed && (
                          <button
                            className="field text-sm"
                            onClick={() => setRevealed(true)}
                          >
                            Voir la réponse
                          </button>
                        )}
                        <button
                          onClick={() => grade("hard")}
                          className="rounded-lg bg-[#fee2e2] px-4 py-2 text-sm font-semibold text-[#991b1b]"
                        >
                          Difficile
                        </button>
                        <button
                          onClick={() => grade("easy")}
                          className="rounded-lg bg-[#dcfce7] px-4 py-2 text-sm font-semibold text-[#166534]"
                        >
                          Facile
                        </button>
                        <button
                          onClick={skipSection}
                          className="field ml-auto text-sm text-rose-700"
                        >
                          Passer
                        </button>
                        <button
                          onClick={goBack}
                          disabled={quiz.cursor === 0}
                          className="field text-sm disabled:opacity-40"
                        >
                          ← Précédent
                        </button>
                      </div>
                    )}
                  </div>
                ) : null
              ) : revView === "preview" && selectedRevCourse ? (
                /* ---------- Word-style preview ---------- */
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-lg font-bold">
                      Aperçu : {selectedRevCourse.title}
                    </h2>
                    <div className="flex items-center gap-2">
                      <select
                        className="field text-sm"
                        value={selectedRevCourse.tag ?? ""}
                        onChange={(event) =>
                          setRevTag(
                            selectedRevCourse.id,
                            (event.target.value || undefined) as
                              | "easy"
                              | "medium"
                              | "hard"
                              | undefined,
                          )
                        }
                        aria-label="Tag du cours"
                      >
                        <option value="">Sans tag</option>
                        {(Object.keys(difficultyMeta) as Difficulty[]).map(
                          (level) => (
                            <option key={level} value={level}>
                              {difficultyMeta[level].label}
                            </option>
                          ),
                        )}
                      </select>
                      <button
                        className="field text-sm"
                        onClick={() => setRevView("edit")}
                      >
                        <PencilLine size={14} className="mr-1 inline" />
                        Modifier
                      </button>
                    </div>
                  </div>
                  <p className="mt-1 text-xs muted">
                    Décoche les sections à exclure du quiz. Style proche du
                    document Word d'origine.
                  </p>
                  <article
                    className="mt-3 max-h-[62vh] overflow-y-auto rounded-xl border border-[#edf0ed] bg-white p-5 shadow-sm"
                    style={{ fontFamily: "Calibri, 'Segoe UI', sans-serif" }}
                  >
                    {selectedRevCourse.sections.map((section) => {
                      const stats = sectionStats(section);
                      return (
                        <div
                          key={section.id}
                          className={
                            section.selected === false ? "opacity-45" : ""
                          }
                        >
                          <div
                            style={wordHeadingStyle(section.level)}
                            className="flex items-center gap-2"
                          >
                            <input
                              type="checkbox"
                              className="check shrink-0"
                              checked={section.selected !== false}
                              onChange={(event) =>
                                updateRevSection(
                                  selectedRevCourse.id,
                                  section.id,
                                  { selected: event.target.checked },
                                )
                              }
                              aria-label={`Inclure ${section.heading}`}
                            />
                            <span>{section.heading}</span>
                            {stats.attempts > 0 && (
                              <span
                                className={`rounded-full px-2 py-0.5 text-[9px] font-bold ${stats.last === "hard"
                                    ? "bg-[#fee2e2] text-[#991b1b]"
                                    : "bg-[#dcfce7] text-[#166534]"
                                  }`}
                              >
                                {stats.last === "hard" ? "difficile" : "facile"}{" "}
                                · {stats.attempts}× · {Math.round(stats.avgTime)}s
                              </span>
                            )}
                          </div>
                          {section.content && (
                            <div style={wordBodyStyle}>
                              {renderInline(section.content)}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </article>
                </div>
              ) : revView === "edit" && selectedRevCourse ? (
                /* ---------- Question editor ---------- */
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-lg font-bold">
                      Modifier : {selectedRevCourse.title}
                    </h2>
                    <div className="flex gap-2">
                      <button
                        className="field text-sm"
                        onClick={() => setRevView("preview")}
                      >
                        <Eye size={14} className="mr-1 inline" />
                        Aperçu
                      </button>
                      <button
                        className="field text-sm"
                        onClick={() => setRevView("setup")}
                      >
                        <Play size={14} className="mr-1 inline" />
                        Réviser
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 max-h-[62vh] space-y-3 overflow-y-auto pr-1">
                    {selectedRevCourse.sections.map((section) => (
                      <div
                        key={section.id}
                        className="rounded-xl border border-[#edf0ed] p-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="checkbox"
                            className="check"
                            checked={section.selected !== false}
                            onChange={(event) =>
                              updateRevSection(
                                selectedRevCourse.id,
                                section.id,
                                { selected: event.target.checked },
                              )
                            }
                            title="Inclure dans le quiz"
                          />
                          <select
                            className="field w-24 text-xs"
                            value={section.level}
                            onChange={(event) =>
                              updateRevSection(
                                selectedRevCourse.id,
                                section.id,
                                { level: Number(event.target.value) },
                              )
                            }
                            aria-label="Niveau du titre"
                          >
                            {[1, 2, 3, 4, 5, 6].map((level) => (
                              <option key={level} value={level}>
                                Niveau {level}
                              </option>
                            ))}
                          </select>
                          <input
                            className="field min-w-0 flex-1 text-sm font-semibold"
                            value={section.heading}
                            onChange={(event) =>
                              updateRevSection(
                                selectedRevCourse.id,
                                section.id,
                                { heading: event.target.value },
                              )
                            }
                          />
                          <button
                            onClick={() =>
                              deleteRevSection(
                                selectedRevCourse.id,
                                section.id,
                              )
                            }
                            className="text-red-400"
                            aria-label="Supprimer la section"
                            title="Supprimer la section"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                        <textarea
                          className="field mt-2 w-full resize-y text-sm"
                          rows={Math.min(
                            6,
                            section.content.split("\n").length + 1,
                          )}
                          value={section.content}
                          placeholder="Contenu de la section (la réponse)…"
                          onChange={(event) =>
                            updateRevSection(selectedRevCourse.id, section.id, {
                              content: event.target.value,
                            })
                          }
                        />
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={() => addRevSection(selectedRevCourse.id)}
                    className="mt-3 flex items-center gap-2 rounded-xl border border-dashed border-[#9fb3a7] px-4 py-2 text-sm font-semibold text-[#205e45]"
                  >
                    <Plus size={15} />
                    Ajouter une section
                  </button>
                </div>
              ) : selectedRevCourse ? (
                /* ---------- Setup ---------- */
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-lg font-bold">
                      Réviser : {selectedRevCourse.title}
                    </h2>
                    <div className="flex items-center gap-2">
                      <select
                        className="field text-sm"
                        value={selectedRevCourse.tag ?? ""}
                        onChange={(event) =>
                          setRevTag(
                            selectedRevCourse.id,
                            (event.target.value || undefined) as
                              | "easy"
                              | "medium"
                              | "hard"
                              | undefined,
                          )
                        }
                        aria-label="Tag du cours"
                      >
                        <option value="">Sans tag</option>
                        {(Object.keys(difficultyMeta) as Difficulty[]).map(
                          (level) => (
                            <option key={level} value={level}>
                              {difficultyMeta[level].label}
                            </option>
                          ),
                        )}
                      </select>
                      <button
                        className="field text-sm"
                        onClick={() => setRevView("preview")}
                      >
                        <Eye size={14} className="mr-1 inline" />
                        Aperçu
                      </button>
                      <button
                        className="field text-sm"
                        onClick={() => setRevView("edit")}
                      >
                        <PencilLine size={14} className="mr-1 inline" />
                        Modifier
                      </button>
                    </div>
                  </div>
                  {(() => {
                    const stats = courseStats(selectedRevCourse);
                    const quizzable = selectedRevCourse.sections.filter(
                      (section) =>
                        section.selected !== false &&
                        section.content.trim().length > 0,
                    ).length;
                    return (
                      <p className="mt-1 text-sm muted">
                        {selectedRevCourse.sections.length} titres · {quizzable}{" "}
                        inclus au quiz
                        {stats.attempted > 0 &&
                          ` · ${stats.attempted} vues · ${stats.easy} faciles / ${stats.hard} difficiles · moy ${Math.round(stats.avgTime)}s`}
                      </p>
                    );
                  })()}
                  <div className="mt-4 flex flex-wrap items-end gap-3">
                    <label className="grid gap-1 text-sm">
                      <span className="font-medium">Temps par section</span>
                      <select
                        className="field"
                        value={revSeconds}
                        onChange={(event) =>
                          setRevSeconds(Number(event.target.value))
                        }
                      >
                        {[15, 30, 45, 60, 90].map((seconds) => (
                          <option key={seconds} value={seconds}>
                            {seconds} secondes
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      onClick={() =>
                        startQuiz(selectedRevCourse.id, revSeconds)
                      }
                      className="rounded-xl bg-[#1e6248] px-4 py-2 text-sm font-semibold text-white"
                    >
                      Commencer la révision
                    </button>
                  </div>
                  <div className="mt-4 rounded-xl bg-[#f7f9f7] p-3 text-xs leading-5 muted">
                    Déroulé : chaque titre inclus apparaît une fois (ordre
                    aléatoire) → tu récites pendant le compte à rebours →
                    Facile / Difficile → la réponse s'affiche → Suivant. Les
                    sections difficiles réapparaissent après {RECALL_MINUTES}{" "}
                    minutes. Utilise les puces numérotées ou ← → pour naviguer
                    librement.
                  </div>
                </div>
              ) : null}
            </section>
          </div>
        )}

        <footer className="py-8 text-center text-xs muted">
          Interna Study Planner · Données enregistrées automatiquement sur
          cet appareil.
        </footer>
      </main>
    </div>
  );
}
