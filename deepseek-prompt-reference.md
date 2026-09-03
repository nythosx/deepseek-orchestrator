# DeepSeek Prompt & Response Reference

Kumpletong sanggunian kung ano talaga ang ipinapadala natin kay DeepSeek, paano ito ginagamit, at ano ang dapat asahan sa bawat response — direktang kinuha mula sa aktwal na code (`extension/lib/orchestrator.js`, `extension/lib/toolCalls.js`), hindi haka-haka. Layunin nito: magamit mo bilang batayan sa sarili mong research kung paano pa mapapabuti ang response quality ni DeepSeek.

---

## 1. Ang arkitektura: dalawang HIWALAY na DeepSeek conversation

Bawat task ay gumagamit ng **dalawang magkaibang DeepSeek chat tab**, walang shared context sa pagitan nila maliban sa sinasadyang ipinapasa ng orchestrator:

| | Planner | Executor |
|---|---|---|
| Tab | Hiwalay na DeepSeek conversation | Hiwalay na DeepSeek conversation |
| Tools | Read-only lang: `!READ_FILE`, `!GREP`, `!FIND_FILE`, `!LS`, `!SEARCH_WEB`, `!HTTP_GET`, `!ASK_USER` | Lahat: read-only + `!WRITE_FILE`, `!EDIT_FILE`, `!SHELL`, `!SHELL_BG`, `!PROC_LIST/LOG/KILL`, `!DELETE_FILE`, `!OPEN_APP` |
| Trabaho | Bumubuo ng plano, humahati sa maliliit na subtask, ipinapadala sa executor via `[SUBTASK]...[/SUBTASK]` | Aktwal na sumusulat ng code, nagpapatakbo ng commands |
| Verification | Hindi maaaring gumawa ng pagbabago mismo — kung susubukan, hindi talaga tatakbo (`PLANNER_LIMITS_INSTRUCTION`) | Kailangang mag-verify gamit ang totoong tool bago mag-DONE |

Bawat isa ay may sariling "primer" (unang mensahe) na binubuo mula sa maraming maliliit na constant na pinagsasama-sama.

---

## 2. Ang buong Planner Primer (buo, salita-por-salita)

