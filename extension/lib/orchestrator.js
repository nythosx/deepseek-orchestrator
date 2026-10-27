// Core planner/executor orchestration state machine. See readme.md section 8/9/12.

const Orchestrator = (() => {
  const DEFAULT_MIGRATION_THRESHOLD = 40;
  // Conservative estimate of how many characters (sent + received, cumulative per tab) a
  // DeepSeek chat can hold before hitting its own "Length limit reached" wall — see
  // sendAndTrack's proactive check. Deliberately not tuned precisely against DeepSeek's real
  // limit (unknown, and likely varies): the goal is just to migrate comfortably before the
  // wall, not to squeeze every last character out of a chat, so this errs low. Raised from
  // 60,000 to 100,000 per request (2026-08-15) ahead of testing larger, more ambitious
  // multi-file projects (a whole small game, not just a portfolio site) — fewer migrations
  // per task at the cost of sending DeepSeek closer to its real (still unconfirmed) limit;
  // the reactive "Length limit reached" fallback (see sendAndTrack) still catches it if this
  // estimate ever runs ahead of the true wall. A project whose diffs/tool output are
  // unusually large can still override via config.charBudget.
  const DEFAULT_CHAR_BUDGET = 100000;
  const SESSION_STORAGE_PREFIX = 'session:';
  // A tab that's just produced this many consecutive unproductive responses in a row
  // (corrupted tool calls, "please continue" nudges, claiming DONE with nothing done) gets
  // migrated to a fresh tab early, rather than nudged a 4th time. Rationale: a model that's
  // already produced a few malformed responses has that pattern sitting in its own
  // conversation history and tends to keep repeating it; a clean tab (same mechanism as
  // chat-limit migration — fresh primer + a concise handoff summary) breaks the loop more
  // reliably than hoping the same stuck tab self-corrects. Legitimate iterative work (fixing
  // a real quality-gate failure, exploring with read tools, dispatching a subtask) resets
  // this counter — it only climbs on turns that made no real progress at all.
  const STALL_MIGRATION_THRESHOLD = 3;

  // Known gap (readme.md section 13): "the planner occasionally re-delegates a subtask the
  // executor already finished (observed live as a repeated/nested loop)." Guards against the
  // narrowest, safest-to-detect case of that: the SAME [SUBTASK] text dispatched twice in a
  // row with nothing else in between. Deliberately not a broader semantic-similarity check —
  // that risks false-positiving on legitimately similar-but-distinct follow-up work, whereas
  // an exact repeat right after the executor just reported DONE is never a plausible genuine
  // need for two identical dispatches back to back.
  const REPEATED_SUBTASK_THRESHOLD = 2;

  // Progress-based stall detection: consecutive subtasks that leave the working tree AND
  // the onSubtask gate output (if any) byte-identical to the previous subtask — a real
  // "nothing actually happened" signal the message-shape-based counters above can't see.
  const NO_PROGRESS_STREAK_THRESHOLD = 3;

  // Persistent (chrome.storage.local survives service-worker restarts and browser
  // restarts) record of a project's last live planner/executor tabs, so a later
  // `--resume` run can reattach to the actual same DeepSeek conversation instead of
  // starting a blank one — real continuity, not just a memory.md summary hand-off.
  function sessionStorageKey(projectRoot) {
    return `${SESSION_STORAGE_PREFIX}${projectRoot}`;
  }

  async function saveSession(session) {
    const key = sessionStorageKey(session.projectRoot);
    await chrome.storage.local.set({
      [key]: {
        taskId: session.taskId,
        plannerTabId: session.plannerTabId,
        executorTabId: session.executorTabId,
        plannerMsgCount: session.plannerMsgCount,
        executorMsgCount: session.executorMsgCount,
        savedAt: Date.now(),
      },
    });
  }

  async function loadSavedSession(projectRoot) {
    const key = sessionStorageKey(projectRoot);
    const result = await chrome.storage.local.get(key);
    return result[key] || null;
  }

  async function clearSavedSession(projectRoot) {
    await chrome.storage.local.remove(sessionStorageKey(projectRoot));
  }

  async function tabStillAlive(tabId) {
    if (typeof tabId !== 'number') return false;
    try {
      await chrome.tabs.get(tabId);
      return true;
    } catch (_) {
      return false;
    }
  }

  // Closes a project's saved session's tabs (if still open) and forgets it. Used by the
  // CLI's --close-session mode; does not touch any currently in-flight task.
  async function closeSession(projectRoot) {
    const saved = await loadSavedSession(projectRoot);
    if (!saved) return { closed: false, reason: 'no saved session for this project' };
    await TabManager.closeTabs(saved.plannerTabId, saved.executorTabId);
    await clearSavedSession(projectRoot);
    return { closed: true };
  }

  // Format: !ASK_USER "question text" | option one | option two  (the "| options" part is
  // optional — omit it entirely for a free-text question). Pauses the whole task until a
  // real human answers via the CLI, same idea as Claude Code's own AskUserQuestion. Use it
  // sparingly — for genuine ambiguity or a decision only the user can make, not for
  // routine confirmations you could just verify yourself with a tool.
  const ASK_USER_INSTRUCTION =
    'If something is genuinely ambiguous or requires a decision only the user can make ' +
    '(not something you could verify yourself with a tool), you may ask a real question ' +
    'with !ASK_USER "question text" | option one | option two (the "| options" part is ' +
    'optional — omit it for a free-text question). This pauses the task until the user ' +
    'answers, so use it sparingly, not for routine confirmations.';

  // By the time DONE/ALL_DONE is actually evaluated, the model has nothing left to add —
  // per the "tool calls always deferred first" rule elsewhere in this file, that verdict is
  // only ever trusted on a message with no fresh tool calls of its own, i.e. one reacting to
  // results it's already shown in full via the tool cards above it. A long essay restating
  // all of that is wasted typing (and a wasted turn) for what's really just a confirmation.
  const SHORT_CONFIRMATION_INSTRUCTION =
    'Keep that confirmation itself short — under 100 characters, e.g. "DONE Created ' +
    'hello.txt." or "ALL_DONE Committed and pushed to origin master." You already showed ' +
    'the real work via tool calls; no need to re-narrate it here.';

  const SEARCH_WEB_INSTRUCTION =
    'For anything you need current/external information on (a library\'s current API, an ' +
    'error message, a version number), use !SEARCH_WEB "query" — it runs in a separate, ' +
    'throwaway search and reports back `{answer, sources}` (sources is a list of URLs); it ' +
    'does not cost you a real turn. Treat `answer` as a second-hand summary, not verified ' +
    'fact — if you need to confirm a specific detail or need more than the summary gives ' +
    'you, follow up with !HTTP_GET on the relevant URL from `sources`.';

  // There is no temperature control available — this drives DeepSeek's free web chat, not
  // its API, and the web UI exposes no such setting. This explicit instruction is the
  // available lever instead: state the rule plainly rather than relying on the model to
  // infer it. The system already catches and rejects fabricated tool output after the fact
  // (see the "never trust tool calls in the same breath" comments below) — this is aimed at
  // reducing how often the model attempts it in the first place, not replacing that check.
  const ACCURACY_INSTRUCTION =
    'Never invent file contents, command output, error messages, or other facts. Only state ' +
    'what a real !TOOL call actually returned to you — if you don\'t know or haven\'t checked ' +
    'yet, say the word UNKNOWN rather than guessing, and use !SEARCH_WEB or another tool to ' +
    'verify instead. A wrong guess stated as fact is worse than an honest UNKNOWN.';

  // A short, front-loaded bulleted list, deliberately repeating points already made in fuller
  // prose elsewhere in the primer — research on structured-output compliance backs this
  // redundancy: a short "Rules:" list positioned early gets followed more reliably than the
  // same guidance stated once, in prose, further down a long instruction block.
  const CORE_RULES_BLOCK =
    'Rules:\n' +
    '- One !TOOL call per line. Nothing else on that line.\n' +
    '- Unsure about something? Say UNKNOWN or ask via !ASK_USER. Never guess.\n' +
    '- Be brief — short lines, no long paragraphs, don\'t restate what a tool call already showed.\n' +
    '- Never reply DONE/ALL_DONE unless a real !TOOL call actually verified it, this turn or earlier.';

  // Without this, observed live: a model asked to do something as simple as "git add
  // commit push" will spend several turns trying to hand-inspect .git/index, .git/objects,
  // etc. through the read-only file tools before it ever occurs to it to just delegate —
  // because nothing told it that it CAN'T run commands itself. Same for over-splitting: a
  // model will default to one subtask per shell command unless told batching is fine.
  const PLANNER_LIMITS_INSTRUCTION =
    'IMPORTANT: you cannot make changes yourself — !READ_FILE/!GREP/!FIND_FILE/!LS are ' +
    'read-only inspection tools, nothing more. !WRITE_FILE, !EDIT_FILE, !SHELL, !SHELL_BG, ' +
    '!PROC_KILL, !DELETE_FILE, !OPEN_APP, and any project-declared !CALL_* tool are ' +
    'executor-only: if you issue them, they ' +
    'will NOT run (this is enforced, not just a guideline) — you\'ll just get a note ' +
    'telling you to delegate instead. The ' +
    'instant a task needs any actual change (writing/editing a file, running a command like ' +
    'git/npm/tests/builds, deleting something, opening an app), delegate it via [SUBTASK] ' +
    'immediately — do not try to work around this by inspecting internal files (e.g. .git ' +
    "internals) by hand, and do not attempt the change yourself \"just this once.\" If the " +
    'steps are simple and sequential (e.g. "stage, commit, and push"), put them all in ONE ' +
    '[SUBTASK] rather than one subtask per command — only split into multiple subtasks when ' +
    'a later step genuinely depends on the outcome of an earlier one you need to see first.';

  // Concrete few-shot example, not just a rule description — shown to directly prevent the
  // observed failure mode (multiple !TOOL calls ending up on the same line, e.g. one
  // followed by a parenthetical aside, which then fails to parse as any of them and wastes
  // a whole round-trip). Modeled on exactly the shape that broke in practice.
  const TOOL_FORMAT_EXAMPLE =
    'Correct format — one call per line, nothing else on that line (no other !TOOL call, ' +
    'no parenthetical notes, no trailing commentary):\n' +
    '!LS .\n' +
    '!READ_FILE package.json\n' +
    'WRONG (do not do this — multiple calls or extra text crammed onto one line will fail ' +
    'to parse and cost you a wasted turn): ' +
    '`!READ_FILE package.json !LS .` or `!READ_FILE package.json (to check the version)`. ' +
    'If you want to explain something, put the explanation on its own separate line, before ' +
    'or after the tool call line — never on the same line as it.';

  const READ_FILE_INSTRUCTION =
    '!READ_FILE on a huge file auto-truncates with a "(PARTIAL — showing lines 1-N of ' +
    'TOTAL...)" marker telling you the exact next call to make; you can also request a ' +
    'specific range yourself with !READ_FILE <path> <offset> <limit> (line numbers, both ' +
    'optional).';

  // Cheapest possible defense against burning an entire session (and a whole browser
  // conversation's message budget) on a misread objective — but only when a project opts
  // into it (config.requirePlanApproval), since it adds a real pause before any work starts
  // and every existing scripted test/scenario assumes the planner can dispatch immediately.
  const PLAN_APPROVAL_INSTRUCTION =
    'IMPORTANT: before your very first [SUBTASK], first present your overall approach as a ' +
    'short bullet list using [PLAN]...[/PLAN] (major steps only, not full detail) and wait — ' +
    'do not include a [SUBTASK] in that same message. The user will approve or reject it; if ' +
    'rejected, revise and present [PLAN] again. Only after approval should you start ' +
    'dispatching [SUBTASK]s.';

  // Observed live (2026-08-13): a task named an absolute path elsewhere on disk ("look at
  // C:\other\path, commit and push it"). The planner's FIRST subtask correctly included that
  // path, the executor succeeded — but a later subtask (after the planner had already seen a
  // few tool results) dropped it, just said "run git status and git diff," and the executor
  // ran them against its own project root instead, silently concluding "not a git repo,
  // nothing to do." Nothing forces the path to persist across turns, so it has to be an
  // explicit, repeated rule rather than something inferred once.
  const TARGET_PATH_INSTRUCTION =
    'IMPORTANT: if the user\'s task names a specific absolute path (a project/folder ' +
    'elsewhere on disk, not this project\'s own root), that path is NOT remembered by the ' +
    'executor between subtasks — repeat it explicitly in the text of EVERY [SUBTASK] that ' +
    'needs it, every time, even if you already mentioned it in an earlier subtask. Dropping ' +
    'it (e.g. just saying "run git status") makes the executor run against the wrong ' +
    'directory and silently report nothing to do.';

  // Observed live (2026-08-15): asked for plain client-side sites (a portfolio, a small
  // game), output quality was inconsistent — sometimes a single crammed file, sometimes
  // thin/minimal content — because nothing told the planner to actually DECIDE a structure
  // and a bar for these, so it defaulted to whatever was quickest to state rather than what
  // a real developer would ship. A "no server needed" task is not a lesser one; it just
  // means the deliverable is directly openable (double-click the .html, no build step, no
  // !OPEN_APP npm run dev) — the actual HTML/CSS/JS still deserves the same real effort as
  // anything else.
  const STATIC_SITE_INSTRUCTION =
    'If the task is a plain client-side site or page (no backend/database, viewable by just ' +
    'opening the .html file — no dev server or build step needed), default to REAL project ' +
    'structure unless the user explicitly asked for a single self-contained file: a proper ' +
    'index.html plus its own separate style.css and script.js (and more files/pages if the ' +
    'scope genuinely calls for it — e.g. a multi-page site), the way an actual developer ' +
    'would organize it, not everything crammed into one file out of convenience. Ask for ' +
    'real effort and depth in the subtask itself — complete, polished content matching the ' +
    'full scope requested (real styling, real interactivity, all the sections/pages/features ' +
    'asked for), not a thin placeholder-level skeleton just because no server is involved.';

  function plannerPrimer(requirePlanApproval) {
    return (
      'You are an AI planning agent. Your job is to decompose a user task into small, ' +
      'actionable subtasks and delegate them to a coding agent. You can read the project ' +
      'file list and the project memory. Use tools: !READ_FILE, !GREP, !FIND_FILE, !LS, ' +
      `!SEARCH_WEB, !HTTP_GET.\n\n${CORE_RULES_BLOCK}\n\n${SEARCH_WEB_INSTRUCTION} ${PLANNER_LIMITS_INSTRUCTION} ` +
      `${TARGET_PATH_INSTRUCTION} ${TOOL_FORMAT_EXAMPLE} ${ACCURACY_INSTRUCTION} ${READ_FILE_INSTRUCTION} ${STATIC_SITE_INSTRUCTION} ` +
      (requirePlanApproval ? `${PLAN_APPROVAL_INSTRUCTION} ` : '') +
      'You may also update the project memory using a [MEMORY_UPDATE]...[/MEMORY_UPDATE] block — ' +
      'this APPENDS a new dated entry (older entries stay, up to a size cap), so write only ' +
      "what's new or changed, not a full restatement of everything already known. " +
      'For each subtask, tell the executor the exact goal using [SUBTASK]...[/SUBTASK], e.g.:\n' +
      '[SUBTASK]Stage all changes, commit with a descriptive message, and push to origin master.[/SUBTASK]\n' +
      'When the executor reports DONE, you may verify and assign the next subtask. ' +
      `${ASK_USER_INSTRUCTION} ` +
      'When the entire user task is complete, verify it first (do not just assume — check via a ' +
      `tool or the executor's own verified DONE), then reply ALL_DONE with a summary. ${SHORT_CONFIRMATION_INSTRUCTION}`
    );
  }

  // Delete is intentionally locked down harder than every other tool here: it's the only
  // one with zero config override for reaching outside the project root (see
  // tools.deletePath in native-host), and it always requires user approval regardless of
  // permissions.dangerousCommands. OPEN_APP is the opposite tradeoff — a fixed set of known
  // apps (chrome/cmd/code/explorer) or a bare URL/file open needs no approval at all (small,
  // predictable blast radius), while an arbitrary command behind it (e.g. "npm run dev")
  // gets the same approval gate as a dangerous !SHELL command, since it's genuinely
  // unbounded, just non-blocking instead of waited-on.
  const DELETE_AND_OPEN_INSTRUCTION =
    'To clean up a mistake (a wrong file or folder you created), use !DELETE_FILE <path> — ' +
    'it only ever works inside this project folder, never anywhere else, and always asks ' +
    'for confirmation first. To open an application or view something, use !OPEN_APP ' +
    '<command>, e.g. !OPEN_APP chrome http://localhost:3000, !OPEN_APP code . (opens this ' +
    'project in VS Code), !OPEN_APP index.html (opens a file with its default app), or ' +
    '!OPEN_APP npm run dev (runs a command in its own terminal window — for starting a dev ' +
    'server, for example). That terminal window stays open and running afterward — it does ' +
    'not close itself, so mention it in your summary rather than assuming it went away.';

  const HTTP_GET_INSTRUCTION =
    'To check whether a local server actually came up (e.g. after !OPEN_APP npm run dev) or ' +
    'to fetch a URL\'s response, use !HTTP_GET <url>, e.g. !HTTP_GET http://localhost:3000 — ' +
    'it reports the status code and a truncated body, with its own short timeout. GET only.';

  // Prefer this over !WRITE_FILE for any change to an EXISTING file — a whole-file rewrite
  // wastes a paste/response cycle on content that didn't change, and risks silently dropping
  // parts of the file the model didn't mean to touch. oldString must match the file's CURRENT
  // content exactly (re-!READ_FILE first if unsure) and must be unique in the file — include
  // enough surrounding lines to disambiguate if the exact text appears more than once.
  const EDIT_FILE_INSTRUCTION =
    'For any change to an EXISTING file, prefer !EDIT_FILE over !WRITE_FILE — it replaces ' +
    'one exact, unique piece of text instead of rewriting the whole file. Format:\n' +
    '!EDIT_FILE path/to/file.js\n```\nold text here, copied exactly from the file\n```\n```\n' +
    'new text to replace it with\n```\n' +
    'The old text must appear in the file EXACTLY ONCE — if it\'s not found or found more ' +
    'than once, you\'ll get an error telling you which; re-!READ_FILE the file and/or ' +
    'include more surrounding lines to make it unique, then retry. Only use !WRITE_FILE for ' +
    'a brand-new file or a genuine full rewrite.';

  // Observed live (2026-08-15): a task working across two directories (a project root plus
  // a subfolder like a Laravel app's own backend/ directory) mixed !SHELL and !SHELL_BG and
  // lost track of where each command was actually running — issuing `!SHELL cd backend &&
  // composer install`, then later a bare `!SHELL_BG composer install` expecting it to still
  // be "in" backend/. It wasn't: !SHELL calls in the SAME task share ONE real persistent
  // shell process (see native-host/host.js's persistentShell.getOrCreateSession, keyed by
  // taskId) — a `cd` genuinely does carry over from one !SHELL call to the next, same as a
  // human typing into one real terminal. !SHELL_BG is a DIFFERENT, always-fresh process
  // rooted back at the project root every time (deliberately NOT tied to !SHELL's session,
  // so a long-lived dev server started in the background can't get killed or have its cwd
  // yanked out from under it by later, unrelated !SHELL cd's) — it does NOT see any `cd`
  // issued via !SHELL, and vice versa. Treat them as two SEPARATE terminals: know which one
  // you're "standing in" for any given command, and never assume a `cd` from one carries
  // over to the other. Same failure mode with !LS: it takes a bare path only, no shell
  // flags, but a model sometimes sends "!LS -la <path>" out of habit.
  const SHELL_CWD_INSTRUCTION =
    'IMPORTANT — two SEPARATE shells, know which one you\'re in: !SHELL calls in this task ' +
    'share ONE real persistent shell process, so a "cd" in one !SHELL call DOES carry over ' +
    'to the next !SHELL call (just like a real terminal) — no need to re-cd every time. ' +
    '!SHELL_BG is a DIFFERENT process, always starting fresh at THIS project\'s own root ' +
    'folder — it never sees a "cd" you ran via !SHELL, and a "cd" you run via !SHELL_BG ' +
    'never affects later !SHELL calls either. If a background command (e.g. starting a dev ' +
    'server) needs to run inside a subdirectory, "cd" into it in that SAME !SHELL_BG call ' +
    '(!SHELL_BG cd "backend" && npm run dev) — do not rely on an earlier !SHELL cd for it. ' +
    'To run a ONE-OFF !SHELL/!SHELL_BG command against a directory outside this project ' +
    'entirely (e.g. the task names some other path on disk), either chain it in the SAME ' +
    'call (!SHELL cd "C:\\other\\path" && git status) or pass it directly to the command ' +
    '(!SHELL git -C "C:\\other\\path" status). Also: !LS takes a bare path only — never ' +
    'shell-style flags like -la; !LS <path> already shows type and size for every entry.';

  // Observed live (2026-08-14): asked for a "multiline commit message," the executor put a
  // literal newline inside `git commit -m "..."` — but !SHELL is one line, one call (see
  // CORE_RULES_BLOCK), so the tool-call parser cut the command off mid-string at that
  // newline, leaving an unterminated quote. The shell then just sat there waiting for more
  // input until the call timed out. git's own -m flag can repeat (each becomes its own
  // paragraph, blank-line-separated) specifically to avoid ever needing an embedded newline.
  const MULTILINE_COMMIT_INSTRUCTION =
    'For a multi-line/multi-paragraph git commit message, do NOT put a literal newline ' +
    'inside a single -m "..." — !SHELL calls are one line each, so that truncates the ' +
    'command mid-string and hangs. Instead pass -m once per paragraph, e.g.: ' +
    '!SHELL git commit -m "Short summary line" -m "More detail in a second paragraph." — ' +
    'git joins them with a blank line between each, giving a real multi-paragraph message ' +
    'without any embedded newline.';

  // Observed live (2026-08-15): asked to get a Laravel backend running, the executor
  // correctly ran composer install and `php artisan serve` but never started MySQL — it
  // just wasn't something it thought to check, so `php artisan migrate`/the app itself
  // silently failed to connect once it actually needed the database. There is no dedicated
  // !TOOL for "start the database"; it has to be discovered and run like any other local
  // command. Named explicitly here (rather than left as a general "explore the environment"
  // expectation) because this exact gap already cost a real run. Ordering below (OS service
  // manager FIRST, XAMPP-specific script only as fallback) per live feedback the same day:
  // the original version led with hunting for a XAMPP control script even on a machine
  // where the plain OS service command would have just worked — the simplest, most standard
  // thing that's likely to already be registered as a service should be tried before
  // spending turns discovering an install-specific script.
  const DEV_SERVICES_INSTRUCTION =
    'Before running database migrations or starting a backend that needs one, verify the ' +
    'database server is actually running rather than assuming it is (e.g. try connecting, ' +
    'or !SHELL mysqladmin ping). If it is not running, start it — try the simplest, most ' +
    'standard way FIRST: the OS service manager (!SHELL net start mysql on Windows, ' +
    '!SHELL sudo systemctl start mysql on Linux). Only if that fails (service not ' +
    'registered, permission denied, etc.) fall back to hunting for the local stack\'s own ' +
    'control script — on a XAMPP install this is typically a batch file or executable in ' +
    'the XAMPP root folder (e.g. "C:\\xampp8.4\\mysql_start.bat" or ' +
    '"C:\\xampp8.4\\xampp_start.exe"; !LS the XAMPP root folder if unsure of the exact ' +
    'install path/version) — or whatever the project\'s own docs/config say to use ' +
    '(docker compose up, brew services start mysql, etc.).';

  // Observed live (2026-08-15), same night as SHELL_CWD_INSTRUCTION and
  // DEV_SERVICES_INSTRUCTION above: a whole session of real tasks kept re-discovering "this
  // is Windows" the hard way, one failed guess at a time — `cd C:\...` (backslashes eaten by
  // bash), then `/mnt/c/...` (WSL convention, wrong here), before finally landing on the
  // `/c/...` form that actually works in this project's Git-Bash-backed !SHELL session; `net
  // start mysql` failing with "Access is denied" before falling back to a control script.
  // Every one of those was knowable in advance from a single fact — which OS this is — that
  // nothing ever told either agent. session.os (see cli/index.js's RUN_TASK options, the
  // only place process.platform is actually available) makes that a known fact from turn
  // one instead of something to be rediscovered by trial and error on every single task.
  //
  // Shell type prefers session.envInfo (see TOOLS.ENV_INFO/native-host's envInfo()) — the
  // one place that actually KNOWS which shell resolvePersistentShell() picked on this
  // machine — over guessing "probably Git Bash" from the OS alone; falls back to the
  // Windows-typically-has-Git-Bash assumption only when that lookup itself failed.
  //
  // Also states the project's own absolute root path plainly: !READ_FILE/!WRITE_FILE/!LS/
  // etc. are always root-relative regardless of the persistent shell's current `cd`, and a
  // model that has to infer the root from a `pwd` output (itself only meaningful for the
  // SHELL side, not the file tools) is exactly the kind of avoidable confusion this section
  // exists to head off.
  function buildEnvironmentSection(session) {
    const os = session.os;
    const shell = session.envInfo && session.envInfo.shell;
    const rootLine = `\n\nProject root (absolute path — !READ_FILE/!WRITE_FILE/!LS/etc. are ` +
      `always relative to THIS, regardless of the persistent shell's current directory): ` +
      `${session.projectRoot}`;
    if (os === 'win32') {
      const shellLine = shell === 'cmd.exe'
        ? 'The persistent !SHELL/!SHELL_BG session runs in cmd.exe here (no Git Bash found) ' +
          '— normal Windows backslash paths work there too.'
        : 'The persistent !SHELL/!SHELL_BG session runs in Git Bash, though — Unix-style ' +
          'paths there (e.g. /c/xampp8.4/htdocs/project) are what actually works, NOT ' +
          'backslash paths (bash eats the backslashes) and NOT the WSL-style /mnt/c/... form.';
      return (
        `\n\nOperating system: Windows. !READ_FILE/!WRITE_FILE/!EDIT_FILE/!LS/!DELETE_FILE ` +
        `accept normal Windows paths (e.g. C:\\Users\\you\\project). ${shellLine} ` +
        'Starting/stopping a Windows service needs Administrator rights (!SHELL net start ' +
        '<service> / net stop <service> may fail with "Access is denied" on a non-elevated ' +
        'shell — if so, fall back to the service\'s own start script instead, e.g. XAMPP\'s ' +
        `mysql_start.bat).${rootLine}`
      );
    }
    if (os === 'darwin') {
      return (
        '\n\nOperating system: macOS. Normal Unix paths and commands throughout. For a ' +
        `Homebrew-installed service, use !SHELL brew services start/stop <name>.${rootLine}`
      );
    }
    if (os === 'linux') {
      return (
        '\n\nOperating system: Linux. Normal Unix paths and commands throughout. For a ' +
        'system service, use !SHELL sudo systemctl start/stop <service> (may prompt for a ' +
        `password if not already root).${rootLine}`
      );
    }
    return rootLine;
  }

  const BACKGROUND_PROC_INSTRUCTION =
    'For a command that keeps running (a dev server, a watch build, a long test suite), use ' +
    '!SHELL_BG <command> instead of !SHELL — it starts the command in the background and ' +
    'returns immediately with a process id, instead of blocking (and eventually timing out) ' +
    'while it runs. Check on it with !PROC_LIST (shows all background processes for this ' +
    'task and whether they\'re still running), !PROC_LOG <id> [lines] (recent output, ' +
    'default last 100 lines), and !PROC_KILL <id> (stop it) when you\'re done with it or ' +
    'need to restart it.';

  const EXECUTOR_PRIMER =
    'You are a coding agent. You have access to the project files and can run shell ' +
    'commands. Use tools: !READ_FILE, !WRITE_FILE, !EDIT_FILE, !SHELL, !SHELL_BG, ' +
    '!PROC_LIST, !PROC_LOG, !PROC_KILL, !GREP, !FIND_FILE, !LS, !SEARCH_WEB, !DELETE_FILE, ' +
    `!OPEN_APP, !HTTP_GET.\n\n${CORE_RULES_BLOCK}\n\n${SEARCH_WEB_INSTRUCTION} ` +
    `${TOOL_FORMAT_EXAMPLE} ${ACCURACY_INSTRUCTION} ${DELETE_AND_OPEN_INSTRUCTION} ${HTTP_GET_INSTRUCTION} ` +
    `${EDIT_FILE_INSTRUCTION} ${BACKGROUND_PROC_INSTRUCTION} ${SHELL_CWD_INSTRUCTION} ${MULTILINE_COMMIT_INSTRUCTION} ${READ_FILE_INSTRUCTION} ${DEV_SERVICES_INSTRUCTION} ` +
    'IMPORTANT: simply showing code in your response does NOT save it anywhere — nothing ' +
    'is written to disk unless you issue an actual !WRITE_FILE <path> command (followed by ' +
    'a fenced code block with the content), an !EDIT_FILE, or an !SHELL command, e.g.:\n' +
    '!WRITE_FILE hello.txt\n```text\nHello World\n```\n' +
    'When given a subtask, use ' +
    'these tools to write code, run commands, and iterate until the subtask is complete. ' +
    `${ASK_USER_INSTRUCTION} ` +
    'Before replying DONE, ask yourself: did I actually run a tool that proves this is ' +
    'finished? If not, run one first — verify your changes actually exist on disk (e.g. via ' +
    `!READ_FILE or !LS). Then reply DONE with a brief summary. ${SHORT_CONFIRMATION_INSTRUCTION} ` +
    'If you encounter an error, fix it and keep going.';

  // taskId -> session
  const sessions = new Map();

  // Single choke point for every message this file sends to the CLI — see CANCEL_TASK's
  // protocol.js comment for why this exists. Every call site below uses this instead of
  // NativeBridge.sendToCli directly so a cancelled task's stale in-flight turn (which can't
  // be interrupted mid-await, only ignored once it resolves) can never reach a CLI process
  // that's already moved on to a different task.
  function notifyCli(payload) {
    if (payload && payload.taskId && sessions.get(payload.taskId) && sessions.get(payload.taskId).cancelled) return;
    NativeBridge.sendToCli(payload);
  }

  // Marks a session cancelled so sendAndTrack refuses to start another turn and notifyCli
  // stops forwarding anything for it — see CANCEL_TASK's protocol.js comment for the full
  // story (a killed CLI process's in-flight task otherwise keeps running and can corrupt a
  // later CLI session). Best-effort only: an already in-flight tab wait can't be aborted,
  // just prevented from causing more damage once it resolves.
  function cancelTask(taskId) {
    const session = sessions.get(taskId);
    if (session) session.cancelled = true;
  }

  function newSession(taskId, task, options, config, permissions, projectRoot) {
    const session = {
      taskId,
      plannerTabId: null,
      executorTabId: null,
      plannerReady: false,
      executorReady: false,
      plannerMsgCount: 0,
      executorMsgCount: 0,
      // See DEFAULT_CHAR_BUDGET / sendAndTrack's proactive migration check.
      plannerCharCount: 0,
      executorCharCount: 0,
      charBudget: (config && config.charBudget) || DEFAULT_CHAR_BUDGET,
      plannerStallCount: 0,
      executorStallCount: 0,
      lastSubtaskText: null,
      currentSubtaskText: null,
      repeatedSubtaskCount: 0,
      // See CANCEL_TASK / cancelTask / notifyCli below.
      cancelled: false,
      // Surfaced to the CLI on completion/error (see TASK_COMPLETED/TASK_ERROR below) so a
      // long-running or looping task is visible in its cost, not just its outcome.
      toolCallCount: 0,
      // Only true once initial setup (both tabs created/reattached AND the executor primer
      // + planner's first exchange both actually succeeded) has genuinely completed. Gates
      // whether this session is ever persisted for a later --resume — see the `finally`
      // block in runTask for why this matters.
      primed: false,
      approveAll: !!options.approveAll,
      webSearchEnabled: !!options.webSearch,
      // Node's process.platform string ('win32'/'darwin'/'linux'/...) — see cli/index.js's
      // own comment on why this has to be threaded in from there rather than detected here.
      os: options.os || null,
      taskDescription: task,
      qualityGates: normalizeGates(config && config.qualityGates),
      maxRetries: (config && config.maxRetries) || 5,
      migrationThreshold: (config && config.migrationThreshold) || DEFAULT_MIGRATION_THRESHOLD,
      permissions: permissions || {},
      projectRoot,
      state: 'init',
      // Opt-in (config.requirePlanApproval) — off by default so existing behavior/scripted
      // scenarios are unaffected. planApproved starts true when the gate itself is off, so
      // every check below (`requirePlanApproval && !planApproved`) is a no-op in that case.
      requirePlanApproval: !!(config && config.requirePlanApproval),
      planApproved: !(config && config.requirePlanApproval),
      // { preToolUse, postToolUse, onSubtaskDispatch, onMigration, onGateResult,
      // onTaskComplete } -> shell command strings. All optional; see runHook above.
      hooks: (config && config.hooks) || {},
      // Progress-based stall detection — complements (doesn't replace) plannerStallCount/
      // executorStallCount above, which only catch unproductive-*looking* replies. This
      // catches the case those can't: several differently-worded subtasks in a row that all
      // report success but leave the working tree and gate output byte-identical.
      lastTreeHash: null,
      lastSubtaskGateOutput: null,
      noProgressStreak: 0,
      // Layered, path-scoped instructions (.myclaudecode/rules/*.md) — populated once by
      // gatherInitialContext; empty defaults here cover a --resume session, which skips
      // that call entirely (readme.md section 10).
      projectRules: [],
      injectedRuleFiles: new Set(),
      // Declarative external tools (.myclaudecode/tools.json) — populated once by
      // gatherInitialContext; empty default covers a --resume session, same as projectRules.
      externalTools: [],
    };
    sessions.set(taskId, session);
    return session;
  }

  // Fires a config-declared hook for `event`, if one is configured — a no-op (no native-host
  // round trip at all) when it isn't, so hooks cost nothing for sessions that don't use them.
  // See tools.runHook for exit-code semantics (2 = blocked, preToolUse only).
  async function runHook(session, event, payload) {
    const command = session.hooks && session.hooks[event];
    if (!command) return { exitCode: 0, stdout: '', stderr: '', blocked: false };
    try {
      return await NativeBridge.execTool(session.taskId, TOOLS.RUN_HOOK, { command, event, payload });
    } catch (err) {
      return { exitCode: 1, stdout: '', stderr: err.message, blocked: false };
    }
  }

  function sessionStats(session) {
    return {
      plannerTurns: session.plannerMsgCount,
      executorTurns: session.executorMsgCount,
      toolCalls: session.toolCallCount,
    };
  }

  // Observed live (2026-08-15): a single !SHELL result (a `git diff` covering several large
  // deleted/modified files) came back over 200,000 characters — by itself, more than 3x
  // sendAndTrack's entire charBudget (60,000 at the time this was caught; since raised to
  // 100,000 — see DEFAULT_CHAR_BUDGET above — but the fix below stands regardless of the
  // exact number, since a single-message result can always outgrow whatever the budget is).
  // That tripped
  // the proactive "chat is approaching its length limit" check before this message was ever
  // sent, so it migrated to a fresh tab instead of delivering it — and the fresh tab, given
  // the exact same subtask, ran the exact same command and got the exact same oversized
  // result, migrating again. Every tab in the chain hit the identical wall without DeepSeek
  // ever actually seeing the content once, an unproductive loop the user had to stop
  // manually. Migrating again and again cannot fix a single message that's inherently too
  // big — only shrinking the message itself does. Capping stdout/stderr here, before they're
  // ever embedded in a prompt, means formatToolResult can never hand sendAndTrack something
  // that alone exceeds the budget, regardless of how large the underlying command's real
  // output was.
  const TOOL_RESULT_FIELD_MAX_CHARS = 8000;

  function truncateForPrompt(str) {
    if (typeof str !== 'string' || str.length <= TOOL_RESULT_FIELD_MAX_CHARS) return str;
    // Keep the head, not the tail: the earliest part of a command's output (e.g. the first
    // files in a git diff, the first lines of a build log) is what a model most needs to
    // reason about next — same reasoning as SUBTASK_TRANSCRIPT_MAX_CHARS keeping the most
    // recent entries there, just mirrored for the opposite shape of data (one big chunk vs.
    // many small entries).
    return `${str.slice(0, TOOL_RESULT_FIELD_MAX_CHARS)}\n…(truncated, ${str.length - TOOL_RESULT_FIELD_MAX_CHARS} more characters — re-run with a narrower command, e.g. a specific file or \`--stat\`, to see more)`;
  }

  function formatToolResult(call, result, error) {
    const header = `(tool result for !${call.tool} ${JSON.stringify(call.params)})`;
    if (error) return `${header}\nERROR: ${truncateForPrompt(error)}`;
    if (result && typeof result === 'object') {
      const capped = { ...result };
      if (typeof capped.stdout === 'string') capped.stdout = truncateForPrompt(capped.stdout);
      if (typeof capped.stderr === 'string') capped.stderr = truncateForPrompt(capped.stderr);
      return `${header}\n${JSON.stringify(capped, null, 2)}`;
    }
    return `${header}\n${truncateForPrompt(String(result))}`;
  }

  // Observed live (2026-08-14): the planner received "Executor finished subtask: DONE
  // Already reported git status and diff --stat output above" and had no idea what that
  // meant — because "above" refers to the EXECUTOR's own chat, a completely separate
  // DeepSeek conversation the planner never sees any part of. Only the executor's final
  // text (subtaskSummary in the caller) crossed back to the planner; every real tool result
  // from the subtask was discarded. The executor wasn't lying — the output genuinely was
  // "above" from its own point of view — but the planner had nothing to verify against, so
  // it stalled on !ASK_USER asking the (human) user to paste output the agent itself already
  // had. Fix: carry a bounded transcript of the subtask's actual tool results along with the
  // final DONE text, so the planner gets real evidence instead of a bare claim it can't check.
  const SUBTASK_TRANSCRIPT_MAX_CHARS = 2000;

  function summarizeSubtaskTranscript(entries) {
    if (!entries.length) return '';
    let combined = entries.join('\n');
    if (combined.length > SUBTASK_TRANSCRIPT_MAX_CHARS) {
      // Keep the MOST RECENT entries, not the earliest — the last few tool calls before DONE
      // are the ones most likely to actually substantiate the completion claim (e.g. the
      // final `git push` result), while early exploratory calls are the least load-bearing.
      while (entries.length > 1 && entries.join('\n').length > SUBTASK_TRANSCRIPT_MAX_CHARS) {
        entries.shift();
      }
      combined = entries.join('\n');
      if (combined.length > SUBTASK_TRANSCRIPT_MAX_CHARS) {
        combined = `…(truncated)\n${combined.slice(-SUBTASK_TRANSCRIPT_MAX_CHARS)}`;
      }
    }
    return `\n\n(actual tool activity from this subtask, for verification):\n${combined}`;
  }

  // See ToolCallParser.hasCorruptedToolCall: tells the model exactly what went wrong
  // (multiple !TOOL calls merged onto one line) instead of it having to infer that from a
  // confusing, unrelated tool error — or from nothing at all, if the whole message was just
  // the one corrupted call.
  const CORRUPTION_NOTE =
    "(system) One or more !TOOL calls in your last message did not parse correctly — it " +
    'looks like multiple !TOOL calls got merged onto a single line. Each !TOOL call must be ' +
    'the ONLY thing on its own line, with nothing before or after it (including other ' +
    '!TOOL calls or parenthetical notes). Please re-issue the affected call(s), each on its ' +
    'own separate line, with nothing else on that line.';

  function appendCorruptionNote(text) {
    return text ? `${text}\n\n${CORRUPTION_NOTE}` : CORRUPTION_NOTE;
  }

  // The planner delegates work — it doesn't do it. PLANNER_LIMITS_INSTRUCTION already tells
  // it this in the primer, but a prompt-only rule has repeatedly not been enough: observed
  // live (2026-08-11), the planner wrote an entire project directly via !WRITE_FILE and
  // declared ALL_DONE without ever dispatching a single [SUBTASK] — no delegation happened
  // at all, defeating the whole point of the two-role split (the executor tab sat unused
  // for the entire task). Enforce this in code instead of just asking nicely: these tools
  // are simply never executed when the planner issues them.
  const PLANNER_DISALLOWED_TOOLS = new Set([
    TOOLS.WRITE_FILE,
    TOOLS.EDIT_FILE,
    TOOLS.SHELL,
    TOOLS.SHELL_BG,
    TOOLS.PROC_KILL,
    TOOLS.DELETE_FILE,
    TOOLS.OPEN_APP,
  ]);

  // CALL_ tool names are dynamic (declared per-project in tools.json), so a static Set can't
  // list them — they run arbitrary shell commands underneath (see callExternalTool), so they
  // get the same executor-only treatment as SHELL itself, checked structurally instead.
  function isPlannerDisallowed(tool) {
    return PLANNER_DISALLOWED_TOOLS.has(tool) || tool.startsWith('CALL_');
  }

  const PLANNER_DELEGATE_NOTE =
    "(system) As the planner, you don't make changes yourself — the tool call(s) above " +
    'were NOT run (they only work for the executor). Delegate this work to the executor ' +
    'instead, using [SUBTASK]...[/SUBTASK].';

  const REPEATED_SUBTASK_NOTE =
    '(system) You just dispatched this exact same [SUBTASK] again, immediately after the ' +
    "executor already reported it DONE. This was NOT dispatched — it looks like you may have " +
    "lost track of what's already finished. If the work is genuinely already done, verify it " +
    'yourself (e.g. !READ_FILE or !LS) instead of re-delegating, then move on to the next ' +
    'subtask or ALL_DONE. Only re-dispatch this exact subtask if you have concrete evidence ' +
    "(a real tool result) that it's still incomplete.";

  // questionId -> resolve(answer: string). Lets the planner/executor pause mid-task and
  // ask the human a real question (multiple-choice or free text) instead of guessing —
  // same idea as Claude Code's AskUserQuestion, routed through the CLI's terminal.
  const pendingQuestions = new Map();
  // If the CLI/terminal that would answer this disappears (closed, crashed, connection
  // lost) with a question still pending, nothing would ever resolve it — the task, its
  // session, and its open tabs would leak forever. Bound the wait so a lost connection
  // fails the task cleanly instead.
  const ASK_USER_TIMEOUT_MS = 15 * 60 * 1000;

  function askUser(taskId, question, options) {
    const questionId = crypto.randomUUID();
    notifyCli({
      type: CLI_MESSAGE_TYPES.USER_QUESTION_REQUIRED,
      taskId,
      questionId,
      question,
      options,
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingQuestions.has(questionId)) {
          pendingQuestions.delete(questionId);
          reject(new Error(`No answer received for the question within ${ASK_USER_TIMEOUT_MS / 60000} minutes.`));
        }
      }, ASK_USER_TIMEOUT_MS);
      pendingQuestions.set(questionId, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
    });
  }

  function answerQuestion(questionId, answer) {
    const resolve = pendingQuestions.get(questionId);
    if (resolve) {
      pendingQuestions.delete(questionId);
      resolve(answer);
    }
  }

  // On-demand !SEARCH_WEB: DeepSeek only exposes web search as its own native chat toggle,
  // not a queryable API, so there's no way to search "silently" the way a native-host tool
  // call does. Instead of routing through the native host (which has no way to fulfil it —
  // it throws, see host.js), this opens a short-lived side tab, asks it the one query with
  // search forced on, reads the answer back as the tool result, then closes it — keeping
  // the search out of the planner/executor's own conversation (and message-count/migration
  // budget) entirely, rather than spending one of their real turns on it.
  // Asked explicitly rather than scraped from the DOM: no captured real chat.deepseek.com
  // outerHTML exists for whatever citation/footnote markup its web-search feature renders
  // (same honesty-about-uncertainty reasoning as the Stopped-badge/CAPTCHA selectors in
  // content.js), so extracting "SOURCE: <url>" lines out of the reply text itself is the
  // reliable option — it only depends on chat text, the one thing already proven to work.
  const SOURCE_LINE_RE = /^SOURCE:\s*(\S+)/gm;
  const SEARCH_SOURCE_INSTRUCTION =
    ' After answering, list every source URL you actually used, one per line, each ' +
    'formatted exactly as: SOURCE: <url> — no other text on those lines.';

  async function performWebSearch(session, query) {
    const tabId = await TabManager.createSearchTab(session.taskId);
    try {
      await TabManager.waitForReady(tabId);
      await TabManager.sendToTabResilient(tabId, { action: 'toggleWebSearch', enabled: true });
      const searchStartedAt = Date.now();
      const res = await TabManager.sendToTabResilient(
        tabId,
        { action: 'typeAndSend', text: `${query}\n${SEARCH_SOURCE_INSTRUCTION}`, instant: true },
        { onAttempt: sendAttemptReporter(session, 'search') }
      );
      notifyCli({
        type: CLI_MESSAGE_TYPES.TIMING,
        taskId: session.taskId,
        phase: 'web_search',
        role: 'search',
        elapsedMs: Date.now() - searchStartedAt,
        diagnostics: (res && res.diagnostics) || null,
      });
      if (res && res.error) throw new Error(`Web search failed: ${res.error}`);
      const text = res.text || '';
      const sources = Array.from(text.matchAll(SOURCE_LINE_RE), (m) => m[1]);
      const answer = text.replace(SOURCE_LINE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
      // Unverifiable second-hand prose is exactly what ACCURACY_INSTRUCTION already forbids
      // stating as fact — sources (however incomplete) are what let the model actually
      // follow up with !HTTP_GET on the specific URL it needs, rather than trusting the
      // synthesized answer at face value.
      return { answer, sources };
    } finally {
      await TabManager.closeTabs(tabId);
    }
  }

  // !CALL_<NAME> dispatch: looks the name up against session.externalTools (loaded once by
  // gatherInitialContext), substitutes the model's positional args into the declared
  // command's {argName} placeholders by position, and runs it through the exact same SHELL
  // path a plain !SHELL call would use — same dangerous-command/permission-rule gating,
  // same persistent session. No separate trust tier: these are still just shell commands.
  async function callExternalTool(session, callToolName, args) {
    const name = callToolName.replace(/^CALL_/, '');
    const declared = (session.externalTools || []).find((t) => t.name.toUpperCase() === name);
    if (!declared) {
      throw new Error(`No external tool named "${name}" is declared in .myclaudecode/tools.json.`);
    }
    const declaredArgs = Array.isArray(declared.args) ? declared.args : [];
    let command = declared.command;
    declaredArgs.forEach((argName, i) => {
      command = command.split(`{${argName}}`).join(args[i] != null ? args[i] : '');
    });
    return NativeBridge.execTool(session.taskId, TOOLS.SHELL, { command });
  }

  async function runToolCalls(session, calls, role) {
    const outputs = [];
    for (const call of calls) {
      session.toolCallCount++;
      notifyCli({
        type: CLI_MESSAGE_TYPES.TOOL_CALL,
        taskId: session.taskId,
        role,
        tool: call.tool,
        params: call.params,
      });

      const preHook = await runHook(session, 'preToolUse', { role, tool: call.tool, params: call.params });
      if (preHook.blocked) {
        const reason = (preHook.stderr || preHook.stdout || '(no output)').trim();
        outputs.push(formatToolResult(call, null, `Blocked by preToolUse hook: ${reason}`));
        notifyCli({
          type: CLI_MESSAGE_TYPES.TOOL_CALL_RESULT,
          taskId: session.taskId,
          role,
          tool: call.tool,
          params: call.params,
          error: `Blocked by preToolUse hook: ${reason}`,
        });
        continue;
      }

      // For a display-only before/after diff (the model itself never sees this — only
      // formatToolResult's plain summary goes back into the chat). Best-effort: a
      // nonexistent path just means "new file", not a real failure.
      let oldContent = null;
      if (call.tool === TOOLS.WRITE_FILE || call.tool === TOOLS.EDIT_FILE) {
        try {
          oldContent = await NativeBridge.execTool(session.taskId, TOOLS.READ_FILE, { path: call.params.path });
        } catch (_) {
          oldContent = null;
        }
      }
      const toolStartedAt = Date.now();
      try {
        // ASK_USER and SEARCH_WEB never go through the native host's execTool — the former
        // is answered directly by the human via the CLI, the latter needs a real DeepSeek
        // chat tab (see performWebSearch above), neither of which the native host can do.
        const result =
          call.tool === TOOLS.ASK_USER
            ? await askUser(session.taskId, call.params.question, call.params.options)
            : call.tool === TOOLS.SEARCH_WEB
              ? await performWebSearch(session, call.params.query)
              : call.tool === TOOLS.INSPECT_TAB
                ? await (async () => {
                    const inspectResult = await TabManager.inspectTab(call.params.url);
                    let screenshotPath = null;
                    if (inspectResult.screenshotBase64) {
                      const filename = `screenshot_${Date.now()}.b64`;
                      screenshotPath = `.myclaudecode/screenshots/${filename}`;
                      await NativeBridge.execTool(session.taskId, TOOLS.WRITE_FILE, {
                        path: screenshotPath,
                        content: inspectResult.screenshotBase64,
                      }).catch(() => {});
                    }
                    return {
                      errors: inspectResult.errors,
                      screenshotPath,
                      note: screenshotPath ? 'Screenshot saved as base64 at ' + screenshotPath : 'No screenshot captured.',
                    };
                  })()
                : call.tool.startsWith('CALL_')
                  ? await callExternalTool(session, call.tool, call.params.args)
                  : await NativeBridge.execTool(session.taskId, call.tool, call.params);
        notifyCli({
          type: CLI_MESSAGE_TYPES.TIMING,
          taskId: session.taskId,
          phase: 'tool_call',
          role,
          tool: call.tool,
          elapsedMs: Date.now() - toolStartedAt,
        });
        outputs.push(formatToolResult(call, result, null));

        // Layered, path-scoped instructions — fires the first time a file matching a
        // configured rule is read or written this session (see applicableRules above).
        if (call.tool === TOOLS.READ_FILE || call.tool === TOOLS.WRITE_FILE || call.tool === TOOLS.EDIT_FILE) {
          for (const rule of applicableRules(session, call.params.path)) {
            outputs.push(`(project rule — ${rule.file}, applies to ${call.params.path}):\n${rule.body}`);
          }
        }

        // Informational only — postToolUse doesn't gate anything, just observes. A failing
        // hook here is the hook's own problem, not the tool call's; nothing changes for the
        // model or the task based on it.
        await runHook(session, 'postToolUse', { role, tool: call.tool, params: call.params, result });

        // Incremental gates: an onEdit-triggered gate runs scoped to the just-changed file,
        // right in this same turn's tool-result feedback — catching a mistake immediately
        // instead of only at DONE, when a whole subtask's worth of changes would otherwise
        // need re-diagnosing at once. (Planner never reaches here with these tools at all —
        // PLANNER_DISALLOWED_TOOLS filters them out before runToolCalls is ever called.)
        if (call.tool === TOOLS.WRITE_FILE || call.tool === TOOLS.EDIT_FILE) {
          const editGateResult = await runQualityGates(session, 'onEdit', { file: call.params.path });
          if (!editGateResult.passed) {
            outputs.push(`(system) onEdit quality gate '${editGateResult.gate}' failed for ${call.params.path}:\n${editGateResult.output}`);
            notifyCli({
              type: CLI_MESSAGE_TYPES.QUALITY_GATE_FAILED,
              taskId: session.taskId,
              gate: editGateResult.gate,
              output: editGateResult.output,
            });
          }
        }
        // EDIT_FILE's result is just a short summary (never the full file — that would
        // defeat the point of an anchored edit over a whole-file WRITE_FILE) — a second
        // READ_FILE, display-only like oldContent above, gets the real post-edit content
        // for the CLI's diff rendering without it ever going back into the model's chat.
        let editNewContent = null;
        if (call.tool === TOOLS.EDIT_FILE) {
          try {
            editNewContent = await NativeBridge.execTool(session.taskId, TOOLS.READ_FILE, { path: call.params.path });
          } catch (_) {
            editNewContent = null;
          }
        }
        notifyCli({
          type: CLI_MESSAGE_TYPES.TOOL_CALL_RESULT,
          taskId: session.taskId,
          role,
          tool: call.tool,
          params: call.params,
          result,
          ...(call.tool === TOOLS.WRITE_FILE
            ? { oldContent, newContent: call.params.content }
            : call.tool === TOOLS.EDIT_FILE
              ? { oldContent, newContent: editNewContent }
              : {}),
        });
      } catch (err) {
        outputs.push(formatToolResult(call, null, err.message));
        notifyCli({
          type: CLI_MESSAGE_TYPES.TOOL_CALL_RESULT,
          taskId: session.taskId,
          role,
          tool: call.tool,
          params: call.params,
          error: err.message,
        });
      }
    }
    return outputs.join('\n\n');
  }

  // See sendAndTrack's TIMING call — kept short since these ride along on every single turn,
  // not just failures.
  const PROMPT_PREVIEW_MAX = 300;
  const REPLY_PREVIEW_MAX = 200;
  function preview(str, max) {
    const s = str || '';
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }

  // Builds a tabs.js onAttempt callback that reports each individual retry attempt of a
  // sendToTabResilient call as its own TIMING event (phase: 'send_attempt') — see that
  // function's own comment for why this exists. Without this, a turn that needed several
  // retries before finally failing (or succeeding) only ever produced one opaque final
  // elapsedMs number covering the whole retry storm, with no way to tell how many attempts
  // happened or how long each one took.
  function sendAttemptReporter(session, role) {
    return ({ attempt, attempts, elapsedMs, error, diagnostics }) => {
      notifyCli({
        type: CLI_MESSAGE_TYPES.TIMING,
        taskId: session.taskId,
        phase: 'send_attempt',
        role,
        attempt,
        attempts,
        elapsedMs,
        error,
        // See content.js's rejectWithDiagnostics — pollTickCount/foundNewBubble/
        // bubbleCountAtEnd/lastBubbleTextLenAtEnd let a failed attempt be diagnosed instead
        // of just timestamped: e.g. pollTickCount near 0 points at polling being throttled
        // (tab/window backgrounded) rather than DeepSeek actually not replying;
        // foundNewBubble:true with a nonzero lastBubbleTextLenAtEnd but still timing out
        // would point at the button-ready/stabilization logic itself, not bubble detection.
        diagnostics,
      });
    };
  }

  async function sendAndTrack(session, role, text, { instant = false, stall = false } = {}) {
    // A cancelled task (see cancelTask/CANCEL_TASK) must not start yet another turn — the
    // CLI that would ever see its result is already gone. Throwing here (rather than
    // resolving with something callers have to remember to check) routes straight into
    // runTask's existing catch/finally, which cleans the session up the same way any other
    // task-ending error does; notifyCli suppresses the resulting TASK_ERROR from actually
    // reaching a (possibly different) CLI for this taskId.
    if (session.cancelled) throw new Error('Task cancelled.');
    if (stall) {
      const newCount = role === 'planner' ? ++session.plannerStallCount : ++session.executorStallCount;
      if (newCount >= STALL_MIGRATION_THRESHOLD) {
        if (role === 'planner') session.plannerStallCount = 0;
        else session.executorStallCount = 0;
        // Skip sending `text` (another nudge) to the tab that's already stuck — migrate
        // straight to a fresh one and use its response instead. migrate() itself reports
        // the "(system) Migrating..." notice to the CLI, with this specific reason.
        return migrate(session, role, `${newCount} unproductive responses in a row — breaking the loop with a fresh tab`);
      }
    } else {
      // Any non-stall send (real tool results, a dispatched subtask, legitimate
      // gate-failure iteration, a fresh subtask/primer) means real progress happened —
      // reset the streak so it only ever measures *consecutive* unproductive turns.
      if (role === 'planner') session.plannerStallCount = 0;
      else session.executorStallCount = 0;
    }

    // Observed live (2026-08-14): a chat this long (many large diffs/tool results pasted in)
    // hit DeepSeek's own "Length limit reached. Please start a new chat." wall — a hard,
    // permanent stop for that tab, not something waiting or resending fixes. The
    // message-count-based migrationThreshold below exists for the same underlying problem
    // but reacts too late for a chat whose messages happen to be unusually large (a few huge
    // diffs can blow the limit long before 40 messages). Track cumulative characters sent+
    // received per tab and migrate proactively before the real wall, using the same
    // summarize-and-continue machinery — with the reactive "Length limit reached" detection
    // below as a safety net for whenever this estimate runs behind DeepSeek's real limit.
    const charCount = role === 'planner' ? session.plannerCharCount : session.executorCharCount;
    if (charCount + text.length >= session.charBudget) {
      return migrate(session, role, `chat is approaching its length limit (~${charCount + text.length} characters sent) — moving to a fresh tab before it hits the wall`);
    }

    const tabId = role === 'planner' ? session.plannerTabId : session.executorTabId;
    notifyCli({ type: CLI_MESSAGE_TYPES.THINKING_STARTED, taskId: session.taskId, role });
    const sendStartedAt = Date.now();
    const res = await TabManager.sendToTabResilient(
      tabId,
      { action: 'typeAndSend', text, instant },
      { onAttempt: sendAttemptReporter(session, role) }
    );
    // See CLI_MESSAGE_TYPES.TIMING — this is DeepSeek's own reply time plus our
    // send/detect overhead combined (typeAndSend's own promise doesn't separate the two),
    // but it's the number that answers "why did this turn take so long." `diagnostics`
    // (from content.js's waitForAssistantSettle) breaks down WHAT was happening during that
    // time — e.g. timeToFirstTextMs isolates "DeepSeek hadn't started responding at all yet"
    // from "it was still streaming/reasoning," and deepThinkStillReasoning/state/
    // networkErrorRetries/captchaGraceMs point at specific known slow-path causes.
    // promptPreview/replyPreview: the actual text we sent and DeepSeek sent back, previewed
    // (not full — a primer or a large diff can be many KB, and this rides along on every
    // single turn) so the timing line doubles as a record of what prompt produced what
    // response at what speed — previously the only place a reply's *text* was visible was
    // PLANNER_THINKING/EXECUTOR_CODE (a separate, untimed message), and the outgoing prompt
    // was never sent to the CLI at all. This is what actually answers "how is the prompting
    // behaving" instead of just "how long did it take."
    notifyCli({
      type: CLI_MESSAGE_TYPES.TIMING,
      taskId: session.taskId,
      phase: 'tab_reply',
      role,
      elapsedMs: Date.now() - sendStartedAt,
      diagnostics: (res && res.diagnostics) || null,
      promptChars: text.length,
      promptPreview: preview(text, PROMPT_PREVIEW_MAX),
      replyChars: (res && res.text && res.text.length) || 0,
      replyPreview: preview((res && res.text) || '', REPLY_PREVIEW_MAX),
    });
    if (res && res.error) {
      // Reactive safety net for the proactive char-budget check above — if DeepSeek's real
      // limit was hit before our estimate caught it, migrate instead of failing the whole
      // task outright (see content.js's hasLengthLimitReached / tabs.js's NOT_RETRYABLE_RE).
      if (/length limit reached/i.test(res.error)) {
        return migrate(session, role, 'chat hit DeepSeek\'s length limit — moving to a fresh tab');
      }
      // content.js's typeAndSend failed (timeout, missing element, etc.) and reported it
      // via {error} instead of {text} — surface that directly instead of letting callers
      // crash confusingly on undefined text downstream.
      throw new Error(`Failed to send message to ${role} tab: ${res.error}`);
    }
    if (role === 'planner') {
      session.plannerMsgCount++;
      session.plannerCharCount += text.length + (res.text || '').length;
    } else {
      session.executorMsgCount++;
      session.executorCharCount += text.length + (res.text || '').length;
    }

    const count = role === 'planner' ? session.plannerMsgCount : session.executorMsgCount;
    // migrate() sends the summary into a brand-new tab and its return value IS that new
    // tab's real reply — must be returned directly, not discarded, or the caller ends up
    // processing the stale pre-migration tab's response against post-migration session
    // state (wrong tab id, reset message counters), desyncing the conversation.
    if (count >= session.migrationThreshold) {
      return migrate(session, role);
    }
    return res.text;
  }

  async function migrate(session, role, reason = 'approaching the message limit') {
    await runHook(session, 'onMigration', { role, reason });
    notifyCli({
      type: CLI_MESSAGE_TYPES.PLANNER_THINKING,
      taskId: session.taskId,
      text: `(system) Migrating ${role} chat — ${reason}.`,
    });

    const oldTabId = role === 'planner' ? session.plannerTabId : session.executorTabId;
    const count = role === 'planner' ? session.plannerMsgCount : session.executorMsgCount;
    const editIndex = count - 3;

    // Observed live (2026-08-15): a migration triggered while `count` was still small (e.g.
    // right after the tab's very first exchange, when a single oversized tool result alone
    // blew the char budget — see TOOL_RESULT_FIELD_MAX_CHARS above for the matching fix on
    // that side) clamped editIndex to 0 via the old `Math.max(0, count - 3)`. Editing message
    // index 0 means editing the FIRST message ever sent in this tab — which truncates the
    // entire conversation *including* the thing being edited, leaving nothing before it for
    // DeepSeek to summarize from. The model was being asked "summarize everything up to this
    // point" with literally zero prior turns to look at, and understandably had nothing
    // coherent to say — the confusing/context-free reply this was supposed to guard against
    // in the first place. Below a handful of real exchanges, there simply isn't enough
    // conversation yet for a self-summary to mean anything; skip asking for one entirely
    // (leave `summary` unset — the code below already treats an unavailable summary as
    // non-fatal) and rely solely on currentSubtaskSection/taskListSection, which come from
    // the orchestrator's own tracked state, not from asking the model to recall itself.
    const MIN_MESSAGES_FOR_SELF_SUMMARY = 4;

    const migrationPrompt =
      'IGNORE ALL PREVIOUS CONVERSATION UP TO THIS POINT. Summarize all decisions, ' +
      'current state, what has been achieved so far, what remains, and any critical ' +
      'notes. Then provide a concise set of instructions for a new AI to continue from ' +
      'exactly this point. Do not include any other text.';

    // Observed live (2026-08-14): when migrating BECAUSE the old tab hit DeepSeek's length
    // limit, asking that same (already-full) tab to summarize itself can itself fail — or,
    // worse, silently "succeed" with a near-empty/context-free reply, since editing an
    // earlier message and resubmitting discards everything after it (including the very
    // content the summary needed to reference). Either way the new tab ended up asking "what
    // task should I work on?" with zero context. Never let a failed/weak summary be the ONLY
    // continuity mechanism — best-effort it, and fall back to a placeholder rather than
    // throwing (which would fail the whole task over what's fundamentally a nice-to-have).
    let summary;
    const summarizeStartedAt = Date.now();
    if (count < MIN_MESSAGES_FOR_SELF_SUMMARY) {
      summary = '(not requested — too little conversation yet in the previous chat to meaningfully summarize)';
      notifyCli({
        type: CLI_MESSAGE_TYPES.TIMING,
        taskId: session.taskId,
        phase: 'migration_summarize',
        role,
        elapsedMs: Date.now() - summarizeStartedAt,
        diagnostics: { skipped: true, count },
      });
    } else
    try {
      const editRes = await TabManager.sendToTabResilient(
        oldTabId,
        { action: 'editMessage', index: editIndex, newText: migrationPrompt },
        { onAttempt: sendAttemptReporter(session, role) }
      );
      summary =
        editRes && editRes.error
          ? `(unavailable — could not summarize the previous chat: ${editRes.error})`
          : editRes.text;
      notifyCli({
        type: CLI_MESSAGE_TYPES.TIMING,
        taskId: session.taskId,
        phase: 'migration_summarize',
        role,
        elapsedMs: Date.now() - summarizeStartedAt,
        diagnostics: (editRes && editRes.diagnostics) || null,
      });
    } catch (err) {
      summary = `(unavailable — could not summarize the previous chat: ${err.message})`;
      notifyCli({
        type: CLI_MESSAGE_TYPES.TIMING,
        taskId: session.taskId,
        phase: 'migration_summarize',
        role,
        elapsedMs: Date.now() - summarizeStartedAt,
        error: err.message,
      });
    }

    await TabManager.closeTabs(oldTabId);
    const newTabId =
      role === 'planner' ? await TabManager.createPlannerTab(session.taskId) : await TabManager.createExecutorTab(session.taskId);
    await TabManager.waitForReady(newTabId);

    if (role === 'planner') {
      session.plannerTabId = newTabId;
      session.plannerMsgCount = 0;
      session.plannerCharCount = 0;
    } else {
      session.executorTabId = newTabId;
      session.executorMsgCount = 0;
      session.executorCharCount = 0;
    }

    const primer = role === 'planner' ? plannerPrimer(session.requirePlanApproval) : EXECUTOR_PRIMER;
    // The task list (readme.md section 8) is what actually survives a migration intact —
    // the chat's own "Previous summary" above is a model-written paraphrase, prone to
    // dropping detail; re-injecting the real tracked entries for the planner specifically
    // (the executor doesn't own the plan) closes the gap a migration would otherwise leave.
    let taskListSection = '';
    if (role === 'planner') {
      const tasks = await NativeBridge.execTool(session.taskId, TOOLS.TASK_LIST, {}).catch(() => []);
      if (tasks && tasks.length) {
        const rendered = tasks.map((t) => `- [${t.status}] ${t.text}`).join('\n');
        taskListSection = `\n\nTracked task list so far:\n${rendered}`;
      }
    }
    // Executor-side equivalent of taskListSection above: the orchestrator already knows
    // exactly what subtask is currently in flight (it dispatched it) — re-stating that
    // directly guarantees the new tab knows its actual job even if the tab-generated
    // `summary` above came back empty or unhelpful.
    const currentSubtaskSection =
      role === 'executor' && session.currentSubtaskText
        ? `\n\nThe subtask you were given (still in progress, not yet done):\n${session.currentSubtaskText}`
        : '';
    // Same reasoning as the initial executor primer (see gatherInitialContext/runTask) — a
    // fresh post-migration executor tab starts with zero knowledge of the project's
    // directory structure otherwise, and re-discovering it via its own !LS/!SHELL calls
    // (wrong relative paths, "File not found," guessing at subfolder names) is exactly the
    // kind of wasted, confused turn a migration is supposed to recover FROM, not add more
    // of. Already capped at the source (see FILE_LIST_INJECT_BUDGET) — safe to reuse as-is.
    const fileListSection = role === 'executor' && session.fileList ? `\n\nProject files:\n${session.fileList}` : '';
    // Same reasoning as fileListSection immediately above, for the same class of fact: OS/
    // shell/project-root shouldn't need re-discovering just because the tab is new. Cheap —
    // session.os/envInfo/projectRoot are all already-known session state, no extra tool call.
    const envSection = buildEnvironmentSection(session);
    return sendAndTrack(
      session,
      role,
      `${primer}\n\nPrevious summary:\n${summary}${taskListSection}${currentSubtaskSection}${fileListSection}${envSection}\n\nContinue from here.`,
      { instant: true }
    );
  }

  // Each gate normalizes to { command, trigger }. A plain string (the original config
  // shape) defaults to 'onComplete' — the only trigger that existed before this — so
  // existing config.json files keep behaving exactly as they did with zero changes.
  function normalizeGates(rawGates) {
    return (rawGates || []).map((g) =>
      typeof g === 'string' ? { command: g, trigger: 'onComplete' } : { command: g.command, trigger: g.trigger || 'onComplete' }
    );
  }

  // trigger selects which gates run: 'onEdit' (right after a single WRITE_FILE/EDIT_FILE,
  // scoped to that file), 'onSubtask' (after a subtask finishes, before the planner sees the
  // summary), or 'onComplete' (the original behavior — before DONE/ALL_DONE is accepted).
  // `{file}` in a gate's command is substituted with the changed path for onEdit gates
  // (e.g. `eslint {file}`) — left untouched if the gate doesn't use the placeholder.
  async function runQualityGates(session, trigger = 'onComplete', { file } = {}) {
    const gates = session.qualityGates.filter((g) => g.trigger === trigger);
    if (!gates.length) return { passed: true };
    for (const gate of gates) {
      const command = file ? gate.command.replace(/\{file\}/g, file) : gate.command;
      const result = await NativeBridge.execTool(session.taskId, 'SHELL', { command, stateless: true });
      if (result.exitCode !== 0) {
        const gateResult = { passed: false, gate: command, output: `${result.stdout}\n${result.stderr}`.trim() };
        await runHook(session, 'onGateResult', { trigger, ...gateResult });
        return gateResult;
      }
    }
    const gateResult = { passed: true };
    await runHook(session, 'onGateResult', { trigger, ...gateResult });
    return gateResult;
  }

  async function runExecutorSubtask(session, subtask) {
    let text = await sendAndTrack(session, 'executor', subtask);
    let retries = 0;
    // Guards against a real model just saying "DONE" without ever having done anything —
    // observed in practice (it described code in prose, got nudged, then replied bare
    // "DONE" with no tool call at all). Deliberately accepts ANY real tool call, not just
    // a mutating one (WRITE_FILE/SHELL) — an earlier version required specifically a
    // mutation, which broke on genuinely read-only subtasks ("read this file and report
    // its contents"): the executor correctly did the read, got told nothing had "really"
    // happened, and started inventing busywork to satisfy the guard — up to and including
    // overwriting a real file with empty/garbage content purely to have *something*
    // mutating to point to. The actual failure mode this guards against is pure
    // fabrication (zero tool calls at all), not "didn't happen to write anything this
    // particular subtask."
    let tookRealAction = false;
    // See summarizeSubtaskTranscript's comment — carried back to the planner alongside the
    // final DONE text so it has real evidence, not just the executor's own claim.
    const transcript = [];

    while (true) {
      notifyCli({
        type: CLI_MESSAGE_TYPES.EXECUTOR_CODE,
        taskId: session.taskId,
        summary: text,
      });

      // Run any tool calls embedded in this message BEFORE evaluating DONE — a capable
      // real model (unlike our scripted mock turns) will often write the file and report
      // DONE in the same response. But real ones observed writing DONE *and fabricated,
      // invented "Output:" text for every tool call in that same breath, then concluding
      // from its own fiction* — before our system had ever gotten a chance to run the real
      // commands and show it the truth. So: whenever a message contains tool calls, its
      // completion claim is NEVER trusted in that same turn, full stop — the real results
      // always go back first, and DONE is only evaluated on a later message that contains
      // no fresh tool calls of its own (i.e. one that's actually reacting to real data).
      const calls = ToolCallParser.parseToolCalls(text);
      const corruptedCall = ToolCallParser.hasCorruptedToolCall(text);
      if (calls.length) {
        tookRealAction = true;
      }

      if (calls.length || corruptedCall) {
        let toolResultText = calls.length ? await runToolCalls(session, calls, 'executor') : '';
        if (toolResultText) transcript.push(toolResultText);
        if (corruptedCall) toolResultText = appendCorruptionNote(toolResultText);
        // Only a pure-corruption turn (no real calls at all) counts as unproductive — a
        // turn with real calls is progress even if a corrupted one rode along with them.
        text = await sendAndTrack(session, 'executor', toolResultText, { stall: calls.length === 0 });
        continue;
      }

      if (ToolCallParser.isDone(text) && !tookRealAction) {
        text = await sendAndTrack(
          session,
          'executor',
          // Observed live (2026-08-15): this example list only ever named 4 of the
          // executor's 15 tools (see EXECUTOR_PRIMER for the full set) — not wrong (it's an
          // "e.g.", not an exhaustive list), but a short list read as a strong hint about
          // which tools actually count, and a model nudged with only READ_FILE/LS/
          // WRITE_FILE/SHELL as examples may not think to reach for !OPEN_APP (e.g. actually
          // opening a built page to confirm it renders) as a legitimate way to verify work.
          // Rounded out with one example from each broad category — read, write, edit,
          // run, search, open, network-check — so the "verify with a real tool" nudge
          // doesn't itself bias which kind of tool the executor reaches for. The two least
          // self-descriptive names (OPEN_APP, HTTP_GET — unlike READ_FILE/SHELL/GREP, which
          // are conventional enough to need no explanation) get a few-word parenthetical
          // right here, since a quick system nudge like this is exactly the kind of place a
          // model skims past an unfamiliar bare name rather than stopping to recall what it
          // does from the (much longer, seen only once) primer.
          "(system) You haven't actually run any !TOOL yet for this subtask, so nothing has been verified. Please use a real tool (e.g. !READ_FILE, !LS, !WRITE_FILE, !EDIT_FILE, !SHELL, !GREP, !OPEN_APP [open/launch a file, URL, or app to check it], !HTTP_GET [fetch a URL to confirm a server responds]) to actually do or verify the work, then reply DONE.",
          { stall: true }
        );
        continue;
      }

      if (ToolCallParser.isDone(text)) {
        const gateResult = await runQualityGates(session);
        if (gateResult.passed) {
          return text + summarizeSubtaskTranscript(transcript);
        }
        retries++;
        notifyCli({
          type: CLI_MESSAGE_TYPES.QUALITY_GATE_FAILED,
          taskId: session.taskId,
          gate: gateResult.gate,
          output: gateResult.output,
        });
        if (retries > session.maxRetries) {
          return `DONE (with unresolved quality-gate failures after ${session.maxRetries} retries)\n${gateResult.output}` +
            summarizeSubtaskTranscript(transcript);
        }
        text = await sendAndTrack(
          session,
          'executor',
          `(system) Quality gate '${gateResult.gate}' failed with the following output:\n${gateResult.output}\nPlease fix the errors and reply DONE again when resolved.`
        );
        continue;
      }

      // No tool calls and not DONE — either it showed code without saving it, it mentioned
      // a tool without actually invoking it (e.g. narrated "!SHELL ..." mid-sentence instead
      // of as its own line), or it just needs a nudge to keep going.
      if (/```/.test(text)) {
        // Common failure mode with real models: they show code in prose instead of
        // actually issuing !WRITE_FILE, so nothing gets saved. Call that out specifically
        // rather than a generic nudge, which models tend to satisfy by just saying DONE.
        text = await sendAndTrack(
          session,
          'executor',
          "(system) I see code in your last message, but no !WRITE_FILE (or !SHELL) command was issued, so nothing was actually saved to disk. Please issue !WRITE_FILE <path> followed by a fenced code block with that exact content, then reply DONE.",
          { stall: true }
        );
      } else if (ToolCallParser.mentionsUncalledTool(text)) {
        text = await sendAndTrack(
          session,
          'executor',
          '(system) It looks like you mentioned a !TOOL command but it was not formatted as its own line, so it was not actually run. Please issue it as the very first thing on a line by itself (e.g. `!SHELL mkdir sandbox && cd sandbox`), then reply DONE.',
          { stall: true }
        );
      } else {
        text = await sendAndTrack(session, 'executor', '(system) Please continue with the subtask or reply DONE.', { stall: true });
      }
    }
  }

  // Human-curated project conventions, the same idea as Claude Code's CLAUDE.md — a place
  // to pre-seed framework choices, file layout, and style rules so the planner doesn't
  // have to (unreliably) rediscover them by exploring, or just guess and mismatch the
  // existing codebase. Checked in this order; first one found wins.
  const CONVENTIONS_FILENAMES = ['CLAUDE.md', 'AGENTS.md', '.myclaudecode/CONVENTIONS.md'];

  async function readFirstExisting(taskId, filenames) {
    for (const path of filenames) {
      try {
        return await NativeBridge.execTool(taskId, 'READ_FILE', { path });
      } catch (_) {
        // try the next candidate
      }
    }
    return null;
  }

  // Memory used to be overwritten wholesale on every [MEMORY_UPDATE] — the planner's most
  // recent summary of "everything worth remembering," discarding whatever came before it.
  // Appending dated entries instead means older decisions survive later updates; the size
  // cap (dropping the OLDEST entries first once exceeded) is what actually forces curation,
  // rather than letting the file grow forever across a long-lived project.
  const MEMORY_MAX_CHARS = 8000;

  async function appendMemory(taskId, entryText) {
    let existing = '';
    try {
      existing = await NativeBridge.execTool(taskId, 'READ_FILE', { path: '.myclaudecode/memory.md' });
    } catch (_) {
      existing = '';
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const combinedRaw = `${existing}\n## Update (${stamp})\n${entryText.trim()}\n`;

    let combined = combinedRaw;
    if (combined.length > MEMORY_MAX_CHARS) {
      const sections = combined.split(/(?=\n## Update )/);
      while (sections.length > 1 && sections.join('').length > MEMORY_MAX_CHARS) {
        sections.shift();
      }
      combined = sections.join('');
    }

    await NativeBridge.execTool(taskId, 'WRITE_FILE', { path: '.myclaudecode/memory.md', content: combined });
  }

  // !LS is a single directory level, never recursive (native-host/lib/tools.js's ls() is a
  // plain fs.readdirSync, one line per entry) — normally small, but capped anyway before
  // it's injected into ANY primer (initial or post-migration): per live feedback
  // (2026-08-15), the same day this file-list injection was added, an unusually flat/wide
  // project root feeding an oversized fileList into every fresh executor tab's primer would
  // itself eat into the same message-budget that triggers migration — the opposite of this
  // change's actual goal (fewer confused, path-guessing turns), and a real risk of
  // contributing to the exact migrate-into-migrate loop the char-budget work earlier fixed.
  const FILE_LIST_INJECT_BUDGET = 3000;

  function capFileList(fileList) {
    const s = String(fileList || '');
    if (s.length <= FILE_LIST_INJECT_BUDGET) return s;
    return `${s.slice(0, FILE_LIST_INJECT_BUDGET)}\n…(${s.length - FILE_LIST_INJECT_BUDGET} more characters — !LS a specific subfolder to see the rest)`;
  }

  async function gatherInitialContext(session) {
    const fileList = capFileList(await NativeBridge.execTool(session.taskId, 'LS', { path: '.' }));
    let memory = '(No entries yet.)';
    try {
      memory = await NativeBridge.execTool(session.taskId, 'READ_FILE', { path: '.myclaudecode/memory.md' });
    } catch (_) {
      // memory.md not created yet — fine, use default
    }
    const conventions = await readFirstExisting(session.taskId, CONVENTIONS_FILENAMES);
    // Loaded once per session (not per file touch) — matched against every subsequent
    // READ_FILE/WRITE_FILE/EDIT_FILE path client-side (see applicableRules), so a rule
    // costs nothing until a matching file is actually touched.
    session.projectRules = await NativeBridge.execTool(session.taskId, TOOLS.LOAD_RULES, {}).catch(() => []);
    session.externalTools = await NativeBridge.execTool(session.taskId, TOOLS.LOAD_EXTERNAL_TOOLS, {}).catch(() => []);
    // Ground truth from native-host (see TOOLS.ENV_INFO) on which shell resolvePersistentShell()
    // actually picked for THIS machine — falls back to null (buildOsSection then reasons from
    // session.os/process.platform alone) rather than failing the whole task if this one
    // best-effort call has a problem.
    session.envInfo = await NativeBridge.execTool(session.taskId, TOOLS.ENV_INFO, {}).catch(() => null);
    return { fileList, memory, conventions };
  }

  // Declarations compete for the same message-budget that triggers migration (readme.md
  // section 9) — the same reason Claude Code defers MCP tool definitions behind tool search
  // instead of listing every one up front. A hard character cap here is the equivalent
  // guardrail available without that infrastructure: list tools until the budget runs out,
  // note how many got cut off, and stop — never silently truncate mid-description.
  const EXTERNAL_TOOLS_DESCRIPTION_BUDGET = 1500;

  function buildExternalToolsSection(externalTools) {
    if (!externalTools || !externalTools.length) return '';
    const lines = [];
    let used = 0;
    let shown = 0;
    for (const t of externalTools) {
      const argsList = Array.isArray(t.args) ? t.args.join(' ') : '';
      const line = `- !CALL_${t.name.toUpperCase()} ${argsList} — ${t.description || '(no description)'}`;
      if (used + line.length > EXTERNAL_TOOLS_DESCRIPTION_BUDGET) break;
      lines.push(line);
      used += line.length;
      shown++;
    }
    const omitted = externalTools.length - shown;
    const omittedNote = omitted > 0 ? `\n(${omitted} more external tool(s) omitted — description budget reached.)` : '';
    return `\n\nProject-declared external tools (.myclaudecode/tools.json), call as shown:\n${lines.join('\n')}${omittedNote}`;
  }

  // Same simple glob semantics as native-host tools.js's globMatch (kept independently here
  // since orchestrator.js runs in the extension/browser context, without Node's `path`/regex
  // helpers being the concern — this is plain JS, no Node-specific API needed).
  function matchesRulePath(pattern, relPath) {
    const normalized = String(relPath || '').replace(/\\/g, '/');
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i').test(normalized);
  }

  // Each matching rule fires only once per session (the first time a matching path is
  // touched) — re-showing the same rule on every subsequent touch of the same file would
  // just be noise eating into the same message budget the rule system exists to protect.
  function applicableRules(session, relPath) {
    if (!session.projectRules || !session.projectRules.length || !relPath) return [];
    const matches = session.projectRules.filter(
      (r) => !session.injectedRuleFiles.has(r.file) && r.paths.some((p) => matchesRulePath(p, relPath))
    );
    for (const r of matches) session.injectedRuleFiles.add(r.file);
    return matches;
  }

  async function runTask(taskId, task, options, config, permissions, projectRoot) {
    const session = newSession(taskId, task, options, config, permissions, projectRoot);
    try {
      session.state = 'init';

      let resumed = false;
      if (options.resume) {
        const saved = await loadSavedSession(projectRoot);
        if (saved && (await tabStillAlive(saved.plannerTabId)) && (await tabStillAlive(saved.executorTabId))) {
          session.plannerTabId = saved.plannerTabId;
          session.executorTabId = saved.executorTabId;
          session.plannerMsgCount = saved.plannerMsgCount;
          session.executorMsgCount = saved.executorMsgCount;
          resumed = true;
          notifyCli({
            type: CLI_MESSAGE_TYPES.PLANNER_THINKING,
            taskId,
            text: `(system) Resumed existing session for this project (previous taskId=${saved.taskId}).`,
          });
        } else if (saved) {
          await clearSavedSession(projectRoot);
          notifyCli({
            type: CLI_MESSAGE_TYPES.PLANNER_THINKING,
            taskId,
            text: '(system) --resume requested, but the saved session\'s tabs are gone. Starting a fresh session instead.',
          });
        } else {
          notifyCli({
            type: CLI_MESSAGE_TYPES.PLANNER_THINKING,
            taskId,
            text: '(system) --resume requested, but no saved session was found for this project. Starting a fresh session instead.',
          });
        }
      }

      if (!resumed) {
        // Previously invisible — see this session's TIMING comment. Tab creation +
        // waitForReady (which itself can retry a reload up to 10 times over ~2.5 minutes per
        // tab if the page is slow to hydrate or the network drops) happens before the
        // planner's very first sendAndTrack call, so none of it was ever captured by a
        // TIMING event; a slow run here just looked like silence in the log.
        const tabSetupStartedAt = Date.now();
        session.plannerTabId = await TabManager.createPlannerTab(taskId);
        session.executorTabId = await TabManager.createExecutorTab(taskId);
        await TabManager.waitForReady(session.plannerTabId);
        await TabManager.waitForReady(session.executorTabId);
        notifyCli({
          type: CLI_MESSAGE_TYPES.TIMING,
          taskId,
          phase: 'tab_setup',
          elapsedMs: Date.now() - tabSetupStartedAt,
        });
      }
      session.plannerReady = true;
      session.executorReady = true;

      // Selector self-test canary — best-effort, one-shot, never blocks or fails the task
      // (see TabManager.checkSelectors). Surfaces a real-site DOM/markup change as an
      // immediate, specific warning instead of a confusing downstream timeout partway
      // through the actual work.
      const [plannerMissing, executorMissing] = await Promise.all([
        TabManager.checkSelectors(session.plannerTabId),
        TabManager.checkSelectors(session.executorTabId),
      ]);
      for (const [role, missing] of [['planner', plannerMissing], ['executor', executorMissing]]) {
        if (missing.length) {
          notifyCli({
            type: CLI_MESSAGE_TYPES.PLANNER_THINKING,
            taskId,
            text: `(system) WARNING: the ${role} tab is missing expected page element(s) (${missing.join(', ')}) — chat.deepseek.com's markup may have changed. The task will likely fail or stall; check the tab manually if so.`,
          });
        }
      }

      if (options.webSearch) {
        await TabManager.sendToTabResilient(session.plannerTabId, { action: 'toggleWebSearch', enabled: true });
        await TabManager.sendToTabResilient(session.executorTabId, { action: 'toggleWebSearch', enabled: true });
      }
      if (options.deepThink) {
        await TabManager.sendToTabResilient(session.plannerTabId, { action: 'toggleDeepThink', enabled: true });
        await TabManager.sendToTabResilient(session.executorTabId, { action: 'toggleDeepThink', enabled: true });
      }

      session.state = 'planning';
      let plannerText;

      if (resumed) {
        // Reattaching only ever reaches here for a session that was itself successfully
        // saved — and saving now requires primed:true (see the finally block below) — so
        // trusting the existing chat's context as already-primed is safe by construction.
        session.primed = true;
        // The existing chat already has full context — no re-priming, just hand it the
        // new task directly, the same way a human would continue a real conversation.
        plannerText = await sendAndTrack(session, 'planner', `New task from the user: ${task}`, {
          instant: true,
        });
      } else {
        const contextStartedAt = Date.now();
        const { fileList, memory, conventions } = await gatherInitialContext(session);
        // Cached on the session (not just this local variable) so migrate()'s fresh executor
        // tab can reuse it too — see its own primer construction below.
        session.fileList = fileList;
        notifyCli({
          type: CLI_MESSAGE_TYPES.TIMING,
          taskId,
          phase: 'gather_context',
          elapsedMs: Date.now() - contextStartedAt,
        });
        const conventionsSection = conventions
          ? `\n\nProject conventions (from CLAUDE.md/AGENTS.md — follow these):\n${conventions}`
          : '';
        const externalToolsSection = buildExternalToolsSection(session.externalTools);
        // session.envInfo was just populated by gatherInitialContext above (it's on the
        // same session object) — safe to read here.
        const envSection = buildEnvironmentSection(session);
        const initialPlannerMessage =
          `${plannerPrimer(session.requirePlanApproval)}\n\nUser task: ${task}\n\nProject files:\n${fileList}\n\n` +
          `Project memory:\n${memory}${conventionsSection}${envSection}`;

        // No human types a system-priming message live — paste it instantly. External tool
        // declarations go to the executor only — it's the one that actually runs commands.
        // Deliberately not routed through sendAndTrack (this isn't a tracked turn — no reply
        // is expected yet, just confirmation the paste+send itself went through), so it needs
        // its own TIMING wrap — previously this could be a multi-minute paste-and-settle on a
        // large primer with zero visibility, same blind spot as tab_setup above.
        //
        // Observed live (2026-08-15): the planner gets this same `fileList` in its own first
        // message (above), but the executor — the one actually running !LS/!SHELL/!READ_FILE
        // against real paths — never did, so its first move on a real, unfamiliar project was
        // always to spend several of its own turns rediscovering the directory structure by
        // trial and error (wrong relative paths, "File not found," guessing at subfolder
        // names) before it could do anything useful. Reusing the SAME already-fetched
        // `fileList` here costs nothing extra (no second !LS call) and means the executor
        // starts every fresh subtask — and every post-migration fresh tab — already knowing
        // the shape of the project instead of re-discovering it from scratch each time.
        const fileListSection = `\n\nProject files:\n${fileList}`;
        const primerStartedAt = Date.now();
        const primerText = EXECUTOR_PRIMER + fileListSection + conventionsSection + externalToolsSection + envSection;
        const primerRes = await TabManager.sendToTabResilient(
          session.executorTabId,
          { action: 'typeAndSend', text: primerText, instant: true },
          { onAttempt: sendAttemptReporter(session, 'executor') }
        );
        notifyCli({
          type: CLI_MESSAGE_TYPES.TIMING,
          taskId,
          phase: 'executor_primer',
          role: 'executor',
          elapsedMs: Date.now() - primerStartedAt,
          promptChars: primerText.length,
        });
        if (primerRes && primerRes.error) {
          throw new Error(`Failed to send executor primer: ${primerRes.error}`);
        }
        session.executorMsgCount++;

        plannerText = await sendAndTrack(session, 'planner', initialPlannerMessage, { instant: true });
        // Both halves of initial setup (executor primer confirmed sent, planner's first
        // exchange got a real response) genuinely completed — only now is this session
        // safe to persist/resume later.
        session.primed = true;
      }

      let allDoneGateRetries = 0;

      while (true) {
        notifyCli({
          type: CLI_MESSAGE_TYPES.PLANNER_THINKING,
          taskId,
          text: plannerText,
        });

        const memoryUpdate = ToolCallParser.extractMemoryUpdate(plannerText);
        if (memoryUpdate) {
          await appendMemory(taskId, memoryUpdate);
        }

        // Run any embedded tool calls before evaluating ALL_DONE/[SUBTASK] — and if there
        // were any, ALWAYS defer to a follow-up turn rather than trusting whatever the
        // planner claimed in the same breath as tool calls whose real results it hasn't
        // seen yet. Observed live: a model can write !LS/!READ_FILE calls, fabricate
        // plausible-looking "Output:" text for all of them in the same message, and
        // conclude ALL_DONE from its own invented data — before our system ever got to
        // run the real commands and show it the truth. See the matching comment in
        // runExecutorSubtask for the executor-side version of this same fix.
        const parsedCalls = ToolCallParser.parseToolCalls(plannerText);
        const corruptedCall = ToolCallParser.hasCorruptedToolCall(plannerText);
        // Split out executor-only tools (WRITE_FILE/SHELL/DELETE_FILE/OPEN_APP) — see
        // PLANNER_DISALLOWED_TOOLS above. Never executed for the planner, no exceptions.
        const calls = parsedCalls.filter((c) => !isPlannerDisallowed(c.tool));
        const disallowedCalls = parsedCalls.filter((c) => isPlannerDisallowed(c.tool));
        if (calls.length || disallowedCalls.length || corruptedCall) {
          let resultText = calls.length ? await runToolCalls(session, calls, 'planner') : '';
          if (disallowedCalls.length) {
            const skipped = disallowedCalls.map((c) => `!${c.tool}`).join(', ');
            const note = `${PLANNER_DELEGATE_NOTE} (skipped: ${skipped})`;
            resultText = resultText ? `${resultText}\n\n${note}` : note;
          }
          if (corruptedCall) resultText = appendCorruptionNote(resultText);
          // Same reasoning as the executor side: only a turn with zero real, allowed
          // progress counts as unproductive.
          plannerText = await sendAndTrack(session, 'planner', resultText, { stall: calls.length === 0 });
          continue;
        }

        // Plan-approval gate (opt-in, config.requirePlanApproval — see plannerPrimer). Fires
        // the instant a [PLAN] block shows up, regardless of whether a [SUBTASK] rode along
        // in the same message (a real model doesn't always wait the way it's instructed to);
        // approval falls through to the normal handling below so a bundled subtask still
        // dispatches this same turn rather than wasting a round-trip.
        if (session.requirePlanApproval && !session.planApproved) {
          const planText = ToolCallParser.extractPlan(plannerText);
          if (planText) {
            const answer = await askUser(
              session.taskId,
              `The planner proposes this plan before starting work. Approve it?\n\n${planText}`,
              ['Approve', 'Reject']
            );
            if (/^approve|^y(es)?$/i.test(answer.trim())) {
              session.planApproved = true;
              notifyCli({ type: CLI_MESSAGE_TYPES.PLANNER_THINKING, taskId, text: '(system) Plan approved — proceeding.' });
              // fall through — the rest of this turn (a bundled [SUBTASK], if any) is
              // still handled below using this same plannerText.
            } else {
              plannerText = await sendAndTrack(
                session,
                'planner',
                `(system) The user did not approve this plan (feedback: "${answer}"). Revise it and present it again with [PLAN]...[/PLAN] before dispatching any [SUBTASK].`,
                { stall: true }
              );
              continue;
            }
          }
        }

        // Check for a fresh [SUBTASK] dispatch BEFORE trusting ALL_DONE. A real model can
        // cram an entire (sometimes fabricated) run — subtask tags, invented "execution"
        // narration, and a closing ALL_DONE — into one single message before our system
        // ever gets a turn to intervene. If a subtask tag is present, always dispatch it for
        // real and defer judgment; ALL_DONE is only trusted on a message with no fresh
        // subtask of its own, i.e. one actually reacting to real executor results.
        const subtaskBeforeDone = ToolCallParser.extractSubtask(plannerText);
        if (subtaskBeforeDone) {
          // Reached the point of dispatching real work without a plan ever having been
          // presented/approved at all (the model skipped [PLAN] entirely) — block it here
          // rather than at the top, since a message that's ONLY a [PLAN] (no subtask,
          // handled above) must never hit this nudge.
          if (session.requirePlanApproval && !session.planApproved) {
            plannerText = await sendAndTrack(
              session,
              'planner',
              '(system) Before dispatching any [SUBTASK], present your plan first with [PLAN]...[/PLAN] and wait for approval.',
              { stall: true }
            );
            continue;
          }

          const normalized = subtaskBeforeDone.trim().replace(/\s+/g, ' ').toLowerCase();
          const isRepeat = !!normalized && normalized === session.lastSubtaskText;
          session.lastSubtaskText = normalized;
          // Original casing/text (lastSubtaskText above is lowercased, only for repeat-
          // detection) — see migrate()'s executor fallback context for why this is kept.
          session.currentSubtaskText = subtaskBeforeDone;
          session.repeatedSubtaskCount = isRepeat ? session.repeatedSubtaskCount + 1 : 1;

          if (session.repeatedSubtaskCount >= REPEATED_SUBTASK_THRESHOLD) {
            session.repeatedSubtaskCount = 0; // don't refire every single turn if it keeps trying
            plannerText = await sendAndTrack(session, 'planner', REPEATED_SUBTASK_NOTE, { stall: true });
            continue;
          }

          session.state = 'executing';
          await runHook(session, 'onSubtaskDispatch', { subtask: subtaskBeforeDone });
          // Persistent structured task list (readme.md section 8) — maintained automatically
          // from this same dispatch/finish lifecycle rather than a model-facing tool, so it
          // stays accurate without depending on the model remembering to call one. Best-
          // effort: a failure here just means this subtask isn't tracked in tasks.json, not
          // that the task itself fails.
          const taskListEntry = await NativeBridge.execTool(session.taskId, TOOLS.TASK_UPSERT, {
            text: subtaskBeforeDone,
            status: 'in_progress',
          }).catch(() => null);
          notifyCli({
            type: CLI_MESSAGE_TYPES.SUBTASK_STARTED,
            taskId,
            subtask: subtaskBeforeDone,
          });
          const subtaskSummary = await runExecutorSubtask(session, subtaskBeforeDone);

          const subtaskGateResult = await runQualityGates(session, 'onSubtask');
          if (!subtaskGateResult.passed) {
            notifyCli({
              type: CLI_MESSAGE_TYPES.QUALITY_GATE_FAILED,
              taskId,
              gate: subtaskGateResult.gate,
              output: subtaskGateResult.output,
            });
          }

          if (taskListEntry) {
            await NativeBridge.execTool(session.taskId, TOOLS.TASK_UPSERT, {
              id: taskListEntry.id,
              status: subtaskGateResult.passed ? 'done' : 'failed',
            }).catch(() => {});
          }

          notifyCli({
            type: CLI_MESSAGE_TYPES.SUBTASK_FINISHED,
            taskId,
            summary: subtaskSummary,
          });
          session.state = 'planning';
          // Reported to the planner (not silently retried here) so it can decide whether to
          // fix it as its own next subtask — same "surface it, don't hide it" principle as
          // every other gate trigger.
          const onSubtaskGateNote = subtaskGateResult.passed
            ? ''
            : `\n\n(system) NOTE: onSubtask quality gate '${subtaskGateResult.gate}' failed after this subtask:\n${subtaskGateResult.output}`;

          // Progress-based stall detection — best-effort: a hashing failure (e.g. the
          // native host briefly unavailable) just skips this check for the turn rather
          // than failing the task over an observability feature.
          let noProgressNote = '';
          try {
            const treeHash = await NativeBridge.execTool(session.taskId, TOOLS.HASH_TREE, {});
            const gateOutputSignature = subtaskGateResult.passed ? '' : subtaskGateResult.output;
            const noProgress = treeHash === session.lastTreeHash && gateOutputSignature === session.lastSubtaskGateOutput;
            session.lastTreeHash = treeHash;
            session.lastSubtaskGateOutput = gateOutputSignature;
            session.noProgressStreak = noProgress ? session.noProgressStreak + 1 : 0;
            if (session.noProgressStreak >= NO_PROGRESS_STREAK_THRESHOLD) {
              session.noProgressStreak = 0; // don't refire every turn if it keeps happening
              const guidance = await askUser(
                session.taskId,
                `${NO_PROGRESS_STREAK_THRESHOLD} subtasks in a row have reported success but left the project files unchanged. What should happen next?`,
                ['Let it keep trying', 'Stop and report what has been tried']
              );
              noProgressNote = `\n\n(system) NOTE: ${NO_PROGRESS_STREAK_THRESHOLD} consecutive subtasks made no detectable change to the project. The user was asked and said: "${guidance}"`;
            }
          } catch (_) {
            // best-effort — see comment above
          }

          plannerText = await sendAndTrack(session, 'planner', `Executor finished subtask: ${subtaskSummary}${onSubtaskGateNote}${noProgressNote}`);
          continue;
        }

        if (ToolCallParser.isAllDone(plannerText)) {
          // Quality gates only ran on the executor's DONE until now — but the planner
          // routinely bypasses the executor and writes files itself (observed repeatedly
          // in practice), so ALL_DONE could skip verification entirely. Enforce the same
          // gate here before actually accepting completion.
          const gateResult = await runQualityGates(session);
          if (gateResult.passed) {
            await runHook(session, 'onTaskComplete', { summary: plannerText });
            notifyCli({ type: CLI_MESSAGE_TYPES.TASK_COMPLETED, taskId, summary: plannerText, stats: sessionStats(session) });
            break;
          }
          allDoneGateRetries++;
          notifyCli({
            type: CLI_MESSAGE_TYPES.QUALITY_GATE_FAILED,
            taskId,
            gate: gateResult.gate,
            output: gateResult.output,
          });
          if (allDoneGateRetries > session.maxRetries) {
            const summary = `${plannerText}\n\n(system) NOTE: quality gate '${gateResult.gate}' is still failing after ${session.maxRetries} retries:\n${gateResult.output}`;
            await runHook(session, 'onTaskComplete', { summary });
            notifyCli({
              type: CLI_MESSAGE_TYPES.TASK_COMPLETED,
              taskId,
              summary,
              stats: sessionStats(session),
            });
            break;
          }
          plannerText = await sendAndTrack(
            session,
            'planner',
            `(system) You declared ALL_DONE, but quality gate '${gateResult.gate}' failed:\n${gateResult.output}\nThis must be fixed before the task is actually complete — assign a [SUBTASK] to fix it, or fix it directly, then reply ALL_DONE again once resolved.`
          );
          continue;
        }

        // No tool calls, no fresh [SUBTASK] (checked above, before ALL_DONE), no ALL_DONE —
        // just needs a nudge.
        plannerText = ToolCallParser.mentionsUncalledTool(plannerText)
          ? await sendAndTrack(
              session,
              'planner',
              '(system) It looks like you mentioned a !TOOL command but it was not formatted as its own line, so it was not actually run. Please issue it as the very first thing on a line by itself, then continue.',
              { stall: true }
            )
          : await sendAndTrack(
              session,
              'planner',
              '(system) Please assign a [SUBTASK], use a tool, or reply ALL_DONE.',
              { stall: true }
            );
      }

      session.state = 'done';
    } catch (err) {
      console.error('[Orchestrator] task error', err);
      notifyCli({ type: CLI_MESSAGE_TYPES.TASK_ERROR, taskId, message: err.message, stats: sessionStats(session) });
      session.state = 'error';
    } finally {
      // Tabs are left open in every case now, not just on error — a completed session is
      // persisted so a later `--resume` run can reattach to the actual same conversation.
      // Closing them automatically was also what made the "tab never became ready" failure
      // mode undebuggable in the first place; that reasoning still applies here.
      //
      // Requiring primed:true (not just non-null tab IDs) matters specifically for a
      // failure DURING initial setup: observed live (2026-08-11) — the executor primer send
      // failed, but the session got saved anyway (tab IDs were already assigned), and a
      // follow-up typed in the REPL defaults to --resume-style reattachment; it found the
      // tabs still alive, trusted them as already-primed, and skipped re-priming entirely —
      // leaving a genuinely unprimed executor to receive a real subtask with no idea what
      // its role or tool protocol was, and it predictably fell back to asking a generic
      // clarifying question instead of using !TOOL syntax. A session that never finished
      // priming is never useful to resume, so it's simply never saved — a later attempt
      // finds no saved session and correctly starts over with fresh tabs instead.
      if (session.primed && session.plannerTabId != null && session.executorTabId != null) {
        await saveSession(session);
      }
      sessions.delete(taskId);
    }
  }

  return { runTask, closeSession, answerQuestion, cancelTask, sessions };
})();
