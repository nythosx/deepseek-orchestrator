<div align="center">

# 🤖 MyClaudeCode Agent

**A free, autonomous AI coding agent — powered entirely by DeepSeek's web chat.**

No API key. No subscription. No usage bill. Just your browser and a project folder.

[![License: MIT](https://img.shields.io/badge/License-MIT-8b5cf6.svg?style=flat-square)](#license)
[![Node](https://img.shields.io/badge/Node.js-18%2B-3b82f6.svg?style=flat-square&logo=node.js&logoColor=white)](#requirements)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-10b981.svg?style=flat-square)](#requirements)
[![Powered by](https://img.shields.io/badge/Powered%20by-DeepSeek-f59e0b.svg?style=flat-square)](https://chat.deepseek.com)
[![Status](https://img.shields.io/badge/Status-Active%20Development-ec4899.svg?style=flat-square)](#roadmap)

</div>

---

## What is this?

**MyClaudeCode Agent** turns [DeepSeek's free web chat](https://chat.deepseek.com) into a real autonomous coding agent — the kind you'd normally pay per-token for through an API. It plans, writes files, runs shell commands, starts dev servers, opens apps, browses the web, and iterates on its own until the task is done, all driven from your terminal.

It works by orchestrating **two separate DeepSeek chat tabs** through a Chrome extension:

| Role | Job |
|---|---|
| 🧠 **Planner** | Reads your project, breaks the task into small steps, delegates them |
| 🛠️ **Executor** | Writes code, runs commands, verifies its own work, reports back |

Every claim of "done" is backed by a real, verified tool call — never just the model's word.

---

## ✨ Features

- **🆓 Zero cost** — runs entirely on DeepSeek's free web chat, no API billing
- **🗂️ Full filesystem access** — read, write, and surgically edit files in your project
- **💻 Real shell execution** — a persistent shell session (`cd` actually sticks) plus background processes for dev servers, watchers, and long-running commands
- **🌐 Live web search & page fetching** — looks up current docs, APIs, and error messages instead of guessing
- **🚀 App & browser launching** — opens VS Code, browsers, localhost URLs, or any command directly
- **📊 Live process dashboard** — `--dashboard` opens a real-time visual timeline of every planning step, tool call, and wait, right alongside the DeepSeek tabs
- **🔁 Session continuity** — `--resume` reattaches to your project's existing chat tabs so follow-up tasks continue the same conversation
- **🧵 Automatic context migration** — when a conversation grows too large, the agent self-summarizes and seamlessly hands off to a fresh tab without losing state
- **⏪ Rewind** — undo the agent's last N file changes with `--rewind`
- **📜 Full history & JSON mode** — every run is logged; `--json` gives you a scriptable, CI-friendly event stream
- **🖥️ Claude-Code-style terminal UI** — a clean, scrollable, multi-line-aware CLI experience

---

## 🏗️ Architecture

```
┌─────────────┐        WebSocket        ┌──────────────────┐
│   CLI (you)  │◄───────────────────────►│  Chrome Extension │
│  cli/index.js│                          │  (orchestrator)   │
└─────────────┘                          └─────────┬─────────┘
                                                     │ native messaging
                                          ┌──────────▼──────────┐
                                          │    Native Host       │
                                          │ (filesystem + shell) │
                                          └───────────────────────┘
                                                     ▲
                          ┌──────────────────────────┴──────────────────────────┐
                          │                                                     │
                 ┌────────▼────────┐                                 ┌─────────▼────────┐
                 │  DeepSeek Tab 1  │                                 │  DeepSeek Tab 2   │
                 │     Planner      │◄──────── subtasks ─────────────│     Executor       │
                 └──────────────────┘                                └────────────────────┘
```

The extension drives both DeepSeek chat tabs directly in your real browser session — reading responses, injecting prompts, and clicking through the UI — while the native host executes filesystem and shell operations locally on your machine.

---

## 📦 Requirements

- **Node.js** 18+
- **Google Chrome**
- A free **[DeepSeek](https://chat.deepseek.com)** account, logged in

---

## 🚀 Installation

```bash
git clone https://github.com/nythosx/deepseek-orchestrator.git
cd deepseek-orchestrator
npm install
npm run install-host
```

Then load the extension:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension/` folder
4. Log into [chat.deepseek.com](https://chat.deepseek.com) in that same Chrome profile

---

## 🎯 Usage

Run from inside the project you want the agent to work on:

```bash
node cli/index.js "Add a dark mode toggle to the settings page"
```

Or start it with no task for an interactive REPL session:

```bash
node cli/index.js
```

### Common flags

| Flag | What it does |
|---|---|
| `--approve-all` | Skip manual approval prompts |
| `--dashboard` | Open a live visual timeline of the run in your browser |
| `--resume` | Continue the project's existing planner/executor chat tabs |
| `--deep-think` | Enable DeepSeek's DeepThink reasoning mode |
| `--disable-web-search` | Prevent the agent from searching the web |
| `--history [count]` | Show past task runs for this project |
| `--rewind [count]` | Undo the last N file-mutating operations |
| `--close-session` | Close and forget this project's saved chat tabs |
| `--json` | Emit machine-readable JSON events (CI/scripting) |
| `--verbose` | Print detailed debug info |

**Example — watch a full build live:**

```bash
node cli/index.js --dashboard --approve-all "Build a Candy Crush–style match-3 game"
```

---

## 🗺️ Roadmap

- [ ] Smarter incremental editing (favor `EDIT_FILE` over full rewrites automatically)
- [ ] Stronger safeguards against tool-output hallucination
- [ ] True live mid-turn status streaming to the terminal
- [ ] Multi-provider support beyond DeepSeek

---

## 📄 License

MIT

---

<div align="center">

**Built for developers who want an autonomous coding agent without the API bill.**

⭐ Star this repo if it's useful to you — it helps others find it.

</div>
