// The brain's decisions (Phase 5 of the phased-mode rollout). Owns:
//   - triage()       -- initial triage turn, parses response
//   - runDirect()    -- direct-mode loop, escalates on exhausted retries
//   - escalate()     -- re-triage after direct-mode failure
//   - ping()         -- batch-summary brain turn, parses [CONTINUE]/[REVISE]/[REPLAN]/[STOP]
//   - review()       -- optional per-phase review, for phases tagged review="true"
//   - proposeExclusions() -- used by bundleBuilder's exclusion loop
//   - buildCoderPrompt()  -- called by PhasedRunner.runPhasedMode for each phase's coder turn
//
// All prompts flow through PhasedRunner.sendToBrain/sendAndTrack, which applies withTimestamp
// (spec 3.4) and logs the response to brain-log.jsonl (kind-scoped).
//
// Documented deviations from spec (this phase):
//   - [REPLAN] and [REVISE] on past/current phases are logged as attention items and treated
//     as [CONTINUE] semantically. Full re-run support requires a small runner.js patch,
//     deferred to avoid breaking the one-touch-per-file invariant.
//   - The pre-a.py filetrack race check is implemented in PhasedFiletrack.preApyCheck, but
//     the runner.js trigger point is deferred for the same reason.
const PhasedBrainLayer = (() => {
  const MAX_CODER_FILE_CHARS = 50000;
  const MAX_CODER_TOTAL_CHARS = 300000;
  const MAX_PRIOR_PHASE_SUMMARY_CHARS = 2000;

  function notifyCli(session, payload) {
    if (session.cancelled) return;
    NativeBridge.sendToCli({ taskId: session.taskId, ...payload });
  }

  function toForwardSlash(p) {
    return String(p || '').replace(/\\/g, '/');
  }

  // --- toolchain probe -------------------------------------------------------

  // What is actually installed on this machine, and where. Without it the brain guesses
  // ("php" when only XAMPP's php.exe exists, "net start mysql" when MySQL is XAMPP's and
  // not a Windows service, a port another server already holds). Read-only, POSIX sh
  // (Git Bash on Windows -- see native-host runShell). Cached for TOOLCHAIN_TTL_MS so a
  // burst of tasks doesn't re-probe; docker's daemon check is the slow part (~1-6s).
  const TOOLCHAIN_TTL_MS = 10 * 60 * 1000;
  let toolchainCache = null; // { at, text }

  const TOOLCHAIN_PROBE =
    'for t in node npm pnpm yarn python python3 py php composer mysql mysqld psql docker git java go cargo; do ' +
    'p=$(command -v "$t" 2>/dev/null) && echo "$t=$p"; done; ' +
    'if command -v docker >/dev/null 2>&1; then ' +
    'v=$(timeout 6 docker version --format "{{.Server.Version}}" 2>/dev/null) && echo "docker_daemon=running ($v)" || echo "docker_daemon=NOT running"; ' +
    'docker compose version >/dev/null 2>&1 && echo "docker_compose=available"; fi; ' +
    'for d in /c/xampp* /opt/lampp /Applications/XAMPP; do [ -d "$d" ] || continue; ' +
    'for f in php/php.exe mysql/bin/mysqld.exe mysql/bin/mysql.exe mysql_start.bat apache_start.bat; do ' +
    '[ -e "$d/$f" ] && echo "xampp_file=$d/$f"; done; done; ' +
    'for port in 80 443 3000 3306 4200 5000 5173 5432 6379 8000 8080 8888; do ' +
    '(exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null && echo "port_in_use=$port"; done; true';

  async function probeToolchain(session) {
    if (toolchainCache && Date.now() - toolchainCache.at < TOOLCHAIN_TTL_MS) return toolchainCache.text;
    try {
      const res = await NativeBridge.execTool(session.taskId, TOOLS.SHELL, { command: TOOLCHAIN_PROBE });
      const lines = String((res && res.stdout) || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const tools = lines.filter((l) => /^[a-z0-9]+=/.test(l) && !/^(docker_daemon|docker_compose|xampp_file|port_in_use)=/.test(l));
      const xampp = lines.filter((l) => l.startsWith('xampp_file=')).map((l) => l.slice(11));
      const ports = lines.filter((l) => l.startsWith('port_in_use=')).map((l) => l.slice(12));
      const docker = lines.filter((l) => /^docker_(daemon|compose)=/.test(l));
      const text = [
        'On PATH: ' + (tools.length ? tools.map((l) => l.replace('=', ' -> ')).join('; ') : '(none of the probed tools)'),
        docker.length ? 'Docker: ' + docker.join('; ') : '',
        xampp.length ? 'XAMPP files: ' + xampp.join('; ') : '',
        'Ports already in use on 127.0.0.1: ' + (ports.length ? ports.join(', ') : 'none of the common ones'),
      ].filter(Boolean).join('\n');
      toolchainCache = { at: Date.now(), text };
      return text;
    } catch (err) {
      return '(toolchain probe failed: ' + err.message + ' -- use check: commands to find tools)';
    }
  }

  // --- triage ---------------------------------------------------------------

  async function triage(session) {
    if (session.cancelled) throw new Error('Task cancelled.');

    // External changes section (spec 3.x: omitted entirely if filetrack off or no changes).
    let externalChanges = '';
    if (typeof PhasedFiletrack !== 'undefined') {
      try {
        externalChanges = await PhasedFiletrack.summarizeForPrompt(session);
      } catch (_) {}
    }

    // Full bundle for triage (see Phase 3's runner.js for the plan-override path; Phase 5
    // supersedes it by running a real triage turn).
    let bundle = '';
    if (session.brainTabReused) {
      // Reused brain tab already has this project's bundle in its conversation history
      // from the prior [ANSWER] turn. Re-sending it would waste ~100-200k chars and risks
      // hitting the length limit mid-turn. Send a marker instead so the triage prompt's
      // shape stays consistent -- the brain knows the bundle context is already present.
      bundle =
        '[CONVERSATION REUSED — the project file list and any bundle you compiled are earlier in ' +
        'this conversation. If this task needs code you have not bundled yet, or files changed, ' +
        'use !COMPILE_BUNDLE (or !READ_FILE for a single file) first.]';
    } else if (typeof PhasedBundleBuilder !== 'undefined' && PhasedBundleBuilder.listProjectFiles) {
      try {
        const files = await PhasedBundleBuilder.listProjectFiles(session);
        bundle = PhasedBundleBuilder.formatFileList(files, PhasedBundleBuilder.selectedBundleLimit(session)) +
          '\n\nNo code is included yet. If this task needs code, your FIRST reply is !COMPILE_BUNDLE ' +
          'followed by your read-only compile.py (see CODE BUNDLE RULES).';
      } catch (err) {
        bundle = `(could not list project files: ${err.message}; use !LS and !READ_FILE)`;
      }
    } else if (typeof PhasedBundleBuilder !== 'undefined' && PhasedBundleBuilder.buildFull) {
      const result = await PhasedBundleBuilder.buildFull(session);
      bundle = result.content;
      // Cap the bundle so the full triage prompt (bundle + template + external changes)
      // fits under charBudget as a single message. Anything over this causes the
      // proactive char_budget migration to fire and the brain ends up with a useless
      // recap (see runner.js's sendAndTrack comment for the live bug). Projects whose
      // buildFull exceeds the cap should tune compile.py's exclusion lists -- e.g. a
      // generated duplicate index.html or unrelated standalone HTML pages are prime
      // candidates to exclude.
      const bundleCap = Math.max(40000, session.charBudget - 15000);
      if (bundle.length > bundleCap) {
        const originalLen = bundle.length;
        bundle =
          bundle.slice(0, bundleCap) +
          '\n…(bundle truncated at ' + bundleCap + ' of ' + originalLen +
          ' chars for triage — edit compile.py exclusion lists to shrink this)';
      }
    } else {
      bundle = '(bundle builder not available)';
    }

    const maxPhasesCap = (session.phasedConfig && session.phasedConfig.maxPhasesCap) || 40;
    const taskText = session.brainTabReused
      ? '[FOLLOW-UP — this is a continuation of your previous turn in this same conversation. ' +
        'You already have full project context from that turn. Answer the new question directly, ' +
        'or proceed with the requested code change.]\n\n' +
        (session.taskDescription || '')
      : (session.taskDescription || '');
    const toolchain = await probeToolchain(session);
    const userImages = typeof PhasedImages !== 'undefined'
      ? await PhasedImages.collectForTask(session)
      : { attachments: [], section: '' };
    const prompt = buildTriagePrompt(
      taskText,
      bundle,
      externalChanges,
      maxPhasesCap,
      toolchain,
      userImages.section
    );

    let currentPrompt = prompt;
    let toolRounds = 0;
    let parseAttempts = 0;
    const MAX_TOOL_ROUNDS = 4;
    const MAX_PARSE_ATTEMPTS = 2;
    const MAX_COMPILE_NUDGES = 3;
    const COMPILE_SAMPLE =
      'Sample of the exact format (replace the lists with the files this task needs):\n' +
      '!COMPILE_BUNDLE\n' +
      '```python\n' +
      'from pathlib import Path\n\n' +
      'FILES = ["src/app.ts", "public/js/forms.js", "api/compute-buy-price.php"]\n' +
      'MARKDOWN = ["README.md"]\n\n' +
      'for rel in FILES:\n' +
      '    path = Path(rel)\n' +
      '    if path.is_file():\n' +
      '        print("----- FILE: " + rel + " -----")\n' +
      '        print(path.read_text(encoding="utf-8", errors="replace"))\n' +
      'for rel in MARKDOWN:\n' +
      '    print("----- FILE: " + rel + " (path only) -----")\n' +
      '```\n';
    let compileNudges = 0;

    // Phase 24 (2026-10-25): the triage loop now supports an intermediate tool-
    // gathering phase. If the brain issues read-only tool calls (e.g. !LS on a
    // path outside the bundle), the orchestrator executes them and re-prompts
    // with the results; the brain then produces its final triage decision. This
    // solves the "what about that other project" failure mode where the brain
    // previously answered "I can't inspect that" without even trying.
    while (true) {
      if (session.cancelled) throw new Error('Task cancelled.');
      const response = await PhasedRunner.sendToBrain(session, currentPrompt, {
        instant: true,
        brainLogKind: 'triage_response',
        attachments: currentPrompt === prompt && userImages.attachments.length ? userImages.attachments : undefined,
      });

      // Check for tool calls in the response. Even if a decision marker is
      // also present, honor the tools first -- brain might be pre-committing
      // to a decision without data it just asked for.
      let calls = [];
      try {
        if (typeof ToolCallParser !== 'undefined') {
          calls = ToolCallParser.parseToolCalls(response);
        }
      } catch (_) {
        calls = [];
      }
      if (session.compileMustFix && !calls.some((c) => c.tool === 'COMPILE_BUNDLE')) {
        compileNudges++;
        if (compileNudges <= MAX_COMPILE_NUDGES) {
          notifyCli(session, {
            type: CLI_MESSAGE_TYPES.PLANNER_THINKING,
            text: `(system) Brain ignored the failed compile; asking it to fix compile.py first (${compileNudges}/${MAX_COMPILE_NUDGES}).`,
          });
          currentPrompt =
            '(system) Please fix the compile error first. Your last reply did not resend compile.py, ' +
            'so nothing else was done with it. Reply with ONLY !COMPILE_BUNDLE and your corrected ' +
            'read-only compile.py.\n\n' + COMPILE_SAMPLE + '\n' +
            'No triage decision, no other tools, no explanation until the bundle passes.';
          continue;
        }
        session.compileMustFix = false;
        notifyCli(session, {
          type: CLI_MESSAGE_TYPES.PLANNER_THINKING,
          text: '(system) ⚠️ Brain never fixed compile.py; continuing without a compiled bundle.',
        });
      }
      const isCompileRetry = session.compileMustFix && calls.some((c) => c.tool === 'COMPILE_BUNDLE');
      if (calls.length && (toolRounds < MAX_TOOL_ROUNDS || (isCompileRetry && compileNudges < MAX_COMPILE_NUDGES))) {
        if (isCompileRetry && toolRounds >= MAX_TOOL_ROUNDS - 1) compileNudges++;
        else toolRounds++;
        const results = await PhasedRunner.runBrainToolCalls(session, calls);
        const compileFailed = /\(tool result for !COMPILE_BUNDLE[^\n]*\)\n(FAILED|ERROR)/.test(results);
        if (compileFailed && (toolRounds < MAX_TOOL_ROUNDS || compileNudges < MAX_COMPILE_NUDGES)) {
          currentPrompt =
            '(system) Tool results for your inspection requests:\n\n' + results +
            '\n\nFIX THE COMPILE FIRST. Your next reply must be ONLY !COMPILE_BUNDLE followed by the ' +
            'corrected compile.py in a ```python block (fewer files if it was over the limit; ' +
            'read-only rules if it was rejected). Do NOT read README or any other file now -- ' +
            'other tools are blocked until the bundle passes.\n\n' + COMPILE_SAMPLE;
          continue;
        }
        const lastRound = toolRounds >= MAX_TOOL_ROUNDS - 1;
        currentPrompt =
          '(system) Tool results for your inspection requests:\n\n' +
          results +
          (lastRound
            ? '\n\nYou now have this information. Produce your FINAL triage decision.\n'
            : '\n\nIf you still need one specific file use !READ_FILE; otherwise produce your FINAL triage decision.\n') +
          'Output exactly ONE of:\n' +
          '  [ANSWER] (with answer text, under 1500 chars)\n' +
          '  [DIRECT] [EST_LOC n] (with [BRIEF]...[/BRIEF] block)\n' +
          '  [PHASED] [EST_LOC n] [EST_PHASES m] (with [PHASE ... files="..."] blocks)\n' +
          '  [RUN] (with commands: list)\n' +
          'Any image from !ATTACH_IMAGE / !INSPECT_TAB is attached to THIS message.\n' +
          (lastRound ? 'Do NOT issue more tool calls this turn -- you have the information you need.' : '');
        continue;
      }

      // Parse as triage decision.
      const parsed = PhasedTriageParser.parseTriageResponse(response);
      if (parsed.ok) {
        if (parsed.warning) {
          await PhasedLogStore.appendAttention(session, {
            kind: parsed.warning,
            severity: 'low',
            detail: 'Triage contained both [DIRECT] and [PHASED]; defaulted to [PHASED].',
          }).catch(() => {});
        }
        return {
          mode: parsed.mode,
          estimate: parsed.estimate,
          brief: parsed.brief,
          phases: parsed.phases,
          answer: parsed.answer,
          runPlan: parsed.runPlan,
        };
      }

      // Parse failed -- retry with hints.
      parseAttempts++;
      if (parseAttempts >= MAX_PARSE_ATTEMPTS) {
        throw new Error(
          'Triage failed after ' + MAX_PARSE_ATTEMPTS + ' attempts. Last error: ' +
          (parsed.error || 'unknown') + '. The brain did not produce a valid triage block. ' +
          'If the request was a multi-bug follow-up, try rephrasing it more specifically ' +
          '(e.g. "fix the hardcoded API key leak") so triage can plan a focused task.'
        );
      }
      currentPrompt =
        '(system) Your previous response could not be parsed as a triage decision.\n' +
        'Parse error: ' + (parsed.error || 'unknown') + '\n\n' +
        'Common failure modes:\n' +
        '  1. [DIRECT] without a [BRIEF]...[/BRIEF] wrapper. Wrap the brief fields\n' +
        '     (files_to_touch, changes, tests, risks) between [BRIEF] and [/BRIEF].\n' +
        '  2. [PHASE] without files="...". Every phase MUST have files="p1,p2".\n' +
        '  3. [ANSWER] or [RUN] with no body after the tag.\n' +
        '  4. Multiple mode tags. Pick ONE.\n\n' +
        'Canonical forms:\n\n' +
        '[DIRECT] [EST_LOC N]\n' +
        '[BRIEF]\n' +
        'files_to_touch: path1,path2\n' +
        'changes:\n' +
        '- path1: what changes\n' +
        'tests: how to verify\n' +
        'risks: none\n' +
        '[/BRIEF]\n\n' +
        '[PHASED] [EST_LOC N] [EST_PHASES M]\n' +
        '[PHASE name="slug" files="path1,path2"]\n' +
        'goal: what this phase does\n' +
        'tests: how to verify\n' +
        '[/PHASE]\n\n' +
        '[ANSWER]\n' +
        '<answer text>\n\n' +
        '[RUN]\n' +
        'detect: one-sentence project description\n' +
        'commands:\n' +
        '- shell: npm install\n' +
        'open: http://localhost:5173\n\n' +
        'Output the corrected response now.';
    }
  }

  // --- coder prompt builder (called by runner.runPhasedMode) ----------------

  async function buildCoderPrompt(session, phase, index, total, attempt, currentApy, lastTraceback) {
    const filename = PhasedScriptNaming.phaseFilename(index + 1, phase.name || 'phase', attempt);

    if (attempt > 1 && currentApy) {
      return buildApyFixPrompt({
        filename,
        attempt,
        maxAttempts: (session.phasedConfig && session.phasedConfig.apyFixAttempts) || 3,
        currentApy,
        traceback: lastTraceback || '',
      });
    }

    // First attempt: assemble scope + files + references + prior-phase context.
    const scope =
      'Phase ' + (index + 1) + '/' + total + ': ' + (phase.name || '?') + '\n' +
      'Goal: ' + (phase.goal || '(no goal)') + '\n' +
      'Files to touch: ' + ((phase.files || []).join(', ') || '(none)') + '\n' +
      'Tests to run: ' + (phase.tests || '(unspecified)');

    // Same content cap as buildDirectInitialPrompt above — see its comment for the
    // live bug this prevents. Applied to phased-mode coder prompts too so the same
    // "mid-attempt migration blows the budget" failure can't fire in phased mode.
    const contentBudget = Math.floor((session.charBudget || 180000) * 0.5);
    const filesContents = await readFileContentsForPrompt(
      session, phase.files || [], MAX_CODER_FILE_CHARS, Math.floor(contentBudget * 0.7)
    );
    const referenceFiles = await readFileContentsForPrompt(
      session, phase.references || [], MAX_CODER_FILE_CHARS, Math.floor(contentBudget * 0.3)
    );
    const priorPhaseOutput = await buildPriorPhaseSummary(session);

    return buildApyTaskPrompt({
      mode: 'phased',
      index: index + 1,
      total,
      filename,
      scope,
      filesContents,
      referenceFiles,
      priorPhaseOutput,
    });
  }

  async function readFileContentsForPrompt(session, fileList, perFileMax, totalMax) {
    if (!fileList || !fileList.length) return '';
    const chunks = [];
    let budget = totalMax;
    for (const f of fileList) {
      if (budget <= 0) {
        chunks.push('--- ' + f + ' --- (budget exhausted)');
        break;
      }
      try {
        const text = await NativeBridge.execTool(session.taskId, TOOLS.READ_FILE, { path: f });
        if (typeof text === 'string') {
          const cap = Math.min(perFileMax, budget);
          const snippet = text.length > cap ? text.slice(0, cap) + '\n…(truncated)' : text;
          chunks.push('--- ' + f + ' ---\n' + snippet);
          budget -= snippet.length;
        }
      } catch (_) {
        chunks.push('--- ' + f + ' --- (unreadable or does not exist yet)');
      }
    }
    return chunks.join('\n\n');
  }

  async function buildPriorPhaseSummary(session) {
    const completed = session.completedPhases || [];
    if (!completed.length) return '';
    try {
      const entries = await PhasedLogStore.readLog(session, 20);
      const matched = entries.filter((e) => completed.some((p) => p.name === e.phase));
      if (matched.length) {
        return matched
          .map((e) => '- ' + e.phase + ': exit=' + e.exitCode + ', files=[' + (e.filesTouched || []).join(',') + ']')
          .join('\n')
          .slice(0, MAX_PRIOR_PHASE_SUMMARY_CHARS);
      }
    } catch (_) {}
    return completed.map((p) => '- ' + p.name).join('\n').slice(0, MAX_PRIOR_PHASE_SUMMARY_CHARS);
  }

  // --- coder primer (Phase 18) ---------------------------------------------
  //
  // Sent ONCE per coder tab, immediately after tab creation, before triage. Teaches
  // the coder the protocol rules and gives it the project file list. When the actual
  // task arrives (direct or per-phase), buildApyTaskPrompt provides the specifics --
  // no base-rules repetition required.

  async function buildCoderPrimer(session) {
    const base = (typeof buildApyCoderPrimerBase !== 'undefined')
      ? buildApyCoderPrimerBase()
      : 'You are a coding agent producing ONE Python script per task. ' +
        'Output exactly one ```python block per task.';

    let fileList = '(unavailable)';
    try {
      const lsResult = await NativeBridge.execTool(session.taskId, TOOLS.LS, { path: '.' });
      if (typeof lsResult === 'string' && lsResult.trim()) {
        fileList = lsResult.slice(0, 3000);
      }
    } catch (_) {}

    return (
      base +
      '\n\nProject files (top-level listing):\n' + fileList + '\n\n' +
      'You are now primed and idle. The orchestrator will send you a task-specific ' +
      'prompt for each direct or phased unit of work. When that prompt arrives, output ' +
      'exactly one ```python block for that task. Do NOT preemptively write code now -- ' +
      'wait for the task prompt.\n\n' +
      'COMPILED BUNDLE RULE: before a code task you should receive a message starting ' +
      '"CONTEXT FOR A LATER TASK" with the compiled project bundle. If a task asks you to ' +
      'change code but you have NOT received that bundle and the task prompt does not include ' +
      'the current code of the files you must change, do NOT guess. Complain to the system: ' +
      'reply with ONLY one line\n' +
      '[NEED_BUNDLE] path1, path2\n' +
      'listing the files you need. The system will send the bundle and resend the task.\n'
    );
  }

  // --- direct mode ----------------------------------------------------------

  function extractApy(text) {
    if (!text) return null;
    const pyBlocks = [];
    const re = /```(?:python|py)\s*\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text)) !== null) pyBlocks.push(m[1]);
    if (pyBlocks.length) return pyBlocks[pyBlocks.length - 1];
    const bare = [];
    const bareRe = /```\n([\s\S]*?)```/g;
    while ((m = bareRe.exec(text)) !== null) bare.push(m[1]);
    if (bare.length) return bare[bare.length - 1];
    return null;
  }

  function classifyDirect(run) {
    if (run.exitCode !== 0) return 'failure';
    const hasMarker = run.successMarker;
    const hasContent = (run.stdout || '').trim().length > 0;
    // Spec H.3: direct mode requires exit 0 AND non-trivial stdout if no marker. A direct
    // a.py that exits 0 with no output and no marker is a failure (retry coder).
    if (!hasMarker && !hasContent) return 'failure';
    if (!hasMarker) return 'soft_success';
    return 'success';
  }

  async function directWriteAndRun(session, filename, apyContent) {
    const relPath = '.myclaudecode/phased/scripts/' + filename;
    await NativeBridge.execTool(session.taskId, TOOLS.WRITE_FILE, {
      path: relPath,
      content: apyContent,
    });
    const rootFwd = toForwardSlash(session.projectRoot);
    const apyFwd = rootFwd + '/' + toForwardSlash(relPath);
    const startedAt = Date.now();
    const res = await NativeBridge.execTool(session.taskId, TOOLS.SHELL, {
      command: 'cd "' + rootFwd + '" && python "' + apyFwd + '"',
    });
    session.totalApyRuns = (session.totalApyRuns || 0) + 1;
    const stdout = (res && res.stdout) || '';
    const stderr = (res && res.stderr) || '';
    const exitCode = res && res.exitCode != null ? res.exitCode : 1;
    const tail = PhasedMarkers.lastNlines(stdout, 200);
    const successMarker = PhasedMarkers.parseSuccess(tail);
    const filesTouched = PhasedMarkers.parseWrote(tail);
    return { relPath, stdout, stderr, exitCode, successMarker, filesTouched, durationMs: Date.now() - startedAt };
  }

  async function buildDirectInitialPrompt(session, brief) {
    const filename = PhasedScriptNaming.directFilename(session.taskDescription || 'task');
    const scope =
      'Direct task: ' + (session.taskDescription || '') + '\n' +
      'Files to touch: ' + ((brief.files_to_touch || []).join(', ') || '(none)') + '\n' +
      'Changes:\n' + ((brief.changes || []).map((c) => '  - ' + c).join('\n') || '  (none)') + '\n' +
      'Tests: ' + (brief.tests || '(unspecified)') + '\n' +
      'Risks: ' + (brief.risks || 'none');
    // Cap total file content to 50% of charBudget. Without this, DIRECT mode briefs
    // with many references (candy-crush's 19 references ~= 300K chars) blow the per-tab
    // budget on attempt 1, then trigger a mid-attempt migration on attempt 2 — the coder
    // ends up on a fresh tab with a nearly-empty targeted bundle and no way to fix the
    // original a.py. Bug observed live 2026-10-25. The 70/30 split prioritizes files
    // the coder must touch over reference patterns; both get truncated with a clear
    // "…(truncated)" marker if the caps are hit.
    const contentBudget = Math.floor((session.charBudget || 180000) * 0.5);
    const filesContents = await readFileContentsForPrompt(
      session, brief.files_to_touch || [], MAX_CODER_FILE_CHARS, Math.floor(contentBudget * 0.7)
    );
    const referenceFiles = await readFileContentsForPrompt(
      session, brief.references || [], MAX_CODER_FILE_CHARS, Math.floor(contentBudget * 0.3)
    );
    return buildApyTaskPrompt({
      mode: 'direct',
      index: 1,
      total: 1,
      filename,
      scope,
      filesContents,
      referenceFiles,
      priorPhaseOutput: '',
    });
  }

  async function runDirect(session, brief) {
    session.directBrief = brief;
    const filename = PhasedScriptNaming.directFilename(session.taskDescription || 'task');
    const maxAttempts = (session.phasedConfig && session.phasedConfig.apyFixAttempts) || 3;
    let attempt = 1;
    let currentApy = null;
    let lastRun = null;

    while (attempt <= maxAttempts) {
      if (session.cancelled) throw new Error('Task cancelled.');
      const prompt = attempt === 1
        ? await buildDirectInitialPrompt(session, brief)
        : buildApyFixPrompt({
            filename,
            attempt,
            maxAttempts,
            currentApy: currentApy || '',
            traceback: (lastRun && (lastRun.stderr || lastRun.stdout)) || '',
          });
      const response = await PhasedRunner.sendAndTrack(session, 'executor', prompt, { instant: true });
      currentApy = extractApy(response);
      if (!currentApy) {
        lastRun = { stdout: '', stderr: 'Coder produced no ```python block.', exitCode: 1, successMarker: false, filesTouched: [] };
        attempt++;
        continue;
      }
      lastRun = await directWriteAndRun(session, filename, currentApy);
      const classification = classifyDirect(lastRun);
      if (classification === 'failure') {
        await PhasedLogStore.appendLog(session, {
          phase: 'direct',
          attempt,
          exitCode: lastRun.exitCode,
          successMarker: lastRun.successMarker,
          durationMs: lastRun.durationMs,
          filesTouched: lastRun.filesTouched,
        }).catch(() => {});
        attempt++;
        continue;
      }
      if (classification === 'soft_success') {
        await PhasedLogStore.appendAttention(session, {
          phase: 'direct',
          kind: 'missing_marker_soft',
          severity: 'medium',
          detail: 'Direct-mode a.py exited 0 with output but no __PHASE_SUCCESS__ marker.',
        }).catch(() => {});
      }
      await PhasedLogStore.appendLog(session, {
        phase: 'direct',
        attempt,
        exitCode: lastRun.exitCode,
        successMarker: lastRun.successMarker,
        durationMs: lastRun.durationMs,
        filesTouched: lastRun.filesTouched,
      }).catch(() => {});
      notifyCli(session, {
        type: CLI_MESSAGE_TYPES.PHASE_SUCCESS,
        phase: 'direct',
        durationMs: lastRun.durationMs,
        filesTouched: lastRun.filesTouched,
      });
      return;
    }

    // Exhausted retries → escalate.
    session.directEscalations = (session.directEscalations || 0) + 1;
    notifyCli(session, {
      type: CLI_MESSAGE_TYPES.DIRECT_MODE_ESCALATED,
      reason: 'direct_failed_' + maxAttempts + 'x',
      traceback: (lastRun && lastRun.stderr) || '',
      filesTouched: (lastRun && lastRun.filesTouched) || [],
    });
    await escalate(session, {
      traceback: (lastRun && (lastRun.stderr || lastRun.stdout)) || '',
      filesTouched: (lastRun && lastRun.filesTouched) || [],
      filename,
      maxAttempts,
    });
  }

  // --- escalation -----------------------------------------------------------

  async function escalate(session, ctx) {
    const maxCycles = (session.phasedConfig && session.phasedConfig.maxEscalationCycles) || 2;
    session.escalationCycles = (session.escalationCycles || 0) + 1;
    if (session.escalationCycles > maxCycles) {
      throw new Error(
        'Task failed after ' + maxCycles + ' escalation cycles. Consider splitting the task manually.'
      );
    }

    let bundle = '(unavailable)';
    if (typeof PhasedBundleBuilder !== 'undefined' && PhasedBundleBuilder.buildFull) {
      try {
        const result = await PhasedBundleBuilder.buildFull(session);
        bundle = result.content;
      } catch (err) {
        bundle = '(bundle build failed: ' + err.message + ')';
      }
    }

    // Cap the escalation bundle same as triage. Brain already has triage-turn context
    // (~170K chars); an uncapped escalation prompt (another ~170K) blows charBudget
    // mid-send and gets a recap acknowledgment instead of a triage decision.
    const escalationBundleCap = Math.max(40000, session.charBudget - 40000);
    if (bundle.length > escalationBundleCap) {
      bundle =
        bundle.slice(0, escalationBundleCap) +
        '\n…(bundle truncated at ' + escalationBundleCap +
        ' chars for escalation — edit compile.py exclusions to shrink)';
    }

    // Pre-migrate the brain BEFORE building the escalation prompt if it would overflow.
    // Doing this before building the prompt means the escalation prompt lands on a
    // fresh tab with plenty of budget, so the brain actually sees the escalation
    // decision request instead of a recap acknowledgment ("[CONTINUE]").
    // Live bug (2026-10-25): escalation prompt caused mid-send migration, brain replied
    // [CONTINUE] to the recap, escalation parser threw "unparseable."
    if ((session.brainCharCount || 0) + bundle.length + 5000 >= session.charBudget) {
      try {
        if (typeof PhasedMigration !== 'undefined' && PhasedMigration.migrate) {
          await PhasedMigration.migrate(session, 'planner', 'pre_escalation');
        }
      } catch (err) {
        console.warn(
          '[PhasedBrainLayer] pre-escalation migration failed:',
          (err && err.message) || err
        );
      }
    }

    const prompt = buildEscalationPrompt({
      filename: ctx.filename,
      maxAttempts: ctx.maxAttempts,
      taskDescription: session.taskDescription,
      traceback: ctx.traceback,
      filesTouched: ctx.filesTouched,
      bundle,
    });

    const response = await PhasedRunner.sendToBrain(session, prompt, {
      instant: true,
      brainLogKind: 'escalation_response',
    });
    const parsed = PhasedTriageParser.parseTriageResponse(response);
    if (!parsed.ok) {
      throw new Error('Escalation response unparseable: ' + (parsed.error || 'unknown'));
    }

    if (parsed.mode === 'direct') {
      // Re-run direct with a fresh attempt budget (spec H.2: "the orchestrator will retry
      // direct mode with a fresh attempt budget").
      notifyCli(session, {
        type: CLI_MESSAGE_TYPES.TRIAGE_DECIDED,
        mode: 'direct',
        estimate: parsed.estimate,
        note: 'escalation_retry',
      });
      return runDirect(session, parsed.brief);
    }

    // Phased plan from the brain. Set on session; runPhasedMode reads from session.phasePlan.
    session.triageMode = 'phased';
    session.phasePlan = parsed.phases;
    session.currentPhaseIndex = 0;
    session.completedPhases = [];
    notifyCli(session, {
      type: CLI_MESSAGE_TYPES.TRIAGE_DECIDED,
      mode: 'phased',
      estimate: parsed.estimate,
      note: 'escalation_to_phased',
    });
    await PhasedRunner.runPhasedMode(session);
  }

  // --- batch ping -----------------------------------------------------------

  function parsePingResponse(text) {
    const raw = String(text || '');
    if (/^\s*\[CONTINUE\]\s*$/im.test(raw)) return { action: 'continue' };
    const stopMatch = /^\s*\[STOP\]\s*(.*)$/im.exec(raw);
    if (stopMatch) return { action: 'stop', reason: (stopMatch[1] || '').trim() };
    const reviseMatch = /\[REVISE\s+phase\s*=\s*["']([^"']+)["']\]/i.exec(raw);
    if (reviseMatch) {
      const phaseName = reviseMatch[1];
      const phaseParsed = PhasedTriageParser.parseTriageResponse(raw);
      if (phaseParsed.ok && phaseParsed.mode === 'phased' && phaseParsed.phases && phaseParsed.phases.length) {
        return { action: 'revise', phaseName, revisedPhase: phaseParsed.phases[0] };
      }
      return { action: 'revise_malformed', phaseName };
    }
    if (/^\s*\[REPLAN\]/im.test(raw)) {
      return { action: 'replan', raw };
    }
    return { action: 'malformed', raw };
  }

  async function ping(session) {
    if (session.cancelled) throw new Error('Task cancelled.');
    const summary = await PhasedBrainPinger.buildBatchSummary(session);
    const prompt =
      'You are the senior engineer for this phased build. Review progress and decide what happens next.\n\n' +
      (typeof TIMESTAMP_NOTICE !== 'undefined' ? TIMESTAMP_NOTICE + '\n\n' : '') +
      summary + '\n' +
      'Decide:\n' +
      '- If everything is on track, reply: [CONTINUE] followed by nothing else.\n' +
      '- If a phase needs re-scoping, reply [REVISE phase="<name>"] followed by a revised [PHASE] block.\n' +
      '- If the whole plan needs replanning, reply [REPLAN] followed by an entirely new phase plan.\n' +
      '- If the task should stop, reply [STOP] followed by a one-line reason.\n\n' +
      'Do NOT write code. Do NOT output a ```python block.\n' +
      '- BREVITY: reply with the decision and nothing else.\n';

    const response = await PhasedRunner.sendToBrain(session, prompt, {
      instant: true,
      brainLogKind: 'batch_ping_response',
    });
    const parsed = parsePingResponse(response);

    if (parsed.action === 'continue') {
      PhasedBrainPinger.markPinged(session);
      return;
    }
    if (parsed.action === 'stop') {
      throw new Error('Brain requested STOP: ' + (parsed.reason || '(no reason)'));
    }
    if (parsed.action === 'revise' && parsed.revisedPhase) {
      const idx = (session.phasePlan || []).findIndex((p) => p.name === parsed.phaseName);
      if (idx === -1) {
        await PhasedLogStore.appendAttention(session, {
          kind: 'revise_phase_not_found',
          severity: 'medium',
          detail: 'Brain revised phase "' + parsed.phaseName + '" but no such phase exists.',
        }).catch(() => {});
      } else if (idx > (session.currentPhaseIndex || 0)) {
        // Future phase — takes effect naturally on next loop iteration.
        session.phasePlan[idx] = parsed.revisedPhase;
        await PhasedLogStore.appendAttention(session, {
          kind: 'revise_applied',
          severity: 'low',
          detail: 'Phase "' + parsed.phaseName + '" revised (future phase, will use new spec).',
        }).catch(() => {});
      } else {
        // Past/current phase — cannot re-run without a runner.js edit (deferred).
        session.phasePlan[idx] = parsed.revisedPhase;
        await PhasedLogStore.appendAttention(session, {
          kind: 'revise_past_phase_deferred',
          severity: 'medium',
          detail: 'Phase "' + parsed.phaseName + '" revised but is already past — re-run requires [REPLAN].',
        }).catch(() => {});
      }
      PhasedBrainPinger.markPinged(session);
      return;
    }
    if (parsed.action === 'replan') {
      // Deferred: full replan support requires a runner.js edit to reset the loop's
      // captured `total` and `phases` reference. Log the intent and treat as continue.
      await PhasedLogStore.appendAttention(session, {
        kind: 'replan_deferred',
        severity: 'medium',
        detail: 'Brain requested REPLAN but mid-run replanning is deferred to a future build. Treating as CONTINUE.',
      }).catch(() => {});
      PhasedBrainPinger.markPinged(session);
      return;
    }
    // Malformed / unknown — default CONTINUE per spec D.5.
    await PhasedLogStore.appendAttention(session, {
      kind: 'brain_ping_malformed_verbose',
      severity: 'low',
      detail: 'Batch ping response did not parse; defaulted to CONTINUE.',
    }).catch(() => {});
    PhasedBrainPinger.markPinged(session);
  }

  // --- review (optional, per-phase) ----------------------------------------

  async function review(session, phase, runInfo) {
    if (session.cancelled) return [];
    const prompt = buildBrainReviewPrompt({
      phaseName: phase.name,
      phaseGoal: phase.goal,
      phaseFiles: (phase.files || []).join(', '),
      apyLines: runInfo.apyLines || 0,
      apyChars: runInfo.apyChars || 0,
      exitCode: runInfo.exitCode,
      stdoutTail: (runInfo.stdoutTail || '').slice(0, 1500),
      stderrTail: (runInfo.stderrTail || '').slice(0, 1500),
    });
    const response = await PhasedRunner.sendToBrain(session, prompt, {
      instant: true,
      brainLogKind: 'review_response',
    });
    // Parse [ISSUE severity="..."] blocks; a clean response has [ISSUE_COUNT]0[/ISSUE_COUNT].
    const issueRe = /\[ISSUE\s+severity\s*=\s*["'](high|medium|low)["']\]([\s\S]*?)\[\/ISSUE\]/gi;
    const issues = [];
    let m;
    while ((m = issueRe.exec(response)) !== null) {
      issues.push({ severity: m[1].toLowerCase(), detail: m[2].trim() });
    }
    for (const issue of issues) {
      await PhasedLogStore.appendAttention(session, {
        phase: phase.name,
        kind: 'review_issue',
        severity: issue.severity,
        detail: issue.detail,
      }).catch(() => {});
    }
    return issues;
  }

  // --- exclusion proposal (used by bundleBuilder's exclusion loop) ----------

  async function proposeExclusions(session, currentChars) {
    // Best-effort brain-driven proposal. If the brain doesn't have anything to add, skip.
    // Note: this is a lighter-weight path than the spec's "top-30-by-size list"; the
    // deterministic fallback in bundleBuilder already handles the common cases, so this
    // only runs when the brain has actually noticed a signal worth acting on.
    if (currentChars < 2400000) return [];
    const prompt =
      'The migration bundle is ' + currentChars + ' chars, exceeding the 2,400,000-char limit.\n\n' +
      'Suggest specific files/directories to exclude. Use one of these formats per line:\n' +
      '  EXCLUDE_DIR <relative-path>\n' +
      '  EXCLUDE_FILE <relative-path>\n' +
      '  EXCLUDE_PREFIX <filename-prefix>\n\n' +
      'Output only the directives, nothing else. If nothing is safe to exclude, output nothing.\n';
    const response = await PhasedRunner.sendToBrain(session, prompt, {
      instant: true,
      brainLogKind: 'exclusion_proposal',
    });
    const dirs = [];
    const files = [];
    const prefixes = [];
    const dirRe = /^EXCLUDE_DIR\s+(.+)$/gm;
    const fileRe = /^EXCLUDE_FILE\s+(.+)$/gm;
    const prefixRe = /^EXCLUDE_PREFIX\s+(.+)$/gm;
    let m;
    while ((m = dirRe.exec(response)) !== null) dirs.push(m[1].trim());
    while ((m = fileRe.exec(response)) !== null) files.push(m[1].trim());
    while ((m = prefixRe.exec(response)) !== null) prefixes.push(m[1].trim());
    // The actual EDIT_FILE application happens inside bundleBuilder's exclusion loop; this
    // function only returns the raw directives. Phase 5 defers wiring — see the file
    // header's "Documented deviations" note.
    return { dirs, files, prefixes };
  }

  return {
    triage,
    runDirect,
    escalate,
    ping,
    review,
    buildCoderPrimer,
    buildCoderPrompt,
    proposeExclusions,
    probeToolchain,
  };
})();