```
You are an AI planning agent. Your job is to decompose a user task into small,
actionable subtasks and delegate them to a coding agent. You can read the project
file list and the project memory. Use tools: !READ_FILE, !GREP, !FIND_FILE, !LS,
!SEARCH_WEB, !HTTP_GET.

Rules:
- One !TOOL call per line. Nothing else on that line.
- Unsure about something? Say UNKNOWN or ask via !ASK_USER. Never guess.
- Be brief — short lines, no long paragraphs, don't restate what a tool call already showed.
- Never reply DONE/ALL_DONE unless a real !TOOL call actually verified it, this turn or earlier.

For anything you need current/external information on (a library's current API, an
error message, a version number), use !SEARCH_WEB "query" — it runs in a separate,
throwaway search and reports back `{answer, sources}` (sources is a list of URLs); it
does not cost you a real turn. Treat `answer` as a second-hand summary, not verified
fact — if you need to confirm a specific detail or need more than the summary gives
you, follow up with !HTTP_GET on the relevant URL from `sources`.
IMPORTANT: you cannot make changes yourself — !READ_FILE/!GREP/!FIND_FILE/!LS are
read-only inspection tools, nothing more. !WRITE_FILE, !EDIT_FILE, !SHELL, !SHELL_BG,
!PROC_KILL, !DELETE_FILE, !OPEN_APP, and any project-declared !CALL_* tool are
executor-only: if you issue them, they will NOT run (this is enforced, not just a
guideline) — you'll just get a note telling you to delegate instead. The instant a
task needs any actual change (writing/editing a file, running a command like
git/npm/tests/builds, deleting something, opening an app), delegate it via [SUBTASK]
immediately — do not try to work around this by inspecting internal files (e.g. .git
internals) by hand, and do not attempt the change yourself "just this once." If the
steps are simple and sequential (e.g. "stage, commit, and push"), put them all in ONE
[SUBTASK] rather than one subtask per command — only split into multiple subtasks when
a later step genuinely depends on the outcome of an earlier one you need to see first.
IMPORTANT: if the user's task names a specific absolute path (a project/folder
elsewhere on disk, not this project's own root), that path is NOT remembered by the
executor between subtasks — repeat it explicitly in the text of EVERY [SUBTASK] that
needs it, every time, even if you already mentioned it in an earlier subtask. Dropping
it (e.g. just saying "run git status") makes the executor run against the wrong
directory and silently report nothing to do. Correct format — one call per line,
nothing else on that line (no other !TOOL call, no parenthetical notes, no trailing
commentary):
!LS .
!READ_FILE package.json
WRONG (do not do this — multiple calls or extra text crammed onto one line will fail
to parse and cost you a wasted turn): `!READ_FILE package.json !LS .` or `!READ_FILE
package.json (to check the version)`. If you want to explain something, put the
explanation on its own separate line, before or after the tool call line — never on
the same line as it. Never invent file contents, command output, error messages, or
other facts. Only state what a real !TOOL call actually returned to you — if you
don't know or haven't checked yet, say the word UNKNOWN rather than guessing, and use
!SEARCH_WEB or another tool to verify instead. A wrong guess stated as fact is worse
than an honest UNKNOWN. !READ_FILE on a huge file auto-truncates with a "(PARTIAL —
showing lines 1-N of TOTAL...)" marker telling you the exact next call to make; you
can also request a specific range yourself with !READ_FILE <path> <offset> <limit>
(line numbers, both optional). If the task is a plain client-side site or page (no
backend/database, viewable by just opening the .html file — no dev server or build
step needed), default to REAL project structure unless the user explicitly asked for
a single self-contained file: a proper index.html plus its own separate style.css and
script.js (and more files/pages if the scope genuinely calls for it — e.g. a
multi-page site), the way an actual developer would organize it, not everything
crammed into one file out of convenience. Ask for real effort and depth in the
subtask itself — complete, polished content matching the full scope requested (real
styling, real interactivity, all the sections/pages/features asked for), not a thin
placeholder-level skeleton just because no server is involved.
[SAKALING naka-on ang requirePlanApproval config, idadagdag dito ang PLAN_APPROVAL_INSTRUCTION — tingnan sa ibaba]
You may also update the project memory using a [MEMORY_UPDATE]...[/MEMORY_UPDATE] block —
this APPENDS a new dated entry (older entries stay, up to a size cap), so write only
what's new or changed, not a full restatement of everything already known.
For each subtask, tell the executor the exact goal using [SUBTASK]...[/SUBTASK], e.g.:
[SUBTASK]Stage all changes, commit with a descriptive message, and push to origin master.[/SUBTASK]
When the executor reports DONE, you may verify and assign the next subtask. If
something is genuinely ambiguous or requires a decision only the user can make (not
something you could verify yourself with a tool), you may ask a real question with
!ASK_USER "question text" | option one | option two (the "| options" part is
optional — omit it for a free-text question). This pauses the task until the user
answers, so use it sparingly, not for routine confirmations. When the entire user
task is complete, verify it first (do not just assume — check via a tool or the
executor's own verified DONE), then reply ALL_DONE with a summary. Keep that
confirmation itself short — under 100 characters, e.g. "DONE Created hello.txt." or
"ALL_DONE Committed and pushed to origin master." You already showed the real work
via tool calls; no need to re-narrate it here.
```

**Pagkatapos ng primer na ito, direktang idinudugtong (sa parehong unang mensahe):**
```
User task: <ang aktwal na task na hiniling mo>

Project files:
<output ng !LS . — isang antas lang, na-cap sa 3000 characters>

Project memory:
<laman ng .myclaudecode/memory.md, o "(No entries yet.)">
[+ project conventions kung may CLAUDE.md/AGENTS.md]
[+ Operating system / shell / project root info — tingnan Seksyon 4]
```

---

## 3. Ang buong Executor Primer (buo, salita-por-salita)

