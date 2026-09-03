(function () {
  const params = new URLSearchParams(location.search);
  const role = params.get('role') || 'planner';
  const taskId = params.get('taskId') || 'dev';
  const scenario = params.get('scenario') || 'default';

  const root = document.getElementById('chat-root');
  root.dataset.role = role;
  root.dataset.taskId = taskId;
  document.getElementById('role-label').textContent = role;

  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('chat-input');
  const sendBtn = document.getElementById('send-btn');
  const webSearchBtn = document.getElementById('web-search-toggle');

  let busy = false;

  function makeUserBubble(text) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-user';
    wrap.dataset.role = 'user';
    const textEl = document.createElement('div');
    textEl.className = 'msg-text';
    textEl.textContent = text;
    wrap.appendChild(textEl);

    const editBtn = document.createElement('button');
    editBtn.className = 'msg-edit-btn';
    editBtn.type = 'button';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => startEdit(wrap, textEl));
    wrap.appendChild(editBtn);

    return wrap;
  }

  function makeAssistantBubble() {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-assistant generating';
    wrap.dataset.role = 'assistant';
    const textEl = document.createElement('div');
    textEl.className = 'msg-text';
    textEl.textContent = '';
    wrap.appendChild(textEl);
    return wrap;
  }

  function startEdit(bubbleEl, textEl) {
    const original = textEl.textContent;
    const ta = document.createElement('textarea');
    ta.value = original;
    ta.className = 'edit-textarea';
    ta.style.width = '100%';
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save & Resubmit';
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', () => {
      const newText = ta.value;
      // Remove this message and every message after it, then resend as a fresh turn.
      let node = bubbleEl;
      const toRemove = [];
      while (node) {
        toRemove.push(node);
        node = node.nextSibling;
      }
      toRemove.forEach((n) => n.remove());
      sendMessage(newText);
    });
    bubbleEl.innerHTML = '';
    bubbleEl.appendChild(ta);
    bubbleEl.appendChild(saveBtn);
  }

  async function sendMessage(text) {
    if (busy) return;
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    busy = true;
    inputEl.disabled = true;
    sendBtn.disabled = true;

    messagesEl.appendChild(makeUserBubble(trimmed));
    const assistantEl = makeAssistantBubble();
    messagesEl.appendChild(assistantEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    try {
      const res = await fetch('/api/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: trimmed,
          context: role,
          taskId,
          scenario,
          webSearch: webSearchBtn.getAttribute('aria-pressed') === 'true',
        }),
      });
      const data = await res.json();
      assistantEl.querySelector('.msg-text').textContent = data.reply;
    } catch (err) {
      assistantEl.querySelector('.msg-text').textContent =
        '(mock backend error) ' + err.message;
    } finally {
      assistantEl.classList.remove('generating');
      assistantEl.classList.add('done');
      busy = false;
      inputEl.disabled = false;
      sendBtn.disabled = false;
      inputEl.focus();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  sendBtn.addEventListener('click', () => {
    const text = inputEl.value;
    inputEl.value = '';
    sendMessage(text);
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  webSearchBtn.addEventListener('click', () => {
    const pressed = webSearchBtn.getAttribute('aria-pressed') === 'true';
    webSearchBtn.setAttribute('aria-pressed', String(!pressed));
  });

  // Signal readiness for content-script polling (waitForReady).
  window.__mockChatReady = true;
})();
