# oMLX for Orca

An [Orca](https://orca.dev) sidebar plugin for one or more [oMLX](https://github.com/jundot/omlx) servers on Apple Silicon. Use it when you serve local MLX models and want to manage them next to your agents: keep named connections (hostname by default) with per-server API keys in Orca’s encrypted secrets, load and unload models, watch memory and live requests, edit base settings, and restart without leaving the workspace.

The panel cannot open network connections. A trusted worker calls the oMLX admin API and the panel talks only to that worker.

Listing page: [orca.dev/plugins/aywengo/orca-mlx-plugin](https://orca.dev/plugins/aywengo/orca-mlx-plugin).

## What you can do

- Add multiple named connections (default name is the server hostname) and switch between them. Each connection has its own URL and API key.
- Save the main API key per connection. The panel shows whether a key is stored, and never shows the key again. The connection section collapses, and that choice is remembered.
- See bar meters for memory, model size, live requests, prefill, generation speed, and recent memory samples.
- Set how often the status bar polls the active connection.
- Load, unload, pin, and mark a default model. Rescan the model directories.
- Watch models that are loaded, including waiting, prefill, and generation, and abort one request.
- Edit host, port, log level, model directories, scheduler, memory guard, cache sizes, sampling defaults, and the idle timeout.
- Choose a paired Prefill Accelerator helper for a supported model, or leave the layer split on Auto.
- Replace the server’s main API key, then store the new key in this plugin.
- Restart oMLX when it is supervised by the macOS app or `brew services`.
- Read the tail of the server log.

Downloads, quantization, and benchmarks are not in this version. Pairing a helper stays in oMLX’s Cluster tab.

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

Poll interval appears under Settings, on this plugin’s row. Connections are managed in the panel. Host and port changes on the oMLX server apply after a restart.

## Develop

```sh
npm install
npm test
```

Tests cover the admin client (auth, load and unload, settings redaction, rejected URLs) and check `orca-plugin.json` against Orca’s published manifest schema. They do not launch Orca.
