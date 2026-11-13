import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  LayoutDashboard,
  Plus,
  RotateCcw,
  Search,
  Stethoscope,
  Trash2,
  Upload,
} from "lucide-react";
import seed from "./courses.json";

type Course = {
  id: string;
  title: string;
  sourceSection: string;
  system: string;
  addedAt: string;
  checks: Record<string, boolean>;
  custom?: boolean;
};

const stages = [
  { k: "J0", d: 0 },
  { k: "J1", d: 1 },
  { k: "J3", d: 3 },
  { k: "J7", d: 7 },
  { k: "J15", d: 15 },
  { k: "J30", d: 30 },
] as const;

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

const scheduledForDate = (courses: Course[], date: string) =>
  courses.flatMap((course) =>
    course.addedAt
      ? stages
          .filter((stage) => plus(course.addedAt, stage.d) === date)
          .map((stage) => ({ course, stage }))
      : [],
  );


export default function App() {
  const [items, setItems] = useState<Course[]>(() => {
    try {
      const saved = localStorage.getItem("interna-courses");
      if (!saved) return initial;
      const parsed: unknown = JSON.parse(saved);
      if (!Array.isArray(parsed)) return initial;
      return parsed.map((entry) => {
        const course = entry as Partial<Course>;
        return {
          ...course,
          addedAt: typeof course.addedAt === "string" ? course.addedAt : "",
          checks:
            course.checks && typeof course.checks === "object"
              ? course.checks
              : {},
        } as Course;
      });
    } catch {
      return initial;
    }
  });

  const [tab, setTab] = useState("today");
  const [query, setQuery] = useState("");
  const [system, setSystem] = useState("Tous les systèmes");
  const [section, setSection] = useState("Tous les parcours");
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newSystem, setNewSystem] = useState("Anatomie générale / Régions");
  const [newSection, setNewSection] = useState("Anatomie — Admissibilité");
  const [notice, setNotice] = useState("");
  const [dailyStartLimit, setDailyStartLimit] = useState<number | null>(() => {
    try {
      const saved = localStorage.getItem("interna-start-limit");
      if (!saved || saved === "unlimited") return null;
      const limit = Number(saved);
      return Number.isInteger(limit) && limit > 0 ? limit : null;
    } catch {
      return null;
    }
  });
  const [startDateDrafts, setStartDateDrafts] = useState<
    Record<string, string>
  >({});
  const [calendarCourseId, setCalendarCourseId] = useState("");
  const [selectedDate, setSelectedDate] = useState(todayISO);
  const [visibleMonth, setVisibleMonth] = useState(() =>
    todayISO().slice(0, 7),
  );

  useEffect(() => {
    localStorage.setItem("interna-courses", JSON.stringify(items));
  }, [items]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "interna-start-limit",
        dailyStartLimit === null ? "unlimited" : String(dailyStartLimit),
      );
    } catch {
      return;
    }
  }, [dailyStartLimit]);

  const today = todayISO();
  const startedToday = items.filter((course) => course.addedAt === today && course.checks.J0 ).length;
  const reachedDailyLimit =
    dailyStartLimit !== null && startedToday >= dailyStartLimit;
  const unstarted = items.filter((course) => !course.addedAt);

  const outstanding = items.flatMap((course) =>
    course.addedAt
      ? stages
          .map((stage) => ({
            course,
            stage,
            date: plus(course.addedAt, stage.d),
          }))
          .filter(
            (entry) => entry.date <= today && !course.checks[entry.stage.k],
          )
      : [],
  );
  const overdue = outstanding.filter((entry) => entry.date < today);
  const dueToday = outstanding.filter((entry) => entry.date === today);

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
    }))
  );

  setStartDateDrafts({});
  setCalendarCourseId("");
  setDailyStartLimit(null);

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
          ? { ...course, addedAt: "", checks: {} }
          : course
      )
    );

    setNotice("Le cours est revenu dans la bibliothèque.");
  };

  const importData = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported: unknown = JSON.parse(String(reader.result));
        if (Array.isArray(imported)) {
          setItems(
            imported.map((entry) => {
              const course = entry as Partial<Course>;
              return {
                ...course,
                addedAt:
                  typeof course.addedAt === "string" ? course.addedAt : "",
                checks:
                  course.checks && typeof course.checks === "object"
                    ? course.checks
                    : {},
              } as Course;
            }),
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
    if (startDate === today && reachedDailyLimit) {
      setNotice(
        "La limite quotidienne est atteinte. Augmente-la ou choisis une date d’étude antérieure.",
      );
      return;
    }
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
    const canStartToday = !reachedDailyLimit;
    const newCourse: Course = {
      id: crypto.randomUUID(),
      title: newTitle.trim(),
      system: newSystem,
      sourceSection: newSection,
      addedAt: canStartToday ? today : "",
      checks: {},
      custom: true,
    };
    setItems((current) => [newCourse, ...current]);
    setNewTitle("");
    setShowAdd(false);
    setNotice(
      canStartToday
        ? "Cours ajouté et commencé · J0 est prévu aujourd’hui."
        : "Cours ajouté à la bibliothèque. Il pourra être commencé un autre jour.",
    );
  };

  const firstOfMonth = `${visibleMonth}-01`;
  const firstWeekday = new Date(`${firstOfMonth}T12:00:00`).getDay();
  const calendarStart = plus(firstOfMonth, -((firstWeekday + 6) % 7));
  const calendarDays = Array.from({ length: 42 }, (_, index) =>
    plus(calendarStart, index),
  );
  const selectedDayItems = scheduledForDate(items, selectedDate);
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

        <nav className="flex gap-1 overflow-x-auto lg:flex-col">
          {[
            { key: "today", label: "Aujourd’hui", Icon: LayoutDashboard },
            { key: "courses", label: "Mes cours", Icon: BookOpen },
            { key: "calendar", label: "Calendrier", Icon: CalendarDays },
          ].map(({ key, label, Icon }) => (
            <button
              key={key}
              className={`navbtn shrink-0 ${tab === key ? "active" : ""}`}
              onClick={() => setTab(key)}
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
          <div>
            <div className="text-sm muted">Bonjour — garde le rythme</div>
            <h1 className="text-2xl font-bold text-[#18382c] md:text-3xl">
              {tab === "today"
                ? "Vue d’ensemble"
                : tab === "courses"
                  ? "Bibliothèque des cours"
                  : "Calendrier de révision"}
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



        <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
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
            `${overdue.length} en retard · ${dueToday.length} aujourd'hui`
          )}
        </div>
        

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
            <section className="panel mb-5 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold">Charge du jour</h2>
                  <p className="text-sm muted">{fmtLong(today)}</p>
                </div>
                <span className="pill">
                  {outstanding.length} révisions à faire
                </span>
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
                    { title: "En retard", entries: overdue },
                    { title: "À faire aujourd’hui", entries: dueToday },
                  ].map(({ title, entries }) => (
                    <section key={title}>
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <h3 className="font-semibold">{title}</h3>
                        <span className="pill">{entries.length}</span>
                      </div>
                      {entries.length === 0 ? (
                        <p className="rounded-xl bg-[#f7f9f7] p-4 text-sm muted">
                          Aucune révision dans cette catégorie.
                        </p>
                      ) : (
                        <div className="divide-y">
                          {entries.map(({ course, stage, date }) => (
                            <label
                              key={`${course.id}-${stage.k}`}
                              className="flex cursor-pointer items-center justify-between gap-3 py-3"
                            >
                              <span className="min-w-0">
                                <span className="block truncate font-medium">
                                  {course.title}
                                </span>
                                <span className="text-xs muted">
                                  {course.system} · {stage.k} · {fmt(date)}
                                </span>
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

            <section className="panel mb-5 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold">
                    Démarrage des cours
                  </h2>
                  <p className="text-sm muted">
                    Choisis combien de nouveaux cours tu souhaites démarrer par jour.
                  </p>
                </div>
                <span className="pill">
                  {dailyStartLimit === null
                    ? `${startedToday} commencés · sans limite`
                    : `${startedToday} / ${dailyStartLimit} aujourd’hui`}
                </span>
              </div>
              <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
                <label className="grid gap-1 text-sm">
                  <span className="font-medium">Maximum par jour</span>
                  <input
                    className="field w-40"
                    type="number"
                    min="1"
                    step="1"
                    placeholder="Sans limite"
                    value={dailyStartLimit ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (!value) {
                        setDailyStartLimit(null);
                        return;
                      }
                      const limit = Number.parseInt(value, 10);
                      if (Number.isFinite(limit)) {
                        setDailyStartLimit(Math.max(1, limit));
                      }
                    }}
                  />
                </label>
                {dailyStartLimit !== null ? (
                  <button
                    className="field text-sm"
                    onClick={() => setDailyStartLimit(null)}
                  >
                    Retirer la limite
                  </button>
                ) : (
                  <p className="text-sm muted">
                    Aucune limite quotidienne. Saisis un nombre pour en définir une.
                  </p>
                )}
              </div>
              {dailyStartLimit !== null && (
                <div
                  className="mt-3 h-2 overflow-hidden rounded-full bg-[#e7eee8]"
                  aria-label={`${startedToday} cours commencés sur ${dailyStartLimit}`}
                >
                  <div
                    className="h-full rounded-full bg-[#1e6248] transition-all"
                    style={{
                      width: `${Math.min(
                        (startedToday / dailyStartLimit) * 100,
                        100,
                      )}%`,
                    }}
                  />
                </div>
              )}
              {reachedDailyLimit && (
                <p className="mt-2 text-xs text-amber-800">
                  Limite atteinte pour aujourd’hui. Augmente-la ou retire-la pour continuer.
                </p>
              )}

              {unstarted.length > 0 && (
                <div className="mt-4 divide-y">
                  {unstarted.slice(0, 8).map((course) => (
                    <div
                      key={course.id}
                      className="flex flex-wrap items-center justify-between gap-3 py-3"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">{course.title}</div>
                        <div className="text-xs muted">{course.system}</div>
                      </div>
                      <button
                        onClick={() => startCourse(course.id)}
                        disabled={reachedDailyLimit}
                        className="rounded-lg bg-[#e8f2eb] px-3 py-2 text-sm font-semibold text-[#205e45] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Commencer · J0
                      </button>
                    </div>
                  ))}
                  {unstarted.length > 8 && (
                    <p className="pt-3 text-xs muted">
                      + {unstarted.length - 8} cours dans la bibliothèque
                    </p>
                  )}
                </div>
              )}
              {unstarted.length === 0 && (
                <p className="mt-4 rounded-xl bg-[#f7f9f7] p-4 text-sm muted">
                  Aucun cours en attente de démarrage.
                </p>
              )}
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

            <div className="mb-3 text-sm muted">
              {filtered.length} cours affichés · coche chaque révision quand
              elle est terminée.
            </div>

            <div className="space-y-3">
              {Object.entries(
                filtered.reduce(
                  (groups, course) => {
                    (groups[course.system] ??= []).push(course);
                    return groups;
                  },
                  {} as Record<string, Course[]>,
                ),
              ).map(([systemName, courses]) => (
                <section className="panel overflow-hidden" key={systemName}>
                  <div className="flex justify-between bg-[#f0f5f0] px-4 py-3">
                    <b>{systemName}</b>
                    <span className="text-xs muted">
                      {courses.length} cours
                    </span>
                  </div>

                  {courses.map((course) => (
                    <div
                      key={course.id}
                      className="border-t border-[#edf0ed] p-4"
                    >
                      <div className="flex justify-between gap-2">
                        <div className="font-medium">{course.title}</div>
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

                      <div className="mt-1 text-xs muted">
                        {course.sourceSection}
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
                            disabled={
                              (startDateDrafts[course.id] ?? today) === today &&
                              reachedDailyLimit
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
                              const dueDate = plus(course.addedAt, stage.d);
                              const isDone = !!course.checks[stage.k];

                              return (
                                <label
                                  key={stage.k}
                                  className={`day cursor-pointer ${isDone ? "done" : ""}`}
                                >
                                  <input
                                    className="check"
                                    type="checkbox"
                                    checked={isDone}
                                    onChange={() => toggle(course.id, stage.k)}
                                  />
                                  <div className="mt-1 text-sm font-bold">
                                    {stage.k}
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
                                Les cases déjà cochées seront conservées.
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

              <div className="grid grid-cols-7 gap-1 sm:gap-2">
                {calendarDays.map((day) => {
                  const scheduled = scheduledForDate(items, day);
                  const remaining = scheduled.filter(
                    ({ course, stage }) => !course.checks[stage.k],
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
                      aria-pressed={isSelected}
                      aria-label={`${fmtLong(day)} · ${remaining} révisions restantes`}
                      className={`min-h-[66px] rounded-xl border p-1 text-left transition sm:min-h-[82px] sm:p-2 ${
                        isSelected
                          ? "border-[#1e6248] bg-[#e8f2eb] ring-1 ring-[#1e6248]"
                          : "border-[#edf0ed] bg-white hover:bg-[#f7f9f7]"
                      } ${!inMonth ? "opacity-45" : ""}`}
                    >
                      <span
                        className={`text-xs font-semibold sm:text-sm ${day === today ? "text-[#1e6248]" : ""}`}
                      >
                        {new Date(`${day}T12:00:00`).getDate()}
                      </span>
                      {scheduled.length > 0 && (
                        <span className="mt-1 block truncate text-[9px] leading-3 text-[#52645a] sm:text-[11px] sm:leading-4">
                          {remaining}/{scheduled.length} à faire
                        </span>
                      )}
                      {scheduled.length === 0 && (
                        <span className="mt-1 hidden text-[10px] text-[#91a097] sm:block">
                          —
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="mt-3 text-xs muted">
                Sélectionne une date pour afficher ses révisions. Les cases
                cochées restent visibles dans le détail du jour.
              </p>
            </section>

            <section className="panel min-w-0 p-4 sm:p-5">
              <div className="mb-4">
                <h2 className="text-lg font-bold">Révisions programmées</h2>
                <p className="text-sm capitalize muted">
                  {fmtLong(selectedDate)}
                </p>
              </div>

              {selectedDayItems.length === 0 ? (
                <div className="rounded-xl bg-[#f1f6f1] p-6 text-center">
                  <CalendarDays className="mx-auto mb-2 text-[#52645a]" />
                  <b>Aucune révision prévue</b>
                  <p className="mt-1 text-sm muted">
                    Les cours commencés apparaîtront ici selon le cycle J0 à
                    J30.
                  </p>
                </div>
              ) : (
                <div className="divide-y">
                  {selectedDayItems.map(({ course, stage }) => (
                    <label
                      key={`${course.id}-${stage.k}`}
                      className="flex cursor-pointer items-center justify-between gap-3 py-3"
                    >
                      <span className="min-w-0">
                        <span
                          className={`block truncate font-medium ${course.checks[stage.k] ? "text-[#718078] line-through" : ""}`}
                        >
                          {course.title}
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
                        aria-label={`Terminer ${stage.k} · ${course.title}`}
                      />
                    </label>
                  ))}
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
                      disabled={
                        !calendarCourseId ||
                        (selectedDate === today && reachedDailyLimit)
                      }
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

        <footer className="py-8 text-center text-xs muted">
          Interna Study Planner · Données enregistrées automatiquement sur
          cet appareil.
        </footer>
      </main>
    </div>
  );
}