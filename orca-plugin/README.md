# Skepsis Review — Orca Plugin

Open [Skepsis](https://github.com/oxidecomputer/skepsis) code reviews in your local browser (Chrome) directly from Orca — for **local workspaces**, **paired Orca Remote Servers (`runtime:*`)**, and **SSH workspaces (`ssh:*`)**.

## Features

- **One-click review in Chrome**: click **Skepsis** in Orca's bottom status bar, press `Mod+Alt+R` (`Cmd+Option+R` on macOS), run **Open Skepsis Review in Browser**, or use the right-sidebar **Skepsis** panel.
- **Diff & Files review + Orca Agents**: send line comments from both Diff view and full-file Files view straight to existing or newly launched Orca agents in the same worktree.
- **Low-memory `Cmd+Click` symbol jump**: jump to class/method definitions (via on-demand `rg` / `git grep`) with `Alt+←` / `Alt+→` navigation history.
- **Local & Remote workspaces with zero remote port exposure**:
  - **Local workspaces**: served directly from the desktop worker on `127.0.0.1:<port>/wt/<slug>/`.
  - **Remote Orca Server (`runtime:*`) & SSH (`ssh:*`) workspaces**:
    - Static UI assets are served locally from your machine (zero 18 MB upload, always in sync).
    - Orca agent listing & comment delivery run locally through `orca --environment <name>` (reusing your paired Orca connection).
    - Diff, file reads, and symbol jump run inside a lightweight single-file Node agent (`~/.cache/skepsis/`) over a multiplexed **SSH stdio** channel — **no remote TCP ports are opened**, and the remote process exits automatically when you stop the server or close Orca.

---

## Prerequisites

### Local machine (macOS / Linux / Windows)

- **Orca Desktop** `>= 1.4.248`
- **Node.js `>= 22`** (only needed when building the plugin from source)

### Remote host (required for Orca Remote Server & SSH workspaces)

1. **Passwordless SSH access** from your desktop machine (`ssh <host>` working via `~/.ssh/config` and `ssh-agent` with `BatchMode=yes`).
2. **Node.js `>= 22` installed on the remote host** (Node 20+ minimum; Node 22 LTS recommended):
   ```sh
   # Verify on the remote host:
   node -v   # v22.x.x or newer
   ```
   > **Note (nvm / fnm / custom install paths):** Non-interactive SSH shells often do not load `~/.bashrc` or `~/.zshrc`. The plugin auto-probes `PATH`, `bash -lc`, `~/.nvm`, `~/.volta`, `/usr/local/bin`, and `/opt/homebrew/bin`. If Node is installed elsewhere, set **Remote Node.js Path** in plugin settings.
3. **Git** (or `jj`) on the remote host.
4. _(Optional, recommended)_ **`ripgrep` (`rg`)** on the remote host for fastest `Cmd+Click` class/method jump (automatically falls back to `git grep` if `rg` is not installed).

---

## Build & Install

From the repository root:

```sh
npm run build:orca-plugin
```

This builds Skepsis and syncs `dist/lib.js`, `dist/lib.d.ts`, and `dist/web/` into `orca-plugin/dist/`.

### Load in Orca Desktop (Settings UI — recommended)

1. Open Orca → **Settings → Plugins** → turn on **Plugins**.
2. Click **Development folders…** and choose `<repo>/orca-plugin`.
3. Review the requested permissions and click **Approve & Enable**.

### Or load via CLI

```sh
# Interactive watch & live logs:
/Applications/Orca.app/Contents/Resources/bin/orca plugin dev watch ./orca-plugin

# Or persistent dev load (prints the --approve <fingerprint> command):
/Applications/Orca.app/Contents/Resources/bin/orca plugin dev load ./orca-plugin
```

After rebuilding Skepsis (`npm run build:orca-plugin`), click **Restart** on the plugin row in Orca Settings (or run `orca plugin restart local.skepsis-review`) to pick up the new bundle.

---

## Settings (`Settings → Plugins → Skepsis Review`)

| Setting                       | Default                     | Description                                                                                                                                                                         |
| ----------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Browser Open Command**      | _(empty — system default)_  | Command used to open the review URL (URL is passed as the final argument). Example for macOS Chrome: `open -a "Google Chrome"`                                                      |
| **Tab Size**                  | `2`                         | Tab width in columns (1–16).                                                                                                                                                        |
| **Default Diff Base**         | _(empty — auto merge-base)_ | Optional git/jj base ref (e.g. `HEAD` or `origin/main`). Falls back to `HEAD` automatically if no `main`/`master` branch exists.                                                    |
| **Orca CLI Path**             | _(empty — auto-detect)_     | Explicit path to `orca` CLI if not on `PATH` or `/Applications/Orca.app/Contents/Resources/bin/orca`.                                                                               |
| **Remote SSH Host Overrides** | _(empty)_                   | Map Orca remote environment/host names to `~/.ssh/config` aliases, one per line (`orderlyClaw2=my-ssh-alias`), or JSON. By default the plugin uses the Orca SSH host name directly. |
| **Remote Node.js Path**       | _(empty — auto-detect)_     | Explicit path to Node.js 22+ on remote hosts (e.g. `/usr/local/bin/node` or `/home/node/.nvm/versions/node/v22.14.0/bin/node`).                                                     |
