// Triage response parser (spec Part B.1 regexes + B.2 validation rules). Pure function --
// takes raw brain response, returns { ok, error, mode, estimate, brief?, phases? }. Callers
// decide whether to retry on !ok (brainLayer.triage does one retry, then throws).
const PhasedTriageParser = (() => {
  const DIRECT_RE = /\[DIRECT\]\s*\[EST_LOC\s+(\d+)\]/i;
  const PHASED_RE = /\[PHASED\]\s*\[EST_LOC\s+(\d+)\]\s*\[EST_PHASES\s+(\d+)\]/i;
  // BUGFIX (Phase 19, 2026-10-25): the previous pattern /\[PHASE([^\]]*)\].../ matched
  // the `[PHASED]` header as a phantom phase block, because `[PHASED]` is literally
  // `[PHASE` + `D` + `]` and `[^\]]*` happily consumes the `D`. The phantom's "attrs"
  // became just "D" (no name, no files), its body swallowed all the real first-phase
  // content, and the parser reported "Phase \"Phase 1\" has no files attribute" on
  // input that was actually in the canonical format. The raw diagnostic (parsedName:
  // "Phase 1", parsedFiles: [], rawMatchedBlock starting with "[PHASED]...") is what
  // identified this bug — see the diagnostic block below for the current shape.
  //
  // Fix: `[PHASE` must be followed by either whitespace-then-attrs or an immediate
  // `]` (bare `[PHASE]`). `[PHASED]` cannot match because `D` is neither.
  const PHASE_RE = /\[PHASE(?:\s+([^\]]*))?\]([\s\S]*?)\[\/PHASE\]/gi;
  // Accept ASCII quotes AND smart quotes (U+2018/2019/201C/201D). DeepSeek often
  // renders " and ' as typographic quotes, which broke the previous [/["']/i] classes
  // and caused the observed "Phase \"Phase 1\" has no files attribute" failure even
  // though the brain had written files="..." with curly quotes. Observed live
  // 2026-10-25.
  const QUOTE_CHARS = '"\'\u2018\u2019\u201C\u201D';
  const PHASE_NAME_ATTR_RE = new RegExp(
    'name\\s*=\\s*[' + QUOTE_CHARS + ']([^' + QUOTE_CHARS + ']+)[' + QUOTE_CHARS + ']',
    'i'
  );
  const PHASE_FILES_ATTR_RE = new RegExp(
    'files\\s*=\\s*[' + QUOTE_CHARS + ']([^' + QUOTE_CHARS + ']+)[' + QUOTE_CHARS + ']',
    'i'
  );
  const PHASE_REFS_ATTR_RE = new RegExp(
    'references\\s*=\\s*[' + QUOTE_CHARS + ']([^' + QUOTE_CHARS + ']+)[' + QUOTE_CHARS + ']',
    'i'
  );
  const PHASE_REVIEW_ATTR_RE = /review\s*=\s*["']true["']/i;
  const BRIEF_RE = /\[BRIEF\]([\s\S]*?)\[\/BRIEF\]/i;

  // Strip path traversal and absolute paths from an individual filename coming from the
  // brain. Spec B.2: "filename contains `..` or absolute path -> strip to basename".
  function safeBasename(p) {
    if (!p) return p;
    const trimmed = String(p).trim();
    const normalized = trimmed.replace(/\\/g, '/');
    if (normalized.includes('..') || normalized.startsWith('/')) {
      return normalized.split('/').filter(Boolean).pop() || trimmed;
    }
    return trimmed;
  }

  function parsePhaseBody(body) {
    const goalMatch = /^\s*goal:\s*([\s\S]*?)(?=^\s*tests:|^\s*files:|$)/m.exec(body);
    const testsMatch = /^\s*tests:\s*([\s\S]*?)$/m.exec(body);
    // RECOVERY fallbacks (Phase 17/18, 2026-10-25): brain sometimes writes files:/name:
    // as body lines instead of attributes. Both forms are acceptable; attribute is
    // preferred, body is the fallback.
    const filesLineMatch = /^\s*files\s*:\s*(.+)$/m.exec(body);
    const nameLineMatch = /^\s*name\s*:\s*(.+)$/m.exec(body);
    return {
      goal: goalMatch ? goalMatch[1].trim() : '',
      tests: testsMatch ? testsMatch[1].trim() : '',
      filesInBody: filesLineMatch
        ? filesLineMatch[1].split(',').map((s) => s.trim()).filter(Boolean)
        : [],
      nameInBody: nameLineMatch ? nameLineMatch[1].trim() : '',
    };
  }

  // Placeholder values a brain sometimes writes into files_to_touch / references when
  // it thinks there's nothing concrete to list. Filtering these BEFORE the "empty brief"
  // check is what prevents DIRECT mode from being approved with zero actionable work.
  // Live example (2026-10-25, candy-crush): [DIRECT] [EST_LOC 0] with files_to_touch:
  // (none) — the old parser treated "(none)" as a real filename and the empty-brief
  // check never fired.
  const PLACEHOLDER_RE = /^\(?(none|n\/?a|null|empty|no|nope|nothing)\)?$/i;

  function filterPlaceholders(arr) {
    return arr.filter((s) => s && !PLACEHOLDER_RE.test(s));
  }

  function parseBriefBody(body) {
    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
    const brief = { files_to_touch: [], references: [], changes: [], tests: '', risks: 'none' };
    let mode = null;
    for (const line of lines) {
      if (line.toLowerCase().startsWith('files_to_touch:')) {
        brief.files_to_touch = filterPlaceholders(
          line.slice('files_to_touch:'.length).split(',').map((s) => safeBasename(s.trim())).filter(Boolean)
        );
        mode = null;
      } else if (line.toLowerCase().startsWith('references:')) {
        brief.references = filterPlaceholders(
          line.slice('references:'.length).split(',').map((s) => safeBasename(s.trim())).filter(Boolean)
        );
        mode = null;
      } else if (line.toLowerCase() === 'changes:') {
        mode = 'changes';
      } else if (line.startsWith('- ') && mode === 'changes') {
        brief.changes.push(line.slice(2).trim());
      } else if (mode === 'changes' && line && !/^(tests|risks):/i.test(line)) {
        // Accept non-bulleted prose lines under changes:. The brain sometimes writes
        // descriptive paragraphs instead of "- file: change" bullets (observed live
        // 2026-10-25 — the previous strict-bullet-only parser dropped the entire block,
        // triage saw an "empty" brief and then... approved it as DIRECT anyway because
        // files_to_touch had "(none)". Both bugs compounded; both fixed here.)
        brief.changes.push(line);
      } else if (line.toLowerCase().startsWith('tests:')) {
        brief.tests = line.slice('tests:'.length).trim();
        mode = null;
      } else if (line.toLowerCase().startsWith('risks:')) {
        brief.risks = line.slice('risks:'.length).trim();
        mode = null;
      }
    }
    return brief;
  }

  function parsePhases(text) {
    const phases = [];
    PHASE_RE.lastIndex = 0;
    let m;
    while ((m = PHASE_RE.exec(text)) !== null) {
      const attrs = m[1] || '';
      const body = m[2] || '';
      const nameMatch = PHASE_NAME_ATTR_RE.exec(attrs);
      const filesMatch = PHASE_FILES_ATTR_RE.exec(attrs);
      const refsMatch = PHASE_REFS_ATTR_RE.exec(attrs);
      const wantsReview = PHASE_REVIEW_ATTR_RE.test(attrs);
      const parsed = parsePhaseBody(body);
      const rawFiles = filesMatch
        ? filesMatch[1].split(',')
        : (parsed.filesInBody || []);
      phases.push({
        name: nameMatch ? nameMatch[1].trim() : (parsed.nameInBody || null),
        files: rawFiles.map((s) => safeBasename(s.trim())).filter(Boolean),
        references: refsMatch ? refsMatch[1].split(',').map((s) => safeBasename(s.trim())).filter(Boolean) : [],
        goal: parsed.goal,
        tests: parsed.tests,
        review: wantsReview,
        _raw: (m[0] || '').slice(0, 300),
      });
    }
    return phases;
  }

  function normalizePhases(phases) {
    const seen = new Map();
    for (let i = 0; i < phases.length; i++) {
      const p = phases[i];
      if (!p.name) {
        p.name = 'Phase ' + (i + 1);
      }
      let uniqueName = p.name;
      let suffix = 1;
      while (seen.has(uniqueName)) {
        suffix++;
        uniqueName = p.name + '-' + suffix;
      }
      if (uniqueName !== p.name) p.name = uniqueName;
      seen.set(p.name, true);
    }
    return phases;
  }

  // [ANSWER] mode regex: the tag appears on its own line (possibly with surrounding
  // whitespace), and everything after it is the answer body.
  const ANSWER_RE = /^[ \t]*\[ANSWER\][ \t]*$/im;

  // [RUN] mode: task is "run/start/serve/open/get-the-project-running". The
  // brain produces a plan of commands the orchestrator executes directly. No
  // coder involvement, no a.py -- the deliverable is a running project.
  //
  // Phase 22 (2026-10-25). Format:
  //   [RUN]
  //   detect: <one sentence>
  //   commands:
  //   - <shell command>                (blocking, non-zero exit aborts)
  //   - check: <command>               (informational, exit code ignored)
  //   - ask: <question> | <opt1> | <opt2>   (user confirmation; No aborts)
  //   - bg: <command>                  (background, e.g. dev server)
  //   open: <path-or-url>
  //
  // Parser is lenient: the "commands:" header is optional, "detect:" and "open:"
  // lines are recognized anywhere in the body, and bullet lines can use - or *.
  const RUN_RE = /^[ \t]*\[RUN\][ \t]*$/im;

  function parseRunResponse(raw) {
    const m = raw.match(RUN_RE);
    if (!m || m.index == null) return null;
    const body = raw.slice(m.index).replace(/^[ \t]*\[RUN\][ \t]*\r?\n?/i, '');

    const detectMatch = /^\s*detect\s*:\s*(.+)$/im.exec(body);
    const openMatch = /^\s*open\s*:\s*(.+)$/im.exec(body);

    // Strip detect:/open: lines before scanning for bullet commands, so a
    // detect: line that happens to start with a bullet-like char doesn't get
    // treated as a command.
    const bodyForCommands = body
      .replace(/^\s*detect\s*:.*$/gim, '')
      .replace(/^\s*open\s*:.*$/gim, '');

    // Phase 23 (2026-10-25): previously only bulleted lines (`- check: foo`)
    // were captured. Observed live: brain produced bare-prefix lines (`check:
    // foo`) inside the commands: block -- no bullet -- so commands[] came back
    // empty and only "open:" survived. Two-regex approach: bullets first, then
    // bare-prefix lines, merged by line position. Lines match exactly one regex
    // (bullets start with -/*; bare lines start with a keyword), so no double-
    // counting. Bulleted non-prefixed lines (`- npm install`) are still mapped
    // to kind:shell for backwards compatibility.
    const matches = [];
    const bulletRe = /^\s*[-*]\s+(.+)$/gm;
    let mm;
    while ((mm = bulletRe.exec(bodyForCommands)) !== null) {
      matches.push({ index: mm.index, content: mm[1].trim() });
    }
    const bareRe = /^\s*(check|shell|bg|ask)\s*:\s*(.+)$/gim;
    while ((mm = bareRe.exec(bodyForCommands)) !== null) {
      // Bare-prefix match; mm[0] keeps the prefix so the mapper below handles
      // it the same way as a bulleted-with-prefix line.
      matches.push({ index: mm.index, content: mm[0].trim() });
    }
    matches.sort((a, b) => a.index - b.index);

    const commands = [];
    for (const { content } of matches) {
      const line = content.trim();
      if (!line) continue;
      if (/^ask\s*:\s*/i.test(line)) {
        const askBody = line.replace(/^ask\s*:\s*/i, '').trim();
        const parts = askBody.split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
        commands.push({
          kind: 'ask',
          question: parts[0] || '(no question text)',
          options: parts.slice(1),
        });
      } else if (/^bg\s*:\s*/i.test(line)) {
        commands.push({ kind: 'bg', value: line.replace(/^bg\s*:\s*/i, '').trim() });
      } else if (/^check\s*:\s*/i.test(line)) {
        commands.push({ kind: 'check', value: line.replace(/^check\s*:\s*/i, '').trim() });
      } else if (/^shell\s*:\s*/i.test(line)) {
        commands.push({ kind: 'shell', value: line.replace(/^shell\s*:\s*/i, '').trim() });
      } else {
        // Bulleted non-prefixed line: `- npm install` -> kind:shell.
        commands.push({ kind: 'shell', value: line });
      }
    }

    if (!commands.length && !openMatch) {
      return {
        ok: false,
        error: '[RUN] plan has no commands and no open: target -- nothing to execute. ' +
               'Either add at least one command, or use [ANSWER] if the task was a question.',
      };
    }

    return {
      ok: true,
      mode: 'run',
      runPlan: {
        detect: detectMatch ? detectMatch[1].trim() : '(no detect line)',
        commands,
        open: openMatch ? openMatch[1].trim() : null,
      },
    };
  }

  function parseTriageResponse(text) {
    const raw = String(text || '');

    // [RUN] first -- distinct token, no ambiguity.
    if (RUN_RE.test(raw)) {
      const parsed = parseRunResponse(raw);
      if (parsed) return parsed;
    }

    // [ANSWER] is checked FIRST (before [DIRECT]/[PHASED]) because an analysis response
    // may contain incidental text that superficially resembles other tags (e.g. a
    // paraphrase of the schema in the answer body). Answer text can be arbitrarily
    // long and structured; we don't try to parse it further, just hand it back.
    if (ANSWER_RE.test(raw)) {
      const idx = raw.search(ANSWER_RE);
      const afterTag = raw.slice(idx).replace(/^[ \t]*\[ANSWER\][ \t]*\r?\n?/i, '').trim();
      if (!afterTag) {
        return { ok: false, error: '[ANSWER] present but no answer text after it.' };
      }
      return { ok: true, mode: 'answer', answer: afterTag };
    }

    const hasDirect = DIRECT_RE.test(raw);
    const hasPhased = PHASED_RE.test(raw);

    // Spec B.2: both markers -> default to PHASED, log to attention.
    if (hasDirect && hasPhased) {
      const pm = PHASED_RE.exec(raw);
      const phases = normalizePhases(parsePhases(raw));
      if (phases.length === 0) {
        return { ok: false, error: 'Both [DIRECT] and [PHASED] present, but [PHASED] block had zero [PHASE] blocks.' };
      }
      return {
        ok: true,
        mode: 'phased',
        estimate: pm ? parseInt(pm[1], 10) : null,
        estPhases: pm ? parseInt(pm[2], 10) : null,
        phases,
        warning: 'both_markers_phased_wins',
      };
    }

    if (hasPhased) {
      const pm = PHASED_RE.exec(raw);
      const phases = normalizePhases(parsePhases(raw));
      if (phases.length === 0) {
        return { ok: false, error: '[PHASED] present but zero [PHASE] blocks found.' };
      }
      // Spec B.2: reject phases with no files. Error includes diagnostic dump so
      // the retry prompt can show the brain what was actually parsed -- previously
      // the message said "has no files attribute" without revealing WHY the regex
      // missed it, which wasted a retry when the brain had written the attribute
      // with smart quotes.
      for (const p of phases) {
        if (!p.files || !p.files.length) {
          // Keep the raw matched block in the diagnostic — it is what identified the
          // [PHASED] phantom-match bug (Phase 19) and it will identify the next
          // format weirdness too. The name is intentionally included so a fallback
          // "Phase N" shows up clearly as "the name attr didn't parse" rather than
          // as a phase that the brain literally named "Phase 1".
          const raw = (p._raw || '').replace(/\s+/g, ' ').slice(0, 240);
          return {
            ok: false,
            error:
              'Phase "' + (p.name || '(unnamed)') + '" has no files attribute. ' +
              'Raw block: ' + JSON.stringify(raw) + '. ' +
              'The block should look like [PHASE name="slug" files="path1,path2"] ' +
              'on a single line, with at least one comma-separated file path. ' +
              'If the raw block shows a valid files= attribute, the parser has a bug ' +
              'and this diagnostic needs to be reported.',
          };
        }
      }
      return {
        ok: true,
        mode: 'phased',
        estimate: pm ? parseInt(pm[1], 10) : null,
        estPhases: pm ? parseInt(pm[2], 10) : null,
        phases,
      };
    }

    if (hasDirect) {
      const dm = DIRECT_RE.exec(raw);
      const bm = BRIEF_RE.exec(raw);

      // RECOVERY (Phase 16, 2026-10-25): observed live -- a follow-up task "fix all the
      // bugs you have seen" produced a DIRECT response that started with
      // [DIRECT] [EST_LOC N], followed by a bullet list of bugs, but with no
      // [BRIEF]...[/BRIEF] wrapper. This isn't an ambiguous response -- it's a valid
      // brief body that just forgot the wrapper. Recover by treating the text after the
      // DIRECT line as the brief body, but only if it actually contains the required
      // schema fields (files_to_touch: or changes:). Anything else still fails so
      // genuinely malformed responses are caught.
      let briefBody = bm ? (bm[1] || '') : null;
      if (briefBody == null) {
        const directMatch = raw.match(DIRECT_RE);
        if (directMatch && directMatch.index != null) {
          const afterDirect = raw.slice(directMatch.index + directMatch[0].length);
          const stripped = afterDirect
            .replace(/\[\/?BRIEF\]/gi, '')
            .replace(/\[\/?PHASE[^\]]*\]/gi, '');
          if (/(^|\n)\s*files_to_touch\s*:/i.test(stripped) ||
              /(^|\n)\s*changes\s*:/i.test(stripped)) {
            briefBody = stripped;
          }
        }
      }
      if (briefBody == null) {
        return { ok: false, error: '[DIRECT] present but no [BRIEF] block found. DIRECT responses must include a [BRIEF]...[/BRIEF] pair; if the task is actually multi-bug or multi-file, use [PHASED] instead.' };
      }
      const brief = parseBriefBody(briefBody);
      // DIRECT mode requires at least one specific file to write/edit. If files_to_touch
      // is empty after filtering placeholders like "(none)", the brief is not actionable
      // as a single bounded change — reject and let the brain retry with either a
      // concrete file (e.g. ANALYSIS.md for read-only tasks, so the change is concrete)
      // or a [PHASED] plan. Bug observed live 2026-10-25: triage returned [DIRECT]
      // [EST_LOC 0] with files_to_touch: (none) and the empty-brief check never fired
      // because "(none)" was counted as a real file — see filterPlaceholders above.
      if (!brief.files_to_touch.length) {
        return {
          ok: false,
          error:
            '[BRIEF] has empty files_to_touch after filtering placeholders like "(none)". ' +
            'DIRECT mode needs at least one specific file to write or edit. For a read-only ' +
            'analysis task, write findings to a file (e.g. files_to_touch: ANALYSIS.md with ' +
            'a matching changes: entry) so the change is concrete. Alternatively, use [PHASED].',
        };
      }
      return {
        ok: true,
        mode: 'direct',
        estimate: dm ? parseInt(dm[1], 10) : null,
        brief,
      };
    }

    return { ok: false, error: 'Neither [DIRECT] nor [PHASED] block found in response.' };
  }

  return { parseTriageResponse, safeBasename };
})();
