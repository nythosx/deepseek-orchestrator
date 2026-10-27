Here is a comprehensive, handoff-ready specification of what **MyClaudeCode** is, how it is expected to behave, what we have built so far, and the current architectural bottlenecks.

You can copy and paste this directly to Claude Code so it can analyze the system from a fresh perspective, fix the stubborn bugs (like the React click issue), and optimize the workflow.

---

# Project Specification: MyClaudeCode (DeepSeek Agent)

## 1. Executive Summary

**MyClaudeCode** is a zero-cost, autonomous AI coding agent. It bypasses paid APIs by driving the free web UI of DeepSeek (chat.deepseek.com) via a Chrome Extension and a Node.js Native Host.
It operates on a strict separation of concerns: **The Brain** (Planner) decides _what_ to do, and **The Coder** (Executor) writes a single Python script (`a.py`) to execute the actual file writes and shell commands.

## 2. Core Philosophy & Rules

1. **The Brain Never Codes:** The Planner (Brain) is blocked from using write/shell tools. It can only read, inspect, and plan.
2. **The Coder Only Implements:** The Executor (Coder) receives a bounded brief and outputs exactly one ` ```python ` block (`a.py`) per task/phase.
3. **Scripts are Named by the System:** The orchestrator names the file (e.g., `phase_01_security.py`), writes it to `.myclaudecode/phased/scripts/`, and runs `python <script>`.
4. **No Comments in Code:** Zero comments (`#`, `//`, etc.) are allowed in generated code. AI comments drift and confuse future prompts.
5. **No Backups:** The agent relies on Git and the traceback loop to fix mistakes. It does not create `.bak` files.
6. **Self-Reporting Markers:** Every generated `a.py` must print `__PHASE_WROTE__ <paths>` before running tests, and `__PHASE_SUCCESS__` after passing.
7. **No Documentation Phases:** Documentation (`.md`) cannot be its own phase. It must be bundled with code phases to prevent the brain from hallucinating commands from markdown examples.

## 3. The 4 Operational Modes (Triage)

Every task starts with a Triage prompt to the Brain. The Brain estimates LOC and picks ONE mode:

1. **`[ANSWER]` Mode:**
   - _Use case:_ Q&A, analysis, read-only tasks.
   - _Execution:_ The Brain's text response is printed directly to the CLI. The Coder is not used. Max length: 1500 characters.
2. **`[DIRECT]` Mode:**
   - _Use case:_ Code changes under ~2,000 LOC.
   - _Execution:_ The Brain generates a `[BRIEF]`. The Coder generates one `a.py` script to apply the changes.
3. **`[PHASED]` Mode:**
   - _Use case:_ Code changes over ~2,000 LOC.
   - _Execution:_ The Brain splits the task into phases by **Lines of Code (LOC)**, aiming for 1,500–2,000 LOC per phase. Every file must belong to exactly ONE phase.
4. **`[RUN]` Mode:**
   - _Use case:_ "Run my project", "Start the server", "Open the app".
   - _Execution:_ The Brain generates a command plan (e.g., `npm install`, `npm run dev`, `open: http://localhost:3000`). The system executes these commands directly via the Native Host.

## 4. Infrastructure & State Management

- **MV3 Persistence:** Because Chrome Service Workers sleep, tab IDs are stored in `chrome.storage.local`, not in-memory, to ensure the system reuses the same Brain and Coder tabs across multiple prompts.
- **CWD Tracking:** Every prompt sent to the Brain includes `[time: ...]` and `[cwd: ...]` so the AI always knows the shell's current working directory.
- **Brain Tool Access:** During triage, the Brain can use `!LS`, `!READ_FILE`, `!GREP`, `!HTTP_GET`, and `!INSPECT_TAB` to inspect the file system _outside_ the project root if needed.
- **Migration:** If the DeepSeek context window fills up (char budget), the system migrates to a new tab using a targeted disk-based bundle (Brain state is preserved via `brain-log.jsonl`).

## 5. Web Inspection & Testing (`!INSPECT_TAB`)

We cannot reliably UI-automate the user's generated app. Instead:

- The system can open a URL, wait 2 seconds, capture **Console Errors**, and take a **Screenshot**.
- It saves the screenshot as Base64 (`.myclaudecode/screenshots/`).
- The Brain receives the console errors in the completion summary to know if the app is actually working or needs a fix.

## 6. Known Pain Points (For Claude Code to Analyze)

We are stuck on a few specific issues that need a fresh architectural perspective:

### A. The "Continue" Button Nightmare

DeepSeek's web UI pauses generation on long responses and shows a "Continue" button (`<div role="button" class="ds-button..."><span>Continue</span></div>`).

- **The Problem:** Simulated clicks via `dispatchEvent(new MouseEvent('click'))` or `PointerEvent` do not reliably trigger DeepSeek's React handlers.
- **What we tried:** Pointer events, coordinate-based clicks (`elementFromPoint`), keyboard events (`Enter`), forcing `pointer-events: auto` on parent wrappers, and even digging into React Fiber (`__reactProps$`) to manually invoke `onClick`. The button sometimes just ignores the events.
- **Goal:** Find a bulletproof way to click this button or programmatically bypass the truncation (e.g., via network interception, though it's a stream).

### B. Context Window Management

DeepSeek chat has a hard limit (~210k chars). When the Coder or Brain hits this, we migrate tabs and send a summary. We need to ensure the `a.py` generation doesn't get truncated mid-code.

### C. Service Worker Lifecycle

Despite using `chrome.storage.local`, we still occasionally see the extension lose connection ("Receiving end does not exist") if the browser sleeps or the user leaves the tab idle too long.

## 7. Expected Workflow (Example)

1. User types: `myclaudecode "Add a dark mode toggle to the settings page"`
2. System opens/Reuses Brain & Coder tabs.
3. Brain triages, sees it's `~150 LOC`, chooses `[DIRECT]`.
4. Brain creates a `[BRIEF]` with target files.
5. Coder writes an `a.py` script that opens the HTML/CSS/JS, injects the toggle code, and runs a test.
6. Orchestrator runs `python a.py`.
7. If exit code 0 + `__PHASE_SUCCESS__`, task completes.
8. If exit code 1, Orchestrator captures the traceback, sends it to the Coder, and says: _"Fix a.py and output the whole file again."_

## 8. What I Need From You (Claude Code)

Please review this architecture. I am handing this over to you to:

1. **Strengthen the Extension:** Find a better way to handle the DeepSeek `Continue` button and MV3 Service Worker drops.
2. **Optimize the Prompts:** Review our `Triage` and `Coder` primers to ensure the AI is adhering strictly to the `a.py` and `LOC` rules.
3. **Improve Error Recovery:** Make the migration, traceback loops, and context bundling more resilient to edge cases.
4. **Enhance the `[RUN]` Mode:** Find a way to better test/inspect the user's project after launching it.