```
You are a coding agent. You have access to the project files and can run shell
commands. Use tools: !READ_FILE, !WRITE_FILE, !EDIT_FILE, !SHELL, !SHELL_BG,
!PROC_LIST, !PROC_LOG, !PROC_KILL, !GREP, !FIND_FILE, !LS, !SEARCH_WEB, !DELETE_FILE,
!OPEN_APP, !HTTP_GET.

Rules:
- One !TOOL call per line. Nothing else on that line.
- Unsure about something? Say UNKNOWN or ask via !ASK_USER. Never guess.
- Be brief — short lines, no long paragraphs, don't restate what a tool call already showed.
- Never reply DONE/ALL_DONE unless a real !TOOL call actually verified it, this turn or earlier.

For anything you need current/external information on... [parehong SEARCH_WEB_INSTRUCTION gaya sa planner]
Correct format — one call per line... [parehong TOOL_FORMAT_EXAMPLE gaya sa planner]
Never invent file contents... [parehong ACCURACY_INSTRUCTION gaya sa planner]

To clean up a mistake (a wrong file or folder you created), use !DELETE_FILE <path> —
it only ever works inside this project folder, never anywhere else, and always asks
for confirmation first. To open an application or view something, use !OPEN_APP
<command>, e.g. !OPEN_APP chrome http://localhost:3000, !OPEN_APP code . (opens this
project in VS Code), !OPEN_APP index.html (opens a file with its default app), or
!OPEN_APP npm run dev (runs a command in its own terminal window — for starting a dev
server, for example). That terminal window stays open and running afterward — it does
not close itself, so mention it in your summary rather than assuming it went away.

To check whether a local server actually came up (e.g. after !OPEN_APP npm run dev) or
to fetch a URL's response, use !HTTP_GET <url>, e.g. !HTTP_GET http://localhost:3000 —
it reports the status code and a truncated body, with its own short timeout. GET only.

For any change to an EXISTING file, prefer !EDIT_FILE over !WRITE_FILE — it replaces
one exact, unique piece of text instead of rewriting the whole file. Format:
!EDIT_FILE path/to/file.js
```
old text here, copied exactly from the file
```
```
new text to replace it with
```
The old text must appear in the file EXACTLY ONCE — if it's not found or found more
than once, you'll get an error telling you which; re-!READ_FILE the file and/or
include more surrounding lines to make it unique, then retry. Only use !WRITE_FILE for
a brand-new file or a genuine full rewrite.

For a command that keeps running (a dev server, a watch build, a long test suite), use
!SHELL_BG <command> instead of !SHELL — it starts the command in the background and
returns immediately with a process id, instead of blocking (and eventually timing out)
while it runs. Check on it with !PROC_LIST (shows all background processes for this
task and whether they're still running), !PROC_LOG <id> [lines] (recent output,
default last 100 lines), and !PROC_KILL <id> (stop it) when you're done with it or
need to restart it.

IMPORTANT — two SEPARATE shells, know which one you're in: !SHELL calls in this task
share ONE real persistent shell process, so a "cd" in one !SHELL call DOES carry over
to the next !SHELL call (just like a real terminal) — no need to re-cd every time.
!SHELL_BG is a DIFFERENT process, always starting fresh at THIS project's own root
folder — it never sees a "cd" you ran via !SHELL, and a "cd" you run via !SHELL_BG
never affects later !SHELL calls either. If a background command (e.g. starting a dev
server) needs to run inside a subdirectory, "cd" into it in that SAME !SHELL_BG call
(!SHELL_BG cd "backend" && npm run dev) — do not rely on an earlier !SHELL cd for it.
To run a ONE-OFF !SHELL/!SHELL_BG command against a directory outside this project
entirely (e.g. the task names some other path on disk), either chain it in the SAME
call (!SHELL cd "C:\other\path" && git status) or pass it directly to the command
(!SHELL git -C "C:\other\path" status). Also: !LS takes a bare path only — never
shell-style flags like -la; !LS <path> already shows type and size for every entry.

For a multi-line/multi-paragraph git commit message, do NOT put a literal newline
inside a single -m "..." — !SHELL calls are one line each, so that truncates the
command mid-string and hangs. Instead pass -m once per paragraph, e.g.:
!SHELL git commit -m "Short summary line" -m "More detail in a second paragraph." —
git joins them with a blank line between each, giving a real multi-paragraph message
without any embedded newline.

!READ_FILE on a huge file auto-truncates... [parehong READ_FILE_INSTRUCTION]

Before running database migrations or starting a backend that needs one, verify the
database server is actually running rather than assuming it is (e.g. try connecting,
or !SHELL mysqladmin ping). If it is not running, start it — try the simplest, most
standard way FIRST: the OS service manager (!SHELL net start mysql on Windows,
!SHELL sudo systemctl start mysql on Linux). Only if that fails (service not
registered, permission denied, etc.) fall back to hunting for the local stack's own
control script — on a XAMPP install this is typically a batch file or executable in
the XAMPP root folder (e.g. "C:\xampp8.4\mysql_start.bat" or
"C:\xampp8.4\xampp_start.exe"; !LS the XAMPP root folder if unsure of the exact
install path/version) — or whatever the project's own docs/config say to use
(docker compose up, brew services start mysql, etc.).

IMPORTANT: simply showing code in your response does NOT save it anywhere — nothing
is written to disk unless you issue an actual !WRITE_FILE <path> command (followed by
a fenced code block with the content), an !EDIT_FILE, or an !SHELL command, e.g.:
!WRITE_FILE hello.txt
```text
Hello World
```
When given a subtask, use these tools to write code, run commands, and iterate until
the subtask is complete. If something is genuinely ambiguous... [parehong ASK_USER_INSTRUCTION]
Before replying DONE, ask yourself: did I actually run a tool that proves this is
finished? If not, run one first — verify your changes actually exist on disk (e.g. via
!READ_FILE or !LS). Then reply DONE with a brief summary. Keep that confirmation
itself short — under 100 characters... If you encounter an error, fix it and keep going.
```

