const { Writable } = require('stream');

// Owns the terminal the way Claude Code's own CLI does: stays on the REAL/main screen buffer
// (not the alternate one) so the terminal's own scrollback — mouse wheel, PgUp/PgDn, search —
// keeps working exactly like any other command-line output, and pins a small input box to the
// bottom by erasing-and-redrawing it in place, below whatever's been printed so far.
//
// Previous design used the alternate screen buffer (`?1049h`) with a DECSTBM-confined scroll
// region above the box. That's how `vim`/`less` work, but it comes with their tradeoff too:
// an alt-screen has no scrollback of its own on most terminals (Windows Terminal/ConPTY
// included), and content that scrolled off the top of a confined region is simply gone from
// the visible screen — there is nothing left to scroll back TO. That's the exact "unscrollable"
// bug reported live (2026-08-15): scrolling with the mouse wheel did nothing once output
// exceeded one screenful. Printing to the real buffer instead means every line this CLI has
// ever printed is real, ordinary terminal output — the terminal's own scrollback handles it
// the same as anything else, no special-casing needed here at all.
const ESC = '\x1b';

function write(s) {
  process.stdout.write(s);
}

class Screen {
  constructor() {
    this.active = false;
    this.inputLabel = '❯ ';
    this.statusText = '';
    this.hint = '';
    this.lastText = '';
    this.lastCursor = 0;
    // How many terminal rows the currently-drawn box (status + rule + input rows + rule +
    // hint) occupies right now, and which of those rows the cursor is currently parked on
    // (the input can span several wrapped rows — the cursor sits on whichever one the caret
    // is actually on, not always the box's first or last row), so erasing knows how far back
    // UP that is. Real scrolled-past content needs no tracking at all now; it's just normal
    // terminal output.
    this.boxLineCount = 0;
    this.boxCursorLineIndex = 0;
    this._onResize = this._onResize.bind(this);
  }

  // Read live, not cached — ui.js's terminalWidth() reads this on every print, and the only
  // thing that ever needs to be current is "what's the width right now" (used purely for
  // things like the divider rule length; the box itself already reads process.stdout.columns
  // directly in _render for the same reason).
  get cols() {
    return process.stdout.columns || 80;
  }

  enter() {
    if (!process.stdout.isTTY || this.active) return;
    this.active = true;
    // Claude Code's own CLI takes over a clean screen — the shell's own banner/copyright/
    // warning text (PowerShell's startup lines, the `PS C:\...>` prompt that launched us)
    // should still be real history one scroll away, just not sitting in view under our own
    // output. `\x1b[2J\x1b[H` (clear + home) is the standard way to do that — but observed
    // live (2026-08-15) on classic Windows PowerShell (conhost.exe, not Windows Terminal —
    // recognizable by its own "screen reader detected, PSReadLine disabled" startup warning):
    // it did nothing, and the old shell output stayed sitting in view above our banner. Legacy
    // conhost has a long history of only partially honoring `2J`/cursor-position sequences
    // depending on Windows version and console-mode flags, which no amount of retrying the
    // same escape codes fixes. Printing a full screen's worth of blank lines first is a much
    // more primitive fallback, but it can't fail to work anywhere: it's not an escape sequence
    // at all, just an ordinary scroll — the same thing that happens if a real person pressed
    // Enter `rows` times — so it unconditionally pushes whatever was on screen off the top of
    // the visible viewport before we print a single real line of our own. The `2J`/`H` pair
    // still runs afterward as a no-cost extra for terminals that DO support it properly (it
    // also resets the cursor to the true top-left, which the blank-line scroll alone doesn't
    // guarantee on every terminal).
    const rows = process.stdout.rows || 24;
    write('\n'.repeat(rows));
    write(`${ESC}[2J${ESC}[H`);
    write(`${ESC}[?25h`); // ensure cursor visible (defensive — a killed prior run could have left it hidden)
    // Bracketed paste mode — tells the terminal to wrap a pasted block in ESC[200~/ESC[201~
    // markers instead of sending it indistinguishable from fast typing. cli/index.js's
    // stdin filter relies on this to tell "the user pasted several lines" apart from "the
    // user is mashing Enter really fast," so a paste lands as literal newlines in the input
    // box instead of submitting a new task on every line it contains.
    write(`${ESC}[?2004h`);
    process.stdout.on('resize', this._onResize);
    this._render();
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    process.stdout.removeListener('resize', this._onResize);
    write(`${ESC}[?2004l`); // leave bracketed paste mode off for whatever shell/program comes next
    this._eraseBox();
  }

  _onResize() {
    // Nothing above the box needs replaying — it's real scrollback the terminal already owns.
    // Only the box itself depends on width, so just redraw it in place at the new size.
    this._render();
  }

