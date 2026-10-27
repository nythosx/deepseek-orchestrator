// Disk-based bundle construction for phased-mode migration (spec section 4.1) and the
// exclusion loop (spec section 4.2). Two bundle shapes:
//
//   buildTargeted -- ~90% of migrations. Current a.py + traceback + current phase context
//                    + log tail + external changes + phase-owned file contents. Typically
//                    100-300k chars -- small enough to send immediately.
//
//   buildFull -- runs compile.py and parses its three __BUNDLE_*__ marker lines. Used when
//                the brain explicitly requests a fresh start, or when the targeted bundle
//                itself exceeds 2.4M chars (in which case the exclusion loop runs to trim
//                the full bundle below the ceiling).
//
// Note (Phase 4 scope): the exclusion loop's step 4 in the spec ("drop largest remaining
// files one at a time") is deferred. Steps 1-3 (batch-dropping lockfiles/build-dirs, tests,
// docs) run here; if the bundle is STILL too large after them, we throw TASK_ERROR with
// "phase too large, split manually" rather than iteratively dropping -- the same terminal
// outcome the spec reaches, without the iterative complexity. Add step 4 in a follow-up if
// real-world projects need it.
//
// compile.py template is embedded here as COMPILE_PY_TEMPLATE (canonical source of truth
// for auto-copy). The repo-root compile.py exists for user inspection but is not read at
// runtime -- embedding keeps ensureCompilePy independent of the repo install location.
const PhasedBundleBuilder = (() => {
  const COMPILE_PY_TEMPLATE = String.raw`#!/usr/bin/env python3
"""compile.py -- MyClaudeCode project bundler.

python compile.py                    bundle every source file
python compile.py --list             print __FILE__ <chars> <path> for every candidate file
python compile.py --include FILE     bundle only the paths/dirs listed in FILE (one per line)
"""
import os
import sys

MCC_COMPILE_VERSION = 2
SELF_NAME = "__SELF_NAME__"
BASE_ROOT = os.path.dirname(os.path.abspath(__file__))
OUTPUT = os.path.join(BASE_ROOT, ".myclaudecode", "phased", "bundle.txt")

INCLUDE_EXT = {
    ".py", ".js", ".ts", ".jsx", ".tsx", ".php", ".rb", ".go", ".rs",
    ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".swift", ".kt",
    ".html", ".css", ".scss", ".sql", ".sh", ".json", ".yaml", ".yml",
    ".toml", ".ini", ".env.example", ".md", ".vue", ".svelte", ".blade.php",
}
PATH_ONLY_EXT = {".md"}

EXCLUDE_DIR_NAMES = {
    ".git", ".myclaudecode", "node_modules", "dist", "build",
    "coverage", ".next", "__pycache__", ".venv", "venv", ".pytest_cache",
    "vendor",
}
EXCLUDE_FILENAMES = {
    "package-lock.json", "yarn.lock", "composer.lock", "pnpm-lock.yaml",
    "bundle.txt", "bundle.tmp", SELF_NAME,
}
EXCLUDE_FILENAME_PREFIXES = ["bundle_", ".env", "mcc_compile"]
EXCLUDE_PATH_KEYWORDS = ["scratch", "backup", "cache"]
MAX_FILE_CHARS = 500_000


def is_excluded_dir(dirname):
    lowered = dirname.lower()
    if dirname in EXCLUDE_DIR_NAMES:
        return True
    return any(kw in lowered for kw in EXCLUDE_PATH_KEYWORDS)


def is_bundle_output(basename):
    stem, ext = os.path.splitext(basename)
    return "bundle" in stem and ext in (".txt", ".md", ".tmp")


def is_excluded_file(full_path, ext):
    lowered = os.path.relpath(full_path, BASE_ROOT).lower()
    basename = os.path.basename(lowered)
    if ext and ext not in INCLUDE_EXT:
        return True
    if any(kw in lowered for kw in EXCLUDE_PATH_KEYWORDS):
        return True
    if basename in EXCLUDE_FILENAMES or is_bundle_output(basename):
        return True
    if any(basename.startswith(p) for p in EXCLUDE_FILENAME_PREFIXES):
        return True
    return False


def rel_of(path):
    return os.path.relpath(path, BASE_ROOT).replace(os.sep, "/")


def collect_files():
    collected = []
    for dirpath, dirnames, filenames in os.walk(BASE_ROOT):
        dirnames[:] = [d for d in dirnames if not is_excluded_dir(d)]
        for filename in filenames:
            full_path = os.path.join(dirpath, filename)
            ext = os.path.splitext(filename)[1].lower()
            if is_excluded_file(full_path, ext):
                continue
            try:
                if os.path.getsize(full_path) > MAX_FILE_CHARS:
                    continue
            except OSError:
                continue
            collected.append(full_path)
    collected.sort()
    return collected


def read_includes(path):
    with open(path, "r", encoding="utf-8") as f:
        items = [line.strip().strip('"').replace("\\", "/").strip("/") for line in f]
    out = []
    for item in items:
        if not item:
            continue
        if os.path.isabs(item) or item[1:2] == ":":
            item = rel_of(item)
        if item.startswith("./"):
            item = item[2:]
        out.append(item)
    return out


def selected(rel, includes):
    return any(rel == inc or rel.startswith(inc + "/") or inc in (".", "") for inc in includes)


def is_path_only(rel):
    return os.path.splitext(rel)[1].lower() in PATH_ONLY_EXT


def main():
    args = sys.argv[1:]
    files = collect_files()
    if "--list" in args:
        for path in files:
            rel = rel_of(path)
            try:
                size = os.path.getsize(path)
            except OSError:
                continue
            print("__FILE__ " + str(0 if is_path_only(rel) else size) + " " + rel)
        print("__BUNDLE_FILES__ " + str(len(files)))
        return
    includes = None
    if "--include" in args:
        includes = read_includes(args[args.index("--include") + 1])
        files = [p for p in files if selected(rel_of(p), includes)]
    out_parts = []
    out_parts.append("PROJECT BUNDLE\n")
    out_parts.append("Root: " + BASE_ROOT + "\n")
    out_parts.append("Files: " + str(len(files)) + "\n")
    out_parts.append("Markdown files are listed by path only; read one with !READ_FILE <path> if needed.\n")
    out_parts.append("=" * 70 + "\n\n")
    sizes = []
    for path in files:
        rel = rel_of(path)
        if is_path_only(rel):
            out_parts.append("----- FILE: " + rel + " (path only) -----\n\n")
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
        except (UnicodeDecodeError, PermissionError) as exc:
            content = "<<could not read: " + str(exc) + ">>"
        sizes.append((len(content), rel))
        out_parts.append("----- FILE: " + rel + " -----\n")
        out_parts.append(content)
        if not content.endswith("\n"):
            out_parts.append("\n")
        out_parts.append("\n")
    content = "".join(out_parts)
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, "w", encoding="utf-8") as f:
        f.write(content)
    for size, rel in sorted(sizes, reverse=True)[:15]:
        print("__LARGEST__ " + str(size) + " " + rel)
    print("__BUNDLE_CHARS__ " + str(len(content)))
    print("__BUNDLE_FILES__ " + str(len(files)))
    print("__BUNDLE_PATH__ " + OUTPUT)


if __name__ == "__main__":
    main()
`;

  // The project may already own a compile.py (a build script of its own). Ours is the one
  // that prints __BUNDLE_PATH__; anything else is left alone and we fall back to the next
  // free name below. The choice is kept on the session so every later run uses it.
  const COMPILE_PY_CANDIDATES = ['compile.py', 'mcc_compile.py', 'mcc_compile_2.py', 'mcc_compile_3.py'];
  const compilePyPath = (session) => session.compilePyPath || COMPILE_PY_CANDIDATES[0];
  const BUNDLE_PATH = '.myclaudecode/phased/bundle.txt';
  const BUNDLE_CHAR_LIMIT = 2400000;
  const TARGETED_BUNDLE_MAX_CHARS = 300000;
  const TARGETED_CONTENT_BUDGET = 300000;

  function notifyCli(session, payload) {
    if (session.cancelled) return;
    NativeBridge.sendToCli({ taskId: session.taskId, ...payload });
  }

  function toForwardSlash(p) {
    return String(p || '').replace(/\\/g, '/');
  }

  // --- compile.py lifecycle -------------------------------------------------

  async function ensureCompilePy(session) {
    if (session.compilePyPath) return;
    let name = null;
    for (const candidate of COMPILE_PY_CANDIDATES) {
      let existing = null;
      try {
        existing = await NativeBridge.execTool(session.taskId, TOOLS.READ_FILE, { path: candidate });
      } catch (_) {
        name = candidate; // free -- create it below
        break;
      }
      if (typeof existing === 'string' && existing.includes('__BUNDLE_PATH__')) {
        if (existing.includes('MCC_COMPILE_VERSION = 2')) {
          session.compilePyPath = candidate;
          return;
        }
        name = candidate;
        break;
      }
    }
    if (!name) {
      throw new Error(`compile.py and all fallback names (${COMPILE_PY_CANDIDATES.join(', ')}) belong to the project`);
    }
    try {
      await NativeBridge.execTool(session.taskId, TOOLS.WRITE_FILE, {
        path: name,
        content: COMPILE_PY_TEMPLATE.replace(/compile\.py/g, name).replace('__SELF_NAME__', name),
      });
      session.compilePyPath = name;
      if (typeof PhasedLogStore !== 'undefined' && PhasedLogStore.appendAttention) {
        await PhasedLogStore.appendAttention(session, {
          kind: 'compile_py_bootstrapped',
          severity: 'low',
          detail: `auto-created ${name}; edit its exclusion lists if the bundle is too large`,
        }).catch(() => {});
      }
    } catch (err) {
      throw new Error(
        `compile.py missing and cannot be auto-created — check project root permissions (${err.message})`
      );
    }
  }

  // --- bundle metadata run --------------------------------------------------

  async function runCompileAndRead(session, extraArgs) {
    const rootFwd = toForwardSlash(session.projectRoot);
    const command = `cd "${rootFwd}" && python ${compilePyPath(session)}${extraArgs ? ' ' + extraArgs : ''}`;
    const res = await NativeBridge.execTool(session.taskId, TOOLS.SHELL, { command });
    const stdout = (res && res.stdout) || '';
    const stderr = (res && res.stderr) || '';
    const exitCode = res && res.exitCode;
    const meta = PhasedMarkers.parseBundleMeta(stdout);
    if (meta.chars === null) {
      throw new Error(
        'compile.py must print __BUNDLE_CHARS__. See README (## compile.py). ' +
          `stderr: ${stderr.slice(0, 400)}`
      );
    }
    if (exitCode !== 0) {
      throw new Error(`compile.py exited ${exitCode}. stderr: ${stderr.slice(0, 400)}`);
    }
    let content = '';
    try {
      content = await NativeBridge.execTool(session.taskId, TOOLS.READ_FILE, { path: BUNDLE_PATH });
    } catch (err) {
      throw new Error(`could not read built bundle at ${BUNDLE_PATH}: ${err.message}`);
    }
    const largest = [];
    const largestRe = /^__LARGEST__\s+(\d+)\s+(.+)$/gm;
    let m;
    while ((m = largestRe.exec(stdout)) !== null) largest.push({ chars: Number(m[1]), path: m[2].trim() });
    return { content, chars: meta.chars, files: meta.files, path: meta.path, largest };
  }

  const INCLUDE_LIST_PATH = '.myclaudecode/phased/include.txt';
  const FILE_LIST_MAX_CHARS = 40000;

  function selectedBundleLimit(session) {
    return (session.phasedConfig && session.phasedConfig.bundleCharLimit) || 100000;
  }

  async function listProjectFiles(session) {
    await ensureCompilePy(session);
    const rootFwd = toForwardSlash(session.projectRoot);
    const res = await NativeBridge.execTool(session.taskId, TOOLS.SHELL, {
      command: `cd "${rootFwd}" && python ${compilePyPath(session)} --list`,
    });
    const stdout = (res && res.stdout) || '';
    const files = [];
    const re = /^__FILE__\s+(\d+)\s+(.+)$/gm;
    let m;
    while ((m = re.exec(stdout)) !== null) files.push({ chars: Number(m[1]), path: m[2].trim() });
    if (!files.length && res && res.exitCode !== 0) {
      throw new Error(`${compilePyPath(session)} --list failed: ${((res && res.stderr) || '').slice(0, 300)}`);
    }
    return files;
  }

  function formatFileList(files, limit) {
    const total = files.reduce((n, f) => n + f.chars, 0);
    const lines = files.map((f) => (f.chars ? `${f.chars}\t${f.path}` : `md\t${f.path}`));
    let body = lines.join('\n');
    if (body.length > FILE_LIST_MAX_CHARS) {
      body = body.slice(0, FILE_LIST_MAX_CHARS) + `\n…(${lines.length} files total, list truncated)`;
    }
    return `PROJECT FILES (${files.length} files, ${total} chars of code; bundle limit ${limit} chars)\n` +
      `chars\tpath   ("md" = markdown, bundled as path only)\n${body}`;
  }

  const BRAIN_COMPILE_PATH = '.myclaudecode/phased/compile.py';
  const FORBIDDEN_IN_COMPILE = [
    [/\bsubprocess\b|\bos\.system\b|\bos\.popen\b|\bpty\b/, 'runs other programs'],
    [/\bos\.(remove|unlink|rmdir|removedirs|rename|replace|makedirs|mkdir|chmod|truncate)\b|\bshutil\b|\brmtree\b/, 'changes the filesystem'],
    [/\.(write_text|write_bytes|unlink|rename|touch|mkdir|rmdir|symlink_to|hardlink_to|chmod)\s*\(/, 'changes the filesystem'],
    [/\bopen\s*\([^,)]*,\s*['"][^'"]*[wax+]|\bmode\s*=\s*['"][^'"]*[wax+]/, 'opens a file for writing'],
    [/\b(requests|urllib|http\.client|socket)\b/, 'uses the network'],
    [/\b(exec|eval|__import__)\s*\(/, 'runs dynamic code'],
  ];

  function checkCompileScript(script) {
    for (const [re, why] of FORBIDDEN_IN_COMPILE) {
      if (re.test(script)) return `the script ${why} (${(script.match(re) || [''])[0]}). compile.py must be read-only.`;
    }
    return null;
  }

  async function compileFromScript(session, script) {
    const limit = selectedBundleLimit(session);
    const problem = checkCompileScript(script || '');
    if (!script || !script.trim()) {
      return { ok: false, error: 'no ```python block followed !COMPILE_BUNDLE', limit, chars: 0, largest: [] };
    }
    if (problem) return { ok: false, error: problem, limit, chars: 0, largest: [] };
    await NativeBridge.execTool(session.taskId, TOOLS.WRITE_FILE, { path: BRAIN_COMPILE_PATH, content: script });
    const rootFwd = toForwardSlash(session.projectRoot);
    const res = await NativeBridge.execTool(session.taskId, TOOLS.SHELL, {
      command: `cd "${rootFwd}" && PYTHONIOENCODING=utf-8 python "${BRAIN_COMPILE_PATH}" > "${BUNDLE_PATH}"`,
    });
    if (res && res.exitCode !== 0) {
      return { ok: false, error: `compile.py exited ${res.exitCode}: ${((res.stderr) || '').slice(-1500)}`, limit, chars: 0, largest: [] };
    }
    const content = await NativeBridge.execTool(session.taskId, TOOLS.READ_FILE, { path: BUNDLE_PATH });
    const text = typeof content === 'string' ? content : '';
    const sizes = [];
    const re = /^----- FILE: (.+?) -----$/gm;
    let m;
    let prev = null;
    while ((m = re.exec(text)) !== null) {
      if (prev) sizes.push({ path: prev.path, chars: m.index - prev.at });
      prev = { path: m[1], at: m.index };
    }
    if (prev) sizes.push({ path: prev.path, chars: text.length - prev.at });
    sizes.sort((a, b) => b.chars - a.chars);
    if (!text.trim()) return { ok: false, error: 'compile.py printed nothing', limit, chars: 0, largest: [] };
    return { ok: text.length <= limit, content: text, chars: text.length, files: sizes.length, limit, largest: sizes.slice(0, 15) };
  }

  async function compileSelected(session, paths) {
    const limit = selectedBundleLimit(session);
    const clean = (paths || []).map((p) => String(p).trim()).filter(Boolean);
    if (!clean.length) throw new Error('!COMPILE_BUNDLE needs at least one path or directory.');
    await ensureCompilePy(session);
    await NativeBridge.execTool(session.taskId, TOOLS.WRITE_FILE, {
      path: INCLUDE_LIST_PATH,
      content: clean.join('\n') + '\n',
    });
    const built = await runCompileAndRead(session, `--include "${INCLUDE_LIST_PATH}"`);
    return {
      ok: built.chars <= limit && built.files > 0,
      content: built.content,
      chars: built.chars,
      files: built.files,
      limit,
      largest: built.largest,
    };
  }

  // --- targeted bundle (spec 4.1) -------------------------------------------

  // Reads the current a.py for the current phase from the scripts dir. LS is used instead
  // of FIND_FILE because FIND_FILE ignores .myclaudecode by default. The last matching
  // line is the most recent attempt -- alphabetical sort places repair_NN after the plain
  // filename, so we prefer the last one.
  async function findCurrentApy(session) {
    const phaseNum = (session.currentPhaseIndex || 0) + 1;
    const prefix = `phase_${String(phaseNum).padStart(2, '0')}_`;
    try {
      const ls = await NativeBridge.execTool(session.taskId, TOOLS.LS, {
        path: '.myclaudecode/phased/scripts',
      });
      if (typeof ls !== 'string' || !ls.trim()) return null;
      const matches = ls
        .split('\n')
        .filter((line) => line.includes(prefix) && line.endsWith('.py'));
      if (!matches.length) return null;
      const lastName = matches[matches.length - 1].split(/\s+/).pop();
      return `.myclaudecode/phased/scripts/${lastName}`;
    } catch (_) {
      return null;
    }
  }

  async function buildTargeted(session) {
    const parts = [];
    const push = (label, body) => parts.push(`=== ${label} ===\n${body || '(none)'}\n`);

    push('TASK', session.taskDescription || '');
    const phase =
      (session.phasePlan && session.phasePlan[session.currentPhaseIndex]) || null;
    if (phase) {
      const goal = phase.goal || '(no goal)';
      const filesList = (phase.files || []).join(', ') || '(none)';
      const tests = phase.tests || '(unspecified)';
      push(
        'CURRENT PHASE',
        `Phase ${(session.currentPhaseIndex || 0) + 1}: ${phase.name || '?'}\n` +
          `Goal: ${goal}\nFiles: ${filesList}\nTests: ${tests}`
      );
    } else {
      push('CURRENT PHASE', '(no phase plan or phase index set)');
    }

    // Current a.py if it exists (best-effort).
    let apyContent = '(no a.py written yet)';
    const apyPath = await findCurrentApy(session);
    if (apyPath) {
      try {
        const apy = await NativeBridge.execTool(session.taskId, TOOLS.READ_FILE, { path: apyPath });
        if (typeof apy === 'string') apyContent = `(from ${apyPath})\n${apy}`;
      } catch (_) {}
    }
    push('CURRENT a.py', apyContent);
    push('TRACEBACK FROM LAST RUN', (session.lastTraceback || '').slice(0, 4000) || '(none)');

    // Log tail.
    let logTail = '(no log entries yet)';
    try {
      const entries = await PhasedLogStore.readLog(session, 10);
      if (entries.length) {
        logTail = entries
          .map((e) => `[${e.phase || '?'} attempt ${e.attempt || '?'}] exit=${e.exitCode} marker=${e.successMarker} files=${(e.filesTouched || []).join(',') || 'none'}`)
          .join('\n')
          .slice(-2000);
      }
    } catch (_) {}
    push('RECENT LOG', logTail);

    // External changes via filetrack (Phase 5 has the wrapper; Phase 4 skips gracefully).
    let externalChanges = '(filetrack not available)';
    if (typeof PhasedFiletrack !== 'undefined' && PhasedFiletrack.summarizeForPrompt) {
      try {
        externalChanges = await PhasedFiletrack.summarizeForPrompt(session);
      } catch (_) {}
    }
    push('EXTERNAL CHANGES', externalChanges);

    // Phase-owned file contents.
    if (phase && Array.isArray(phase.files) && phase.files.length) {
      const chunks = [];
      let budget = TARGETED_CONTENT_BUDGET;
      for (const f of phase.files) {
        if (budget <= 0) {
          chunks.push(`(budget exhausted — remaining files omitted)`);
          break;
        }
        try {
          const text = await NativeBridge.execTool(session.taskId, TOOLS.READ_FILE, { path: f });
          if (typeof text === 'string') {
            const snippet = text.length > budget ? text.slice(0, budget) + '\n…(truncated)' : text;
            chunks.push(`--- ${f} ---\n${snippet}`);
            budget -= snippet.length;
          }
        } catch (_) {
          chunks.push(`--- ${f} --- (unreadable or does not exist yet)`);
        }
      }
      push('PHASE-OWNED FILE CONTENTS', chunks.join('\n\n'));
    } else {
      push('PHASE-OWNED FILE CONTENTS', '(no files declared by current phase)');
    }

    const text = parts.join('\n');
    if (text.length > TARGETED_BUNDLE_MAX_CHARS) {
      return text.slice(0, TARGETED_BUNDLE_MAX_CHARS) + '\n…(targeted bundle truncated at limit)';
    }
    return text;
  }

  // --- full bundle + exclusion loop (spec 4.2) ------------------------------

  async function buildFull(session) {
    await ensureCompilePy(session);
    const first = await runCompileAndRead(session);
    if (first.chars <= BUNDLE_CHAR_LIMIT) {
      return { mode: 'full', content: first.content, chars: first.chars };
    }
    notifyCli(session, {
      type: CLI_MESSAGE_TYPES.BUNDLE_TOO_LARGE,
      chars: first.chars,
      threshold: BUNDLE_CHAR_LIMIT,
    });
    const result = await runExclusionLoop(session, first.chars);
    if (result.stillTooLarge) {
      throw new Error(
        `Full bundle still exceeds ${BUNDLE_CHAR_LIMIT} chars after exclusion loop (${result.chars}). Phase too large — split manually.`
      );
    }
    const second = await runCompileAndRead(session);
    return { mode: 'full', content: second.content, chars: second.chars };
  }

  async function _applyExclusionEdit(session, oldStr, newStr) {
    try {
      await NativeBridge.execTool(session.taskId, TOOLS.EDIT_FILE, {
        path: compilePyPath(session),
        oldString: oldStr,
        newString: newStr,
      });
    } catch (err) {
      console.warn('[PhasedBundleBuilder] exclusion edit failed:', err.message);
    }
  }

  async function _dropTests(session) {
    await _applyExclusionEdit(
      session,
      `EXCLUDE_DIR_NAMES = {\n    ".git", ".myclaudecode", "node_modules", "dist", "build",\n    "coverage", ".next", "__pycache__", ".venv", "venv", ".pytest_cache",\n    "vendor",\n}`,
      `EXCLUDE_DIR_NAMES = {\n    ".git", ".myclaudecode", "node_modules", "dist", "build",\n    "coverage", ".next", "__pycache__", ".venv", "venv", ".pytest_cache",\n    "vendor", "test", "tests", "__tests__",\n}`
    );
  }

  async function _dropDocs(session) {
    await _applyExclusionEdit(
      session,
      `    ".toml", ".ini", ".env.example", ".md", ".vue", ".svelte", ".blade.php",\n}`,
      `    ".toml", ".ini", ".env.example", ".vue", ".svelte", ".blade.php",\n}`
    );
  }

  async function runExclusionLoop(session, initialChars) {
    const maxRounds = (session.phasedConfig && session.phasedConfig.exclusionRoundsMax) || 3;
    let chars = initialChars;
    let round = 0;
    while (chars > BUNDLE_CHAR_LIMIT && round < maxRounds) {
      if (session.cancelled) throw new Error('Task cancelled.');
      round++;
      notifyCli(session, { type: CLI_MESSAGE_TYPES.EXCLUSION_ROUND_STARTED, round });
      // Phase 5 may provide brain-driven exclusion proposals. Phase 4 falls straight to
      // deterministic steps (spec 4.2 step 1: lockfiles/build dirs are ALREADY in the
      // template's default exclusion list, so step 1 is a no-op here; steps 2 and 3 run
      // via EDIT_FILE below).
      if (typeof PhasedBrainLayer !== 'undefined' && PhasedBrainLayer.proposeExclusions) {
        try {
          await PhasedBrainLayer.proposeExclusions(session, chars);
        } catch (err) {
          console.warn('[PhasedBundleBuilder] brain exclusion proposal failed:', err.message);
        }
      } else {
        if (round === 1) await _dropTests(session);
        else if (round === 2) await _dropDocs(session);
        // rounds 3+: no more deterministic batch drops implemented in Phase 4
      }
      try {
        const rebuilt = await runCompileAndRead(session);
        chars = rebuilt.chars;
      } catch (err) {
        console.warn('[PhasedBundleBuilder] recompile failed:', err.message);
        break;
      }
      notifyCli(session, {
        type: CLI_MESSAGE_TYPES.EXCLUSION_ROUND_DONE,
        round,
        chars,
        stillTooLarge: chars > BUNDLE_CHAR_LIMIT,
      });
      if (typeof PhasedLogStore !== 'undefined' && PhasedLogStore.appendAttention) {
        await PhasedLogStore.appendAttention(session, {
          kind: 'exclusion_round',
          severity: 'medium',
          detail: `round ${round}: bundle now ${chars} chars (limit ${BUNDLE_CHAR_LIMIT})`,
        }).catch(() => {});
      }
    }
    return { chars, stillTooLarge: chars > BUNDLE_CHAR_LIMIT };
  }

  return {
    ensureCompilePy,
    compilePyPath,
    listProjectFiles,
    formatFileList,
    compileSelected,
    compileFromScript,
    selectedBundleLimit,
    buildTargeted,
    buildFull,
    runExclusionLoop,
    BUNDLE_CHAR_LIMIT,
  };
})();
