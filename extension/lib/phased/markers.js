// Marker parsing for a.py's self-reporting protocol (spec section B.1 + section 3.1).
//
// Every a.py ends with two stdout markers, each on its own line:
//   __PHASE_WROTE__ <comma,separated,paths>   -- printed once, BEFORE running tests
//   __PHASE_SUCCESS__                          -- printed once, AFTER all tests pass
//
// The orchestrator reads these from the LAST 200 LINES of stdout only -- this prevents a.py
// from printing __PHASE_SUCCESS__ at the top of the file before doing any real work.
const PhasedMarkers = (() => {
  const SUCCESS_MARKER_RE = /^__PHASE_SUCCESS__$/m;
  const WROTE_MARKER_RE = /^__PHASE_WROTE__[ \t]+(.+)$/m;
  const BUNDLE_CHARS_RE = /^__BUNDLE_CHARS__\s+(\d+)$/m;
  const BUNDLE_FILES_RE = /^__BUNDLE_FILES__\s+(\d+)$/m;
  const BUNDLE_PATH_RE = /^__BUNDLE_PATH__\s+(.+)$/m;
  const PLACEHOLDER_RE = /^\(?(none|n\/?a|null|empty|no|nothing)\)?$/i;

  function lastNlines(text, n) {
    if (!text) return '';
    return String(text).split('\n').slice(-n).join('\n');
  }

  function parseSuccess(stdout) {
    return SUCCESS_MARKER_RE.test(lastNlines(stdout, 200));
  }

  // Returns an array of paths, or [] if the marker isn't present in the last 200 lines.
  //
  // BUG FIX (2026-10-25): the previous regex was `\s+(.+)`. With the `m` flag, `\s`
  // matches newlines, so an empty __PHASE_WROTE__ (printed alone by the coder) followed
  // by __PHASE_SUCCESS__ on the next line caused the latter to be captured as the "file
  // path" -- observed live as `wrote: __PHASE_SUCCESS__` in CLI output. `[ \t]+` restricts
  // the separator to horizontal whitespace so the match cannot cross lines.
  function parseWrote(stdout) {
    const tail = lastNlines(stdout, 200);
    const m = tail.match(WROTE_MARKER_RE);
    if (!m) return [];
    return m[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !PLACEHOLDER_RE.test(s));
  }

  function parseBundleMeta(stdout) {
    const s = String(stdout || '');
    const chars = s.match(BUNDLE_CHARS_RE);
    const files = s.match(BUNDLE_FILES_RE);
    const path = s.match(BUNDLE_PATH_RE);
    return {
      chars: chars ? parseInt(chars[1], 10) : null,
      files: files ? parseInt(files[1], 10) : null,
      path: path ? path[1].trim() : null,
    };
  }

  function classify(run, successMarker) {
    if (run.exitCode !== 0) return { outcome: 'failure', reason: 'exit_nonzero' };
    if (!successMarker) return { outcome: 'soft_success', reason: 'missing_marker' };
    return { outcome: 'success', reason: 'marker_present' };
  }

  return { parseSuccess, parseWrote, parseBundleMeta, classify, lastNlines };
})();