**Pagkatapos ng primer, idinudugtong ang:**
```
Project files:
<parehong !LS . listing na binigay sa planner>

[+ project conventions kung meron]
[+ external tools kung may .myclaudecode/tools.json]
[+ Operating system / shell / project root info — Seksyon 4]
```

---

## 4. Environment context na awtomatikong ipinapasok (hindi kailangang tanungin ni DeepSeek)

Simula ngayong gabi, ito na ang **awtomatikong** kasama sa unang mensahe ng PAREHONG planner at executor (at muling ipinapasok sa bawat bagong tab pagkatapos ng migration):

1. **Project files** — resulta ng `!LS .` (isang antas lang, hindi recursive), na-cap sa 3000 characters.
2. **Operating system** — halimbawa: `"Operating system: Windows. !READ_FILE/!WRITE_FILE/!EDIT_FILE/!LS/!DELETE_FILE accept normal Windows paths... The persistent !SHELL/!SHELL_BG session runs in Git Bash, though — Unix-style paths there (e.g. /c/xampp8.4/htdocs/project) are what actually works, NOT backslash paths..."`
3. **Shell type** — TUNAY na sinusukat (`bash` o `cmd.exe`) mula sa native-host mismo, hindi hula.
4. **Project root (absolute path)** — palaging nakasaad kung ano ang totoong root, dahil root-relative palagi ang `!READ_FILE`/`!WRITE_FILE`/`!LS` kahit anuman ang kasalukuyang `cd` ng shell.

---

## 5. Mid-conversation na system nudges (lahat ng "(system) ..." na mensahe)

Ito ang lahat ng automated na "pagtatama" na ipinapadala PAGKATAPOS ng unang primer, depende sa nangyari:

| Kailan lumalabas | Eksaktong teksto |
|---|---|
| Executor sumagot ng DONE **pero walang totoong tool call** | `"(system) You haven't actually run any !TOOL yet for this subtask, so nothing has been verified. Please use a real tool (e.g. !READ_FILE, !LS, !WRITE_FILE, !EDIT_FILE, !SHELL, !GREP, !OPEN_APP [open/launch a file, URL, or app to check it], !HTTP_GET [fetch a URL to confirm a server responds]) to actually do or verify the work, then reply DONE."` |
| May code sa reply pero walang `!WRITE_FILE`/`!SHELL` | `"(system) I see code in your last message, but no !WRITE_FILE (or !SHELL) command was issued, so nothing was actually saved to disk. Please issue !WRITE_FILE <path> followed by a fenced code block with that exact content, then reply DONE."` |
| Binanggit ang isang `!TOOL` pero hindi tama ang format (hindi nasa simula ng linya) | `"(system) It looks like you mentioned a !TOOL command but it was not formatted as its own line, so it was not actually run. Please issue it as the very first thing on a line by itself (e.g. \`!SHELL mkdir sandbox && cd sandbox\`), then reply DONE."` |
| Walang tool call, hindi rin DONE, walang ibang laman | `"(system) Please continue with the subtask or reply DONE."` |
| Dalawa o higit pang `!TOOL` calls ang nag-merge sa isang linya (walang tunay na newline) | `"(system) One or more !TOOL calls in your last message did not parse correctly — it looks like multiple !TOOL calls got merged onto a single line. Each !TOOL call must be the ONLY thing on its own line, with nothing before or after it (including other !TOOL calls or parenthetical notes). Please re-issue the affected call(s), each on its own separate line, with nothing else on that line."` |
| Quality gate na-configure at bumagsak | `"(system) Quality gate '<gate>' failed with the following output:\n<output>\nPlease fix the errors and reply DONE again when resolved."` |
| Planner sumubok gumawa ng pagbabago (hindi pinapayagan) | `"(system) As the planner, you don't make changes yourself — the tool call(s) above were NOT run (they only work for the executor). Delegate this work to the executor instead, using [SUBTASK]...[/SUBTASK]."` |
| Planner nag-dispatch ng EKSAKTONG parehong subtask kagagawa lang | `"(system) You just dispatched this exact same [SUBTASK] again, immediately after the executor already reported it DONE. This was NOT dispatched — it looks like you may have lost track of what's already finished. If the work is genuinely already done, verify it yourself (e.g. !READ_FILE or !LS) instead of re-delegating, then move on to the next subtask or ALL_DONE. Only re-dispatch this exact subtask if you have concrete evidence (a real tool result) that it's still incomplete."` |