  // Moves the cursor up to the first line of the currently-drawn box and erases everything
  // from there to the end of the screen — the standard "undraw sticky footer" move (same
  // technique the `log-update` package uses). Safe to call when nothing's drawn yet. The
  // cursor is always parked on whichever row the caret is on when this runs (that's where
  // the previous _render left it), so "up to the box's first line" is boxCursorLineIndex
  // rows, NOT boxLineCount rows — conflating the two was a real bug caught before ever
  // shipping this: it would erase starting partway into the PREVIOUS box instead of its
  // actual first line, leaving stray fragments of the old status/rule line on screen above
  // the new one.
  _eraseBox() {
    if (this.boxLineCount <= 0) return;
    if (this.boxCursorLineIndex > 0) write(`${ESC}[${this.boxCursorLineIndex}A`);
    write(`${ESC}[0G${ESC}[0J`); // column 0, erase cursor-to-end-of-screen
    this.boxLineCount = 0;
    this.boxCursorLineIndex = 0;
  }

  // Prints finished output above the box — ordinary terminal writes, so wrapping and
  // scrollback are entirely the terminal's own job now, not ours.
  print(text) {
    if (!this.active) {
      console.log(text);
      return;
    }
    this._eraseBox();
    const lines = String(text).split('\n');
    for (const line of lines) write(`${line}\n`);
    this._render();
  }

  // Transient "⠋ Planner is thinking…" line — part of the box (redrawn/erased with it) so it
  // never gets committed to real scrollback, same visual effect as before but folded into the
  // single erase/redraw path instead of a separate one.
  status(text) {
    this.statusText = text || '';
    if (!this.active) {
      if (text) write(`\r${text}`);
      return;
    }
    this._render();
  }

  setHint(hint) {
    this.hint = hint;
    this._render();
  }

  setInputLabel(label) {
    this.inputLabel = label;
    this._render();
  }

  drawInputBox(text = '', cursorPos = 0) {
    this.lastText = text;
    this.lastCursor = cursorPos;
    this._render();
  }

  // Wraps `label + text` across as many physical rows as it needs at the given width —
  // a real textarea, not a single line that scrolls sideways. Returns the wrapped rows plus
  // which row/column the cursor lands on, so _render can both draw it and park the real
  // cursor in the right spot. The label only ever appears on row 0 (it's baked into the
  // character stream before slicing), exactly like a prompt marker in front of wrapped text.
  _wrapInput(width) {
    const cols = Math.max(1, width);
    const full = this.inputLabel + this.lastText;
    const cursorInFull = this.inputLabel.length + this.lastCursor;
    const rows = [];
    for (let i = 0; i < full.length; i += cols) rows.push(full.slice(i, i + cols));
    if (!rows.length) rows.push('');
    const row = Math.min(rows.length - 1, Math.floor(cursorInFull / cols));
    const col = cursorInFull - row * cols;
    return { rows, row, col };
  }

  // Builds and draws the whole sticky footer as one unit: optional status line, a plain rule,
  // the (possibly multi-row) input, another plain rule, and an optional hint line — no side
  // borders, matching Claude Code's own CLI (a boxed-corners look was the old style; the real
  // one is just two horizontal rules framing the input). The box grows and shrinks with the
  // input the same way a real multi-line textarea would, instead of scrolling long text
  // sideways within a fixed single row.
  _render() {
    if (!this.active) return;
    this._eraseBox();
    const width = process.stdout.columns || 80;
    const rule = '─'.repeat(Math.max(1, width));
    const { rows: inputRows, row: cursorRow, col: cursorCol } = this._wrapInput(width);

    const lines = [];
    if (this.statusText) lines.push(this.statusText);
    lines.push(rule);
    const inputBlockStart = lines.length; // row index of inputRows[0] within `lines`
    for (const row of inputRows) lines.push(row);
    lines.push(rule);
    if (this.hint) lines.push(this.hint);

    for (const line of lines) write(`${line}\n`);
    this.boxLineCount = lines.length;
    this.boxCursorLineIndex = inputBlockStart + cursorRow;

    // Cursor is currently one row past the last line just written (each \n advanced it).
    // Move back up to whichever wrapped row the caret is actually on, then to its column.
    const rowsUpToCursor = lines.length - this.boxCursorLineIndex;
    if (rowsUpToCursor > 0) write(`${ESC}[${rowsUpToCursor}A`);
    write(`${ESC}[${cursorCol + 1}G`);
  }

  // readline still owns line-editing (history, arrow keys, ctrl+a/e, etc.) but must never
  // render to the real terminal itself — we draw the box by hand from rl.line/rl.cursor on
  // every keypress instead. Handing it this discard-everything stream keeps its internal
  // cursor math happy (it needs an object with .columns) without it ever touching the screen.
  createSilentOutput() {
    const sink = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });
    sink.columns = 1000;
    sink.isTTY = true;
    return sink;
  }
}

module.exports = new Screen();
