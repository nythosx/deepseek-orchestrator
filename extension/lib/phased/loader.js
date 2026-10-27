// Loads every phased-mode module that exists, in dependency order. Background.js only
// importScripts's this file; each phase of the phased-mode rollout creates its own module
// under extension/lib/phased/ (or extension/lib/primers/), and this loader picks it up
// automatically. Modules that don't exist yet (because that phase hasn't run) log a warn
// and continue -- later phases activate on next SW restart with no further edits here.
//
// INVARIANT: every file in extension/lib/primers/ and extension/lib/phased/ must be
// listed here. There is no runtime auto-discovery (an MV3 service worker has no fs
// access), so a forgotten entry means that file's globals don't exist when other
// modules reference them -- silent at load time, ReferenceError at call time. See the
// Phase 11 fix (2026-10-25) where four primers were created but never added to this list;
// the failure only surfaced when buildTriagePrompt was first called.
//
// Order matters:
//   1. Primers first. They define module-scope consts (buildTriagePrompt, buildApyInitialPrompt,
//      buildApyFixPrompt, buildBrainReviewPrompt, buildEscalationPrompt, TIMESTAMP_NOTICE).
//      The phased modules below reference those consts from inside function bodies, so
//      technically they only need to be defined by call time, but loading primers first
//      avoids any temporal-dead-zone surprises if a future change moves a reference into
//      module-init code.
//   2. Helper modules next -- no cross-dependencies among them.
//   3. Consumer modules last -- brainLayer and runner depend on helpers and primers above.
const PHASED_MODULES = [
  // --- primers (definitions only; safe in any order among themselves) ---
  'lib/primers/timestampNotice.js',
  'lib/primers/triagePrimer.js',
  'lib/primers/apyCoderPrimer.js',
  'lib/primers/brainReviewPrimer.js',
  'lib/primers/escalationPrimer.js',
  // --- helper modules ---
  'lib/phased/markers.js',
  'lib/phased/scriptNaming.js',
  'lib/phased/logStore.js',
  'lib/phased/brainLog.js',
  'lib/phased/bundleBuilder.js',
  'lib/phased/migration.js',
  'lib/phased/triage.js',
  'lib/phased/brainPinger.js',
  'lib/phased/filetrack.js',
  'lib/phased/images.js',
  // --- consumer modules (depend on the helpers and primers above) ---
  'lib/phased/brainLayer.js',
  'lib/phased/runner.js',
];

for (const m of PHASED_MODULES) {
  try {
    importScripts(m);
  } catch (e) {
    console.warn('[phased] module not yet built, skipping:', m);
  }
}