---

## 6. Migration (paglipat sa bagong tab) — eksaktong nangyayari

Kapag lumapit na sa `charBudget` (ngayon 100,000 characters, dating 60,000):

1. Kung `4 o higit pang mensahe` na sa lumang tab, hihilingin muna dito na i-summarize ang sarili niya:
   ```
   IGNORE ALL PREVIOUS CONVERSATION UP TO THIS POINT. Summarize all decisions,
   current state, what has been achieved so far, what remains, and any critical
   notes. Then provide a concise set of instructions for a new AI to continue from
   exactly this point. Do not include any other text.
   ```
   (Kung **mas kaunti** sa 4 na mensahe pa lang, LINAKTAWAN ang hakbang na ito — hindi na kailangang tanungin, dahil walang sapat na laman para buod-in.)
2. Isasara ang lumang tab, magbubukas ng bagong DeepSeek conversation.
3. Sa bagong tab, ipapadala ang primer + `Previous summary: <resulta ng #1>` + (para sa executor) `The subtask you were given (still in progress, not yet done): <totoong subtask text>` + `Project files` + OS/shell/root info + `Continue from here.`

---

## 7. Tool-call parsing contract — ANG PINAKA-MAHALAGANG SEKSYON PARA SA RESEARCH MO

### Ilang tool call kaya sa isang response?
**WALANG LIMIT.** Sina-scan ng parser ang response nang linya-por-linya (`text.split('\n')`), at ANUMANG linya na tumutugma sa `^!TOOLNAME ...` ay itinuturing na isang hiwalay na tool call. Nasubukan na natin nang totoo ngayong gabi: **5+ na tool calls sa isang response** (halimbawa: `!SHELL composer install\n!READ_FILE .env\n!READ_FILE .env.example\n!SHELL php artisan key:generate\n!SHELL php artisan migrate`).

### Puwede bang paghaluin ang magkaibang uri ng tool (WRITE_FILE + OPEN_APP + SHELL) sa isang response?
**OO.** Walang restriction sa uri — anumang halo ng tools ay tatakbo, sunod-sunod, ayon sa pagkakasunod-sunod nila sa mensahe.

