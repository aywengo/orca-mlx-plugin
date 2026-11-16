# oMLX for Orca

An [Orca](https://orca.dev) sidebar plugin for a running [oMLX](https://github.com/jundot/omlx) server. It stores the main API key in Orca’s encrypted secrets, then lists models, loads and unloads them, shows what is currently in memory, and edits the server’s base settings.

The panel cannot open network connections. A trusted worker calls the oMLX admin API and the panel talks only to that worker.

## What you can do

- Save the main API key. The panel shows whether a key is stored, and never shows the key again.
- Set the server URL (default `http://127.0.0.1:8000`) and how often the status bar polls.
- Load, unload, pin, and mark a default model. Rescan the model directories.
- Watch models that are loaded, including waiting, prefill, and generation, and abort one request.
- Edit host, port, log level, model directories, scheduler, memory guard, cache sizes, sampling defaults, and the idle timeout.
- Replace the server’s main API key, then store the new key in this plugin.
- Restart oMLX when it is supervised by the macOS app or `brew services`.
- Read the tail of the server log.

Downloads, quantization, benchmarks, and per-model acceleration settings are not in this version.

## Requirements

- Orca `1.4.248` or newer, desktop app.
- An oMLX server. The admin routes accept the main API key as `Authorization: Bearer`. Sub-keys can load a model, and are rejected by the other admin routes.

On a machine whose secret store reports `unavailable`, the plugin will not fall back to a plaintext setting. Save the key on a machine with an OS keychain (macOS does).

## Load it while you work

From this directory, with Orca running:

```sh
orca plugin dev watch .
```

Orca asks you to approve the trusted worker and the `secrets:own`, `settings:own`, and `notifications:show` capabilities. Approve that prompt, then open the **oMLX** panel in the right sidebar.

The same check the plugin directory runs:

```sh
orca plugin validate .
```

Server URL and poll interval also appear under Settings, on this plugin’s row. Host and port changes on the oMLX server apply after a restart.

## Develop

```sh
npm install
npm test
```

Tests cover the admin client (auth, load and unload, settings redaction, rejected URLs) and check `orca-plugin.json` against Orca’s published manifest schema. They do not launch Orca.
