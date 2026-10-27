// Deterministic script filenames (spec section 3.3). The orchestrator -- not the brain and
// not the coder -- picks these names, which prevents duplicate-file bugs and makes repairs
// diffable against originals. Alphabetical sort == chronological, because NN is zero-padded.
//
//   direct    task_<slug>.py              e.g. task_add_dark_mode_toggle.py
//   phased    phase_<NN>_<slug>.py        e.g. phase_03_orchestrator.py
//   repair    phase_<NN>_repair_<MM>.py   e.g. phase_03_repair_02.py
const PhasedScriptNaming = (() => {
  const SLUG_MAX = 40;

  // Lowercase, non-alphanumerics -> single underscores, trimmed, capped. Falls back to
  // 'phase' if the input has no usable characters (e.g. a name that's entirely punctuation).
  function slugify(text) {
    const s = String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return s.slice(0, SLUG_MAX) || 'phase';
  }

  function pad(n, width) {
    return String(n).padStart(width, '0');
  }

  // `index` is 1-based (matches the PHASE_STARTED message's index/total convention).
  // `attempt` is 1-based; attempt === 1 produces the plain name, attempt >= 2 produces
  // the repair variant so originals and fixes coexist on disk for diagnosis.
  function phaseFilename(index, name, attempt) {
    const nn = pad(index, 2);
    if (attempt > 1) {
      return `phase_${nn}_repair_${pad(attempt, 2)}.py`;
    }
    return `phase_${nn}_${slugify(name)}.py`;
  }

  function directFilename(slug) {
    return `task_${slugify(slug)}.py`;
  }

  return { slugify, phaseFilename, directFilename };
})();