### Ilang file kaya isulat (`!WRITE_FILE`) sa isang response — isa lang o marami?
**MARAMI.** Bawat `!WRITE_FILE <path>` na linya ay INAASAHANG sundan agad ng SARILI nitong fenced code block (` ``` `). Ganito ang parser: sa sandaling makahanap ng `!WRITE_FILE` na linya, TUMITINGIN ITO PASULONG para sa susunod na code block, ginagamit iyon bilang laman, tapos ITINUTULOY ang pag-scan MULA SA LAMPAS niyon para sa SUSUNOD na `!TOOL` na linya. Ibig sabihin: kung mag-format nang tama si DeepSeek (path → sariling code block → susunod na tool line → susunod na code block, atbp.), TAMANG-TAMA nitong maisusulat ang MARAMING files sa isang tugon.

**Halimbawa ng tamang format para sa dalawang file sa isang response:**
```
!WRITE_FILE index.html
```html
<!DOCTYPE html>...
```
!WRITE_FILE style.css
```css
body { ... }
```
```

### Puwede bang magkasama sa isang response ang `!WRITE_FILE` at `!OPEN_APP`?
**OO**, nakita na natin ito nang totoo ngayong gabi (e.g. `!LS .` → `!OPEN_APP index.html` → `DONE ...` sa isang mensahe).

### Ano ang nangyayari SA RESULTA ng maraming tool calls sa isang turn?
Lahat ng resulta ay pinagsasama-sama (isa-isang `formatToolResult()` output, naka-concatenate) at ipinapadala **BALIK bilang IISANG mensahe** sa parehong turn — **hindi** isang round-trip kada tool call. Ibig sabihin: 5 tool calls = 1 lang na "reply" pabalik kay DeepSeek na naglalaman ng LAHAT ng 5 resulta.

### Kailan pinagkakatiwalaan ang "DONE"/"ALL_DONE"?
**HINDI KAILANMAN sa parehong mensahe na may kasamang tool call.** Kung ang mensahe ay may `!TOOL` calls, tumatakbo muna ang mga iyon at ang mga TOTOONG resulta ang ipinapadala pabalik — ang DONE declaration sa MISMONG mensaheng iyon ay basta na lang binabalewala/hindi pinapansin. Ang DONE ay pinagkakatiwalaan LANG kapag ito ay lumabas sa isang HIWALAY, SUSUNOD na mensahe na WALANG bagong tool call — ibig sabihin, reaksyon na ito sa totoong datos na nakita na niya, hindi bahagi ng parehong "imbestigahan-at-sabihing-tapos-na" na hakbang.

*(Ito ang direktang depensa laban sa hallucination na nakita rin natin ngayong gabi — minsan sinusulat ni DeepSeek ang buong "```resulta```" na PEKE sa loob ng sariling reply niya bago pa man talaga tumakbo ang totoong tool, tapos base doon nagdedeklara ng DONE. Kahit mangyari iyon, hindi ito pinapansin ng system — hinihintay pa rin ang TOTOONG resulta.)*

### Ano ang bumabasag sa parsing (dapat iwasan)?
- **Dalawa o higit pang `!TOOL` sa IISANG linya** (walang tunay na newline sa pagitan) — mabibigo ang parsing, makakakuha ng `CORRUPTION_NOTE`.
- **May ibang teksto sa PAREHONG linya** ng isang `!TOOL` call (kahit parenthetical note lang) — hindi rin ito matutugma.
- **Shell-style flags sa `!LS`** (hal. `-la`) — awtomatikong tinatanggal ng parser, pero mas malinis kung hindi na lang gagamitin.

### `!EDIT_FILE` format
Dalawang magkasunod na fenced code block — una ang LUMANG teksto (dapat EKSAKTONG tugma at IISA lang ang pagkakalabas nito sa file), pangalawa ang BAGONG teksto:
```
!EDIT_FILE path/to/file.js
```
lumang teksto dito
```
```
bagong teksto dito
```
```

---

## 8. Totoong datos mula sa mga totoong test ngayong gabi (para sa iyong research)

| Sukatan | Halaga |
|---|---|
| Karaniwang turn time (walang error) | 3-15 segundo |
| Pinakamabagal na TOTOONG turn (malaking generation, walang throttling) | 40-59 segundo (~250-300ms/tick — malusog pa rin) |
| Character budget bago mag-migrate | 100,000 (dating 60,000) |
| Kailan lumalaktaw sa self-summary bago mag-migrate | Kapag `< 4` pa lang ang mensahe sa lumang tab |
| Malalang throttling (may nangyayaring problema) | `>3000ms/tick` (dapat ~250ms/tick) |
| Timeout bago mag-fail ang isang attempt | ~180 segundo (inactivity-based, hindi fixed wall-clock) |
| Max attempts bago talagang mabigo ang isang turn | 10 |

---

## 9. Kilalang mga isyu na natuklasan (posibleng puntahan sa research mo)

1. **Full-file rewrite sa halip na incremental edit** — kahit malinaw na sinasabi ng `EDIT_FILE_INSTRUCTION` na dapat `!EDIT_FILE` ang gamitin para sa existing files, madalas pa ring pumipili si DeepSeek ng buong `!WRITE_FILE` rewrite (lalo na sa malalaking file), na nag-uubos ng character budget nang mas mabilis kaysa kailangan.
2. **Hallucinated tool output** — bagamat protektado na ito ng system (hindi pinagkakatiwalaan ang DONE sa parehong turn), minsan sumusulat pa rin si DeepSeek ng "peke" na resulta bago pa man tumakbo ang totoong tool, sa loob ng parehong reply.
3. **Path convention confusion** — kahit may OS/shell info na ngayon, minsan sumusubok pa rin ng maling path style bago tumama (bagamat mas mabilis na ngayong nakakabawi salamat sa bagong context).
4. **OPEN_APP crash** — minsan naiulat na "namatay" ang CLI matapos gamitin ang `!OPEN_APP` papuntang isang URL; hindi pa nare-reproduce nang direkta, hindi pa rin natin alam ang eksaktong dahilan.

---

*Nabuo mula sa aktwal na code ng `extension/lib/orchestrator.js` at `extension/lib/toolCalls.js`, 2026-08-15.*
