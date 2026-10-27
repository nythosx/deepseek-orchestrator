#!/usr/bin/env python3
"""Install MyClaudeCode for global use.

After running once, `deeper <task>` works from any terminal, in any directory.

Flags:
  --check    Verify current state without installing anything; exit 0 if all good, 1 otherwise.
  --force    Re-run even if `--check` reports all-ok (default: always re-runs anyway; flag
             exists for scripting clarity).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CLI_DIR = ROOT / "cli"
NATIVE_HOST_DIR = ROOT / "native-host"
KEYGEN = NATIVE_HOST_DIR / "keygen.js"
HOST_INSTALLER = NATIVE_HOST_DIR / "install.js"
EXT_ID_FILE = NATIVE_HOST_DIR / "dev-key" / "extension-id.txt"
CLI_PKG = CLI_DIR / "package.json"
CLI_INDEX = CLI_DIR / "index.js"

IS_WIN = sys.platform == "win32"
NODE = "node.exe" if IS_WIN else "node"


def step(msg):
    print(f"\n>>> {msg}")


def ok(msg):
    print(f"    [ok] {msg}")


def warn(msg):
    print(f"    [warn] {msg}")


def fail(msg):
    print(f"    [FAIL] {msg}")


def run(cmd, cwd=None, capture=True, check=True, timeout=None, shell=False):
    """Run a command. shell=True only used as a last-resort fallback for cases where we
    couldn't resolve a real .exe -- on Windows, subprocess.run(list) uses CreateProcessW
    which only auto-appends .EXE, not .CMD, so batch files need shell=True."""
    kwargs = {"cwd": str(cwd) if cwd else None}
    if capture:
        kwargs.update({"capture_output": True, "text": True})
    if timeout:
        kwargs["timeout"] = timeout
    if shell:
        # All args come from this script (no user input), so naive quoting is safe.
        cmd = " ".join(f'"{c}"' for c in cmd)
    result = subprocess.run(cmd, shell=shell, **kwargs)
    if check and result.returncode != 0:
        stderr = (getattr(result, "stderr", "") or "").strip()
        stdout = (getattr(result, "stdout", "") or "").strip()
        raise RuntimeError(
            f"command failed ({result.returncode}): {' '.join(cmd) if isinstance(cmd, list) else cmd}\n"
            f"--- stderr ---\n{stderr}\n--- stdout (tail) ---\n{stdout[-1000:]}"
        )
    return result


# --- npm discovery --------------------------------------------------------
#
# On Windows with nvm-for-Windows (nvm4w), `npm` on PATH is `C:\nvm4w\nodejs\npm.CMD` --
# a batch wrapper whose `%~dp0` (own directory) resolution can be shadowed by an unrelated
# `node_modules/.bin/npm.cmd` in the CWD (observed live 2026-10-25). When that happens,
# npm.CMD tries to load `{CWD}/node_modules/npm/bin/npm-cli.js`, which doesn't exist, and
# dies with "Cannot find module".
#
# The fix: bypass the shim. `node.exe` is a real .EXE, so `subprocess.run()` calls it
# directly with no shim resolution involved. Ask node where it lives, and construct
# `<node_dir>/node_modules/npm/bin/npm-cli.js` from that -- this is where npm-cli.js is
# placed by every standard Windows Node distribution (nvm4w, msi installer).

def find_npm_cli():
    """Returns the absolute path to npm-cli.js, or None if it can't be located."""
    try:
        result = subprocess.run(
            [NODE, "-e", "process.stdout.write(require('path').dirname(process.execPath))"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            node_dir = (result.stdout or "").strip()
            if node_dir:
                candidate = Path(node_dir) / "node_modules" / "npm" / "bin" / "npm-cli.js"
                if candidate.is_file():
                    return str(candidate)
    except Exception:
        pass
    # Unix fallback: npm-cli.js is usually at <prefix>/lib/node_modules/npm/bin/npm-cli.js
    # where <prefix> is /usr, /usr/local, or /opt/homebrew (Apple Silicon).
    for candidate in [
        Path("/usr/lib/node_modules/npm/bin/npm-cli.js"),
        Path("/usr/local/lib/node_modules/npm/bin/npm-cli.js"),
        Path("/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js"),
    ]:
        if candidate.is_file():
            return str(candidate)
    return None


def npm_cmd(args):
    """Returns (cmd_list, shell_bool) for invoking npm. Prefers direct `node npm-cli.js`
    invocation (no shim); falls back to `npm` + shell=True on Windows if npm-cli.js can't
    be located (extremely unusual, but better than crashing)."""
    npm_cli = find_npm_cli()
    if npm_cli:
        return ([NODE, npm_cli] + list(args), False)
    # Fallback -- may hit the exact nvm4w shim bug this helper is designed to avoid, but
    # at least it'll produce an error instead of a Python exception.
    return (["npm"] + list(args), IS_WIN)


# --- 1. preflight ---------------------------------------------------------

def preflight():
    step("Preflight")
    if not shutil.which(NODE):
        fail(f"{NODE} not on PATH — install Node.js 18+ from https://nodejs.org and re-run")
        return False
    ok(f"{NODE} found ({shutil.which(NODE)})")
    if not shutil.which("npm"):
        fail("npm not on PATH — reinstall Node.js (npm ships with it)")
        return False
    ok(f"npm found ({shutil.which('npm')})")
    npm_cli = find_npm_cli()
    if npm_cli:
        ok(f"npm-cli.js found ({npm_cli})")
    else:
        warn("could not locate npm-cli.js next to node.exe — will fall back to `npm` on PATH")
    if not CLI_INDEX.exists():
        fail(f"missing {CLI_INDEX} — is this the project root?")
        return False
    ok(f"project root: {ROOT}")
    return True


# --- 2. npm install -------------------------------------------------------

def npm_install():
    step("Installing dependencies (npm install)")
    cmd, shell = npm_cmd(["install"])
    result = run(cmd, cwd=ROOT, capture=False, check=False, shell=shell)
    if result.returncode != 0:
        fail("npm install failed — see output above")
        return False
    ok("dependencies installed")
    return True


# --- 3. native host -------------------------------------------------------

def install_native_host():
    step("Installing native messaging host")
    keygen = run([NODE, str(KEYGEN)], cwd=ROOT, check=False)
    if keygen.returncode != 0:
        fail(f"keygen.js failed: {(keygen.stderr or keygen.stdout or '').strip()}")
        return False
    if not EXT_ID_FILE.exists():
        fail(f"keygen.js did not produce {EXT_ID_FILE}")
        return False
    ok(f"extension key ready ({EXT_ID_FILE.read_text(encoding='utf-8').strip()[:12]}...)")
    installer = run([NODE, str(HOST_INSTALLER)], cwd=ROOT, check=False)
    if installer.returncode != 0:
        fail(f"native-host install failed: {(installer.stderr or installer.stdout or '').strip()}")
        return False
    ok("native messaging host registered with Chrome")
    return True


# --- 4. bin alias in cli/package.json ------------------------------------

def patch_cli_package_json():
    step("Ensuring `deeper` alias exists in cli/package.json")
    if not CLI_PKG.exists():
        fail(f"missing {CLI_PKG}")
        return False
    try:
        data = json.loads(CLI_PKG.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        fail(f"{CLI_PKG} is not valid JSON: {err}")
        return False

    bin_field = data.get("bin")
    if isinstance(bin_field, dict) and "deeper" in bin_field:
        ok("bin alias already present — no change")
        return True
    if isinstance(bin_field, str):
        data["bin"] = {
            data.get("name", "my-claude-code"): bin_field,
            "deeper": bin_field,
        }
    elif isinstance(bin_field, dict):
        bin_field["deeper"] = "./index.js"
    else:
        data["bin"] = {"deeper": "./index.js"}
    CLI_PKG.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    ok(f"bin alias added to {CLI_PKG}")
    return True


# --- 5. register globally -------------------------------------------------

def link_globally():
    step("Registering `deeper` globally")
    cmd, shell = npm_cmd(["link"])
    result = run(cmd, cwd=CLI_DIR, check=False, shell=shell)
    if result.returncode == 0:
        ok("npm link succeeded")
        return "link"
    warn(f"npm link failed: {(result.stderr or result.stdout or '').strip()[:200]}")

    cmd, shell = npm_cmd(["install", "-g", "."])
    result = run(cmd, cwd=CLI_DIR, check=False, shell=shell)
    if result.returncode == 0:
        ok("npm install -g succeeded")
        return "install-g"
    warn("npm install -g . also failed")
    return None


def write_shim_fallback():
    step("Writing fallback `deeper` shims")
    target_js = str(CLI_INDEX.resolve())
    target_js_fwd = target_js.replace("\\", "/")

    if IS_WIN:
        bin_dir = Path(os.environ.get("APPDATA", "")) / "npm"
        if not bin_dir.is_dir():
            warn(f"npm bin dir not found ({bin_dir}) — cannot write shim")
            return False
        (bin_dir / "deeper.cmd").write_text(
            f'@echo off\r\nnode "{target_js}" %*\r\n', encoding="utf-8"
        )
        ok(f"wrote {bin_dir / 'deeper.cmd'}")
        (bin_dir / "deeper.ps1").write_text(
            f'#!/usr/bin/env pwsh\r\n& node "{target_js}" $args\r\nexit $LASTEXITCODE\r\n',
            encoding="utf-8",
        )
        ok(f"wrote {bin_dir / 'deeper.ps1'}")
        (bin_dir / "myclaudecode").write_text(
            f'#!/bin/sh\nexec node "{target_js_fwd}" "$@"\n', encoding="utf-8"
        )
        ok(f"wrote {bin_dir / 'deeper'}")
        return True
    else:
        for candidate in [Path.home() / ".local" / "bin", Path("/usr/local/bin")]:
            try:
                candidate.mkdir(parents=True, exist_ok=True)
                shim = candidate / "deeper"
                shim.write_text(
                    f'#!/bin/sh\nexec node "{target_js}" "$@"\n', encoding="utf-8"
                )
                os.chmod(shim, 0o755)
                ok(f"wrote {shim}")
                path_parts = os.environ.get("PATH", "").split(os.pathsep)
                if str(candidate) not in path_parts:
                    warn(f"{candidate} is not on PATH — add it to use `deeper`")
                return True
            except OSError:
                continue
        warn("no writable PATH directory found for shim")
        return False


# --- 6. verify ------------------------------------------------------------

def verify():
    step("Verifying `deeper` is callable")
    found = shutil.which("myclaudecode")
    if not found:
        warn("`deeper` not on PATH yet")
        warn("close & reopen your terminal, or ensure %APPDATA%\\npm is on PATH")
        return False
    ok(f"shim found at {found}")

    # Verify behavior via direct node invocation on cli/index.js -- NOT by exec'ing the
    # shim. On Windows the shim is myclaudecode.CMD; subprocess.run(shell=False) can't
    # exec .CMD (same CreateProcessW/.EXE-only limitation as the npm.CMD bug), and going
    # via shell=True would re-introduce the same %~dp0 resolution risk. node.exe is a
    # real .EXE so subprocess.run handles it cleanly on every platform.
    try:
        result = run([NODE, str(CLI_INDEX), "--help"], capture=True, check=False, timeout=20)
        if result.returncode == 0:
            stdout = (result.stdout or "").strip()
            first_line = stdout.splitlines()[0] if stdout else ""
            ok(f"`deeper --help` exited 0 ({first_line[:60]!r})")
            return True
        warn(f"`deeper --help` exited {result.returncode}")
        warn(((result.stderr or "") + (result.stdout or ""))[:300])
        return False
    except subprocess.TimeoutExpired:
        warn("`deeper --help` timed out after 20s")
        return False


# --- 7. summary -----------------------------------------------------------

def summary(link_method):
    print()
    print("=" * 70)
    print("  Installation complete.")
    print("=" * 70)
    print()
    print("  Usage:")
    print("    myclaudecode <task>            # phased mode (default)")
    print("    myclaudecode --legacy <task>   # legacy v1 planner/executor")
    print("    myclaudecode                   # interactive REPL")
    print()
    print("  Both `deeper` and `my-claude-code` are registered.")
    print()
    if link_method is None:
        print("  NOTE: global registration via npm failed; fallback shims were written.")
    print("  If `deeper` isn't recognized yet:")
    print("    - Close and reopen your terminal (PATH refresh)")
    print("    - Or: npm config get prefix   →  make sure that dir is on PATH")
    print()


# --- check mode ----------------------------------------------------------

def cmd_check():
    print("MyClaudeCode — status check")
    print("=" * 70)
    try:
        cli_bin = json.loads(CLI_PKG.read_text(encoding="utf-8")).get("bin") or {}
        alias_present = "myclaudecode" in cli_bin
    except Exception:
        alias_present = False

    npm_cli = find_npm_cli()
    checks = [
        ("node on PATH", shutil.which(NODE) is not None),
        ("npm on PATH", shutil.which("npm") is not None),
        ("npm-cli.js located", npm_cli is not None),
        ("cli/node_modules exists", (CLI_DIR / "node_modules").exists()),
        ("extension ID generated", EXT_ID_FILE.exists()),
        ("myclaudecode bin alias in cli/package.json", alias_present),
        ("myclaudecode on PATH", shutil.which("myclaudecode") is not None),
    ]
    all_ok = True
    for label, status in checks:
        print(f"  [{'ok' if status else 'MISSING'}] {label}")
        if not status:
            all_ok = False
    print()
    if all_ok:
        print("All checks pass.")
        return 0
    print("Run `python install.py` (without --check) to fix.")
    return 1


# --- main -----------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Install MyClaudeCode.")
    parser.add_argument("--check", action="store_true", help="only check current state")
    parser.add_argument("--force", action="store_true", help="re-run even if state looks good")
    args = parser.parse_args()

    if args.check:
        return cmd_check()

    if not preflight():
        return 1
    if not npm_install():
        return 1
    if not install_native_host():
        return 1
    if not patch_cli_package_json():
        return 1

    link_method = link_globally()
    if link_method is None:
        if not write_shim_fallback():
            fail("could not register myclaudecode command")
            return 1

    if not verify():
        if link_method is not None:
            warn("verification failed despite successful npm link — writing fallback shims")
            write_shim_fallback()
            verify()

    summary(link_method)
    return 0


if __name__ == "__main__":
    sys.exit(main())