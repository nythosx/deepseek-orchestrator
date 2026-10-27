// Images for the brain (user-referenced and brain-requested).
//
// Two entry points, one resolution path (native-host RESOLVE_IMAGE: clipboard -> URL ->
// path as given -> search the project by file name -> "not found"):
//   - collectForTask: before triage, every image the user's prompt points at (a path, a
//     file name, an image URL, or a clipboard token like "[Image #3]") is resolved by the
//     system itself and attached to the triage message. No brain round-trip, so a
//     "look at this <path>" prompt costs zero extra turns.
//   - load: backs the brain's own !ATTACH_IMAGE tool (runner.js runBrainToolCalls), for
//     images it decides it needs mid-task (a repo asset, an !INSPECT_TAB screenshot).
// Attachments are pasted into the DeepSeek input (content.js attachFiles) together with
// the next brain message, so nobody clicks the upload button.
const PhasedImages = (() => {
  const MAX_IMAGES_PER_MESSAGE = 5;
  const EXT = '(?:png|jpe?g|gif|webp|bmp)';
  // C:\Users\Acer\Pictures\Screenshot 2026-10-27 030057.png -- spaces allowed, lazy up to
  // the first image extension so two paths in one sentence stay separate.
  const WIN_PATH_RE = new RegExp(`[A-Za-z]:[\\\\/][^\\n\\r"'<>|?*\\[\\]]*?\\.${EXT}\\b`, 'gi');
  const URL_RE = new RegExp(`https?:\\/\\/[^\\s"'<>)\\]]+?\\.${EXT}(?:\\?[^\\s"'<>)\\]]*)?(?=$|[\\s"'<>)\\]])`, 'gi');
  // ./img/a.png, assets/bird.png, ~/x.png, /c/Users/x.png, logo.png
  const REL_PATH_RE = new RegExp(`(?:^|[\\s"'(\`])((?:~|\\.{1,2})?[\\w\\-./\\\\]*[\\w-]\\.${EXT})(?=$|[\\s"'),.:;\`!?])`, 'gim');
  const CLIPBOARD_RE = /\[(?:image|screenshot|clipboard|pasted image)(?:\s*#\s*\d+)?\]/gi;

  function notifyCli(session, text) {
    if (session.cancelled) return;
    NativeBridge.sendToCli({ taskId: session.taskId, type: CLI_MESSAGE_TYPES.PLANNER_THINKING, text });
  }

  function extractImageRefs(text) {
    let rest = String(text || '');
    const refs = [];
    // Matched text is blanked out so a later, looser pattern can't re-match its tail
    // (e.g. REL_PATH_RE picking "030057.png" out of a Windows path with spaces).
    const take = (re, group) => {
      rest = rest.replace(re, (...m) => {
        refs.push(m[group].trim());
        return ' ';
      });
    };
    take(URL_RE, 0);
    take(WIN_PATH_RE, 0);
    take(REL_PATH_RE, 1);
    // Every clipboard token means the same single clipboard image.
    if (CLIPBOARD_RE.test(rest)) refs.push('[Image]');
    CLIPBOARD_RE.lastIndex = 0;
    return Array.from(new Set(refs)).slice(0, MAX_IMAGES_PER_MESSAGE);
  }

  // Resolves one reference and pulls its bytes over in chunks (native messaging caps a
  // host->extension message at 1 MB). Throws with the host's "Image not found ... Tried:"
  // message when nothing matched.
  async function load(session, ref) {
    const meta = await NativeBridge.execTool(session.taskId, TOOLS.RESOLVE_IMAGE, { ref });
    let base64 = '';
    for (let index = 0, chunks = 1; index < chunks; index++) {
      const part = await NativeBridge.execTool(session.taskId, TOOLS.READ_IMAGE_CHUNK, { path: meta.path, index });
      base64 += part.base64;
      chunks = part.chunks;
    }
    return { ...meta, ref, base64 };
  }

  function describe(img) {
    const from = {
      path: img.path,
      'project-search': `${img.path} (found by searching the project)`,
      url: `downloaded from ${img.ref}`,
      clipboard: 'the clipboard',
      'clipboard-file': `the clipboard (${img.path})`,
    }[img.source] || img.path;
    return `${img.name} -- from ${from}${img.note && img.source !== 'project-search' ? ` [${img.note}]` : ''}`;
  }

  async function collectForTask(session) {
    const refs = extractImageRefs(session.taskDescription);
    const attachments = [];
    const missing = [];
    for (const ref of refs) {
      try {
        const img = await load(session, ref);
        if (attachments.some((a) => a.path === img.path)) continue;
        attachments.push(img);
        notifyCli(session, `(system) Attaching image for the brain: ${describe(img)}`);
      } catch (err) {
        missing.push({ ref, error: err.message });
        notifyCli(session, `(system) ⚠️ ${err.message}`);
      }
    }
    let section = '';
    if (attachments.length || missing.length) {
      section =
        '=== IMAGES FROM THE USER\'S MESSAGE ===\n' +
        attachments.map((a, i) => `Attached #${i + 1}: ${describe(a)}`).join('\n') +
        (attachments.length && missing.length ? '\n' : '') +
        missing.map((m) => `NOT FOUND: ${m.ref} -- ${m.error}`).join('\n') +
        '\n' +
        (attachments.length
          ? 'The attached images are uploaded with THIS message -- look at them before deciding.\n'
          : '') +
        (missing.length
          ? 'Missing images: the user was already told. Do not pretend you can see them; if the task\n' +
            'depends on one, use [ANSWER] to ask for the correct path.\n'
          : '');
    }
    return { attachments, section };
  }

  return { extractImageRefs, load, describe, collectForTask, MAX_IMAGES_PER_MESSAGE };
})();
