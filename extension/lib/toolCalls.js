// Parses the simple !TOOL protocol the planner/executor primers instruct the
// model to use. See readme.md section 8 ("Executor tool handling").

const ToolCallParser = (() => {
  // Deliberately anchored to (trimmed) line-start, not matched anywhere in the line.
  // Tried relaxing this once — it backfired: a model narrating what it *imagines*
  // happened ("Executor reports: !SHELL command executed: mkdir sandbox && ...
  // Output:") got its narration parsed as a REAL command and actually executed,
  // corrupting real files with garbage. Missing a real call (handled by the
  // near-miss nudge below) is a far safer failure mode than executing invented
  // text as if it were a genuine instruction.
  const TOOL_LINE_RE = /^!(\s*)?(READ_FILE|WRITE_FILE|SHELL|GREP|FIND_FILE|LS|SEARCH_WEB|ASK_USER|DELETE_FILE|OPEN_APP|HTTP_GET|EDIT_FILE|SHELL_BG|PROC_LIST|PROC_LOG|PROC_KILL|CALL_[A-Za-z0-9_]+)\b[ \t]*(.*)$/;

  // Loose, unanchored check used only to detect "the model clearly meant to invoke
  // a tool but didn't format it as its own line" so we can nudge for a retry,
  // never to actually execute anything.
  const TOOL_MENTION_RE = /!(READ_FILE|WRITE_FILE|SHELL|GREP|FIND_FILE|LS|SEARCH_WEB|ASK_USER|DELETE_FILE|OPEN_APP|HTTP_GET|EDIT_FILE|SHELL_BG|PROC_LIST|PROC_LOG|PROC_KILL|CALL_[A-Za-z0-9_]+)\b/;

  // Observed live: several intended-to-be-separate "!TOOL arg" lines can arrive as a single
  // line with no real newline between them (e.g. the chat UI's response text collapsing a
  // paragraph break) — TOOL_LINE_RE only matches the first one, and everything after
  // (including the later "!TOOL"s) gets swallowed whole into the first call's argument
  // string. Executing that garbled param (e.g. READ_FILE on a path containing literal
  // "!READ_FILE ... !LS ..." text) just produces a confusing "file not found" the model then
  // has to puzzle out — a wasted round-trip. Any call whose param values still contain
  // another tool marker is almost certainly this corruption, not a real path/command, so it
  // gets filtered out of the executable calls and reported back as a specific parse failure
  // instead (see hasCorruptedToolCall / orchestrator.js).
  const EMBEDDED_TOOL_RE = /!(READ_FILE|WRITE_FILE|SHELL|GREP|FIND_FILE|LS|SEARCH_WEB|ASK_USER|DELETE_FILE|OPEN_APP|HTTP_GET|EDIT_FILE|SHELL_BG|PROC_LIST|PROC_LOG|PROC_KILL|CALL_[A-Za-z0-9_]+)\b/;

  // WRITE_FILE's `content` and GREP's `pattern` are the two params deliberately meant to
  // hold arbitrary free-form text chosen by the model — genuinely writing documentation
  // about this tool protocol (readme.md itself has literal "!DELETE_FILE" text) or grepping
  // the codebase for a tool name both legitimately produce a param value containing a
  // "!TOOL"-looking substring. Scanning those for corruption caused real, correctly-parsed
  // calls to be misdiagnosed and dropped. Every other param (path/command/glob/query) comes
  // straight off the single `rest` line and is a genuine signal of the merged-line
  // corruption this check exists to catch.
  const CORRUPTION_SCAN_EXEMPT = {
    WRITE_FILE: new Set(['content']),
    GREP: new Set(['pattern']),
    EDIT_FILE: new Set(['oldString', 'newString']),
  };

  function looksCorrupted(call) {
    const exempt = CORRUPTION_SCAN_EXEMPT[call.tool];
    return Object.entries(call.params || {}).some(
      ([key, v]) => !(exempt && exempt.has(key)) && typeof v === 'string' && EMBEDDED_TOOL_RE.test(v)
    );
  }

  function parseQuotedFirstArg(rest) {
    const trimmed = rest.trim();
    if (trimmed.startsWith('"')) {
      const end = trimmed.indexOf('"', 1);
      if (end !== -1) {
        return { first: trimmed.slice(1, end), remainder: trimmed.slice(end + 1).trim() };
      }
    }
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) return { first: trimmed, remainder: '' };
    return { first: trimmed.slice(0, spaceIdx), remainder: trimmed.slice(spaceIdx + 1).trim() };
  }

  // Returns an ordered list of { tool, params, raw } tool calls found in `text`, including
  // any that look corrupted (see looksCorrupted above) — parseToolCalls (below) is the
  // public entry point and filters those out before anything gets executed.
  function parseToolCallsRaw(text) {
    const lines = text.split('\n');
    const calls = [];

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(TOOL_LINE_RE);
      if (!match) continue;
      const tool = match[2];
      let rest = match[3] || '';

      // Models trained on function-calling APIs sometimes write JSON args instead of the
      // plain positional form we primed them for, e.g. `!SHELL {"command": "mkdir foo"}`.
      // Observed live: passing that raw JSON straight through as the literal shell command
      // string caused bash to fail on the leading `{`. Detect and unwrap it here so every
      // tool below keeps working of the plain string it expects either way.
      const trimmedRest = rest.trim();
      if (trimmedRest.startsWith('{')) {
        try {
          const args = JSON.parse(trimmedRest);
          if (tool === 'ASK_USER' && typeof args.question === 'string') {
            calls.push({
              tool,
              params: { question: args.question, options: Array.isArray(args.options) ? args.options.filter((o) => typeof o === 'string') : [] },
            });
            continue;
          }
          if (tool === 'READ_FILE' && typeof args.path === 'string') {
            calls.push({
              tool,
              params: {
                path: args.path,
                offset: typeof args.offset === 'number' ? args.offset : undefined,
                limit: typeof args.limit === 'number' ? args.limit : undefined,
              },
            });
            continue;
          }
          if (
            tool === 'EDIT_FILE' &&
            typeof args.path === 'string' &&
            typeof args.oldString === 'string' &&
            typeof args.newString === 'string'
          ) {
            calls.push({ tool, params: { path: args.path, oldString: args.oldString, newString: args.newString } });
            continue;
          }
          const key = {
            SHELL: 'command',
            READ_FILE: 'path',
            WRITE_FILE: 'path',
            FIND_FILE: 'glob',
            LS: 'path',
            SEARCH_WEB: 'query',
            GREP: 'pattern',
            DELETE_FILE: 'path',
            OPEN_APP: 'command',
            HTTP_GET: 'url',
            SHELL_BG: 'command',
            PROC_KILL: 'id',
          }[tool];
          if (key && typeof args[key] === 'string') {
            rest = tool === 'GREP' && typeof args.path === 'string' ? `${args[key]} ${args.path}` : args[key];
            if (tool === 'WRITE_FILE' && typeof args.content === 'string') {
              calls.push({ tool, params: { path: args.path, content: args.content } });
              continue;
            }
          }
        } catch (_) {
          // Not actually valid JSON — fall through and treat it as plain text as before.
        }
      }

      if (tool === 'ASK_USER') {
        // !ASK_USER "question text" | option one | option two | option three
        // The pipe-separated tail is optional — omit it entirely for a free-text question.
        const { first, remainder } = parseQuotedFirstArg(rest);
        const options = remainder
          ? remainder.split('|').map((o) => o.trim()).filter(Boolean)
          : [];
        calls.push({ tool, params: { question: first, options } });
        continue;
      }

      if (tool === 'WRITE_FILE') {
        // Look ahead for a fenced code block first — that's what we prime the model
        // for — but real models (unprompted by our mock scenarios) often write the
        // path and a quoted/raw content inline on one line instead, e.g.
        // `!WRITE_FILE hello.txt "Hello, world!\n"`. Fall back to splitting that.
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j < lines.length && lines[j].trim().startsWith('```')) {
          const filePath = rest.trim();
          const contentLines = [];
          let k = j + 1;
          while (k < lines.length && !lines[k].trim().startsWith('```')) {
            contentLines.push(lines[k]);
            k++;
          }
          calls.push({ tool, params: { path: filePath, content: contentLines.join('\n') } });
          i = k; // skip past the closing fence
        } else {
          const trimmed = rest.trim();
          const spaceIdx = trimmed.indexOf(' ');
          if (spaceIdx === -1) {
            calls.push({ tool, params: { path: trimmed, content: '' } });
          } else {
            const filePath = trimmed.slice(0, spaceIdx);
            const firstLineRemainder = trimmed.slice(spaceIdx + 1);
            const quoteChar = /^["']/.test(firstLineRemainder) ? firstLineRemainder[0] : null;

            if (!quoteChar) {
              calls.push({ tool, params: { path: filePath, content: firstLineRemainder.trim() } });
            } else {
              const body = firstLineRemainder.slice(1);
              const closeIdx = body.lastIndexOf(quoteChar);
              if (closeIdx !== -1 && closeIdx === body.length - 1) {
                // Whole value fits on this line, e.g. "content\nwith\nescapes".
                let content = body.slice(0, closeIdx);
                content = content.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
                calls.push({ tool, params: { path: filePath, content } });
              } else {
                // The model put real (unescaped) line breaks inside the quotes instead —
                // observed in practice: content silently truncated to just the first line
                // when we didn't handle this. Scan forward for the line with the closing
                // quote, preserving the real newlines in between as the file content.
                const contentLines = [body];
                let k = i + 1;
                let closed = false;
                while (k < lines.length) {
                  const lineCloseIdx = lines[k].lastIndexOf(quoteChar);
                  if (lineCloseIdx !== -1) {
                    contentLines.push(lines[k].slice(0, lineCloseIdx));
                    closed = true;
                    break;
                  }
                  contentLines.push(lines[k]);
                  k++;
                }
                calls.push({ tool, params: { path: filePath, content: contentLines.join('\n') } });
                if (closed) i = k;
              }
            }
          }
        }
        continue;
      }

      if (tool === 'EDIT_FILE') {
        // !EDIT_FILE <path>
        // ```
        // <old text — must appear exactly once in the file>
        // ```
        // ```
        // <new text>
        // ```
        // Two back-to-back fenced blocks (any/no info string — read positionally: first
        // fence is old, second is new, so the model doesn't have to get a label exactly
        // right). Anything else after the tool line is treated as "malformed" and produces
        // no call — mentionsUncalledTool then nudges the model to retry in the right format,
        // the same recovery path WRITE_FILE's own malformed cases fall back to.
        const filePath = rest.trim();
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j < lines.length && lines[j].trim().startsWith('```')) {
          const oldLines = [];
          let k = j + 1;
          while (k < lines.length && !lines[k].trim().startsWith('```')) {
            oldLines.push(lines[k]);
            k++;
          }
          let m = k + 1;
          while (m < lines.length && lines[m].trim() === '') m++;
          if (m < lines.length && lines[m].trim().startsWith('```')) {
            const newLines = [];
            let n = m + 1;
            while (n < lines.length && !lines[n].trim().startsWith('```')) {
              newLines.push(lines[n]);
              n++;
            }
            calls.push({ tool, params: { path: filePath, oldString: oldLines.join('\n'), newString: newLines.join('\n') } });
            i = n; // skip past the closing fence of the second block
          } else {
            i = k; // only one fence found — malformed; skip past it and let the near-miss nudge handle it
          }
        }
        continue;
      }

      if (tool === 'GREP') {
        const { first, remainder } = parseQuotedFirstArg(rest);
        calls.push({ tool, params: { pattern: first, path: remainder || '.' } });
        continue;
      }

      if (tool === 'READ_FILE') {
        // !READ_FILE <path> [offset] [limit] — trailing numeric tokens (up to 2) are the
        // pagination args; anything else stays part of the path. Both omitted reads the
        // whole file (or its first READ_FILE_DEFAULT_MAX_LINES if it's huge — see tools.js).
        const tokens = rest.trim().split(/\s+/).filter(Boolean);
        const numeric = [];
        while (tokens.length > 1 && numeric.length < 2 && /^\d+$/.test(tokens[tokens.length - 1])) {
          numeric.unshift(tokens.pop());
        }
        const [offset, limit] = numeric;
        calls.push({
          tool,
          params: {
            path: tokens.join(' '),
            offset: offset !== undefined ? Number(offset) : undefined,
            limit: limit !== undefined ? Number(limit) : undefined,
          },
        });
      } else if (tool === 'FIND_FILE') {
        calls.push({ tool, params: { glob: rest.trim() } });
      } else if (tool === 'LS') {
        calls.push({ tool, params: { path: rest.trim() || '.' } });
      } else if (tool === 'SEARCH_WEB') {
        calls.push({ tool, params: { query: rest.trim() } });
      } else if (tool === 'SHELL') {
        calls.push({ tool, params: { command: rest.trim() } });
      } else if (tool === 'DELETE_FILE') {
        calls.push({ tool, params: { path: rest.trim() } });
      } else if (tool === 'OPEN_APP') {
        calls.push({ tool, params: { command: rest.trim() } });
      } else if (tool === 'HTTP_GET') {
        calls.push({ tool, params: { url: rest.trim() } });
      } else if (tool === 'SHELL_BG') {
        calls.push({ tool, params: { command: rest.trim() } });
      } else if (tool === 'PROC_LIST') {
        calls.push({ tool, params: {} });
      } else if (tool === 'PROC_LOG') {
        const trimmed = rest.trim();
        const spaceIdx = trimmed.indexOf(' ');
        const id = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
        const linesArg = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
        calls.push({ tool, params: { id, lines: linesArg ? Number(linesArg) : undefined } });
      } else if (tool === 'PROC_KILL') {
        calls.push({ tool, params: { id: rest.trim() } });
      } else if (tool.startsWith('CALL_')) {
        // !CALL_<NAME> arg1 arg2 ... — declarative external tools (.myclaudecode/tools.json,
        // see orchestrator.js). Unlike every other tool here, the set of valid names isn't
        // known statically; TOOL_LINE_RE's CALL_[A-Za-z0-9_]+ alternative matches any of
        // them, and orchestrator.js looks the actual name up against what's configured —
        // an unrecognized one just comes back as a normal "unknown tool" error, same
        // failure mode as any other unrecognized command.
        calls.push({ tool, params: { args: rest.trim() ? rest.trim().split(/\s+/) : [] } });
      }
    }
    return calls;
  }

  // Public entry point — only ever returns calls safe to actually execute.
  function parseToolCalls(text) {
    return parseToolCallsRaw(text).filter((c) => !looksCorrupted(c));
  }

  // True if the raw text contained at least one call that parseToolCalls silently dropped
  // for looking corrupted — lets the orchestrator tell the model specifically what went
  // wrong instead of it having to infer that from an unrelated tool error (or, worse, from
  // nothing at all if every call in the message was corrupted).
  function hasCorruptedToolCall(text) {
    return parseToolCallsRaw(text).some(looksCorrupted);
  }

  function extractBlock(text, tag) {
    // Tolerate attributes inside the opening tag (e.g. `[SUBTASK id=1 goal="..."]`) — real
    // models don't always stick to the bare `[SUBTASK]` form we primed them with, and a
    // strict match here means silently never delegating anything to the executor.
    const re = new RegExp(`\\[${tag}(?:\\s[^\\]]*)?\\]([\\s\\S]*?)\\[/${tag}\\]`);
    const m = text.match(re);
    if (m) return m[1].trim();

    // Observed live: models sometimes never close the tag at all, instead writing
    // their own free-form variant like `[SUBTASK 1: Create sandbox]do the thing...`
    // and then just continuing to narrate indefinitely with no closing marker anywhere
    // in the message. Silently returning null here meant the executor was NEVER
    // actually dispatched to — the model just narrated both roles itself in one long
    // fabricated monologue, since our system never once interrupted with a real turn
    // boundary. Fall back to treating "opening tag to the next bracket tag or end of
    // string" as the block content whenever no proper closing tag exists.
    const openRe = new RegExp(`\\[${tag}(?:\\s[^\\]]*)?\\]`);
    const openMatch = text.match(openRe);
    if (!openMatch) return null;
    const afterOpen = text.slice(openMatch.index + openMatch[0].length);
    const nextTag = afterOpen.search(/\[[A-Z_]+/);
    const content = nextTag === -1 ? afterOpen : afterOpen.slice(0, nextTag);
    return content.trim() || null;
  }

  const extractSubtask = (text) => extractBlock(text, 'SUBTASK');
  const extractMemoryUpdate = (text) => extractBlock(text, 'MEMORY_UPDATE');
  const extractPlan = (text) => extractBlock(text, 'PLAN');
  const isAllDone = (text) => /\bALL_DONE\b/.test(text);
  const isDone = (text) => /\bDONE\b/.test(text) && !/\bALL_DONE\b/.test(text);

  const mentionsUncalledTool = (text) => TOOL_MENTION_RE.test(text) && parseToolCalls(text).length === 0;

  return {
    parseToolCalls,
    hasCorruptedToolCall,
    extractSubtask,
    extractMemoryUpdate,
    extractPlan,
    isAllDone,
    isDone,
    mentionsUncalledTool,
  };
})();
