# doc-doctor

Run every code sample in a documentation site on a fresh machine, and see which ones still work.

1. **Read the docs.** Pages come from the site's own `llms-full.txt`, or from [context.dev](https://context.dev) (map + scrape) when there is none.
2. **Decide what can run.** A sample is run only if a reader could paste it and expect it to work: a known language, complete on its own, no value to fill in, nothing that deletes. Everything else is skipped with a stated reason.
3. **Run it.** Each docs page gets a new [Boat](https://boat.dev) sandbox. The SDKs are installed with the docs' own commands, then each sample is run as published and recorded as a terminal session.
4. **Report.** One HTML file: a wall of tiles, one per sample, with the recording, the output and the measured API credits.

```bash
doc-doctor extract context-dev     # read the docs, save every code sample
doc-doctor plan context-dev        # what would run, what is skipped, estimated credits
doc-doctor run context-dev --budget=200
doc-doctor report context-dev      # runs/<target>/<run>/index.html
```

## Run it yourself

Doc Doctor is not a hosted service. You run it with your own accounts: your Boat login pays for the machines,
and your API key never goes to anyone else's server.

```bash
git clone https://github.com/forever8896/doc-doctor && cd doc-doctor
npm link                    # puts `doc-doctor` on your PATH (no dependencies to install)
doc-doctor serve            # local page on http://127.0.0.1:8797: paste a docs address, watch it run
doc-doctor serve --vault    # same, with the key kept in your own 1Claw vault
```

The page needs no target file: it reads the API host, the key variable and the SDK install commands from the
docs themselves.

## Rerun when the docs change

```bash
doc-doctor watch context-dev --every=30m --budget=100   # checks on a timer
doc-doctor watch context-dev --once                     # one check, for cron or CI
```

Each check re-reads the docs. A sample is identified by its page, language and exact text, so only samples
that are new or were edited get a machine; everything else keeps its verdict and recording from the last run.
When nothing changed, the check costs one download and no machines. `deploy/doc-doctor-watch.service` is a
systemd unit that keeps it running.

Bring your own keys: `boat login`, and the target's API key in the environment or in `~/.config/doc-doctor/env`.
A target is one JSON file in `targets/` (API patterns, install commands, price estimates, cleanup endpoints).

## Running with a key you never hold (1Claw)

`doc-doctor run <target> --vault` keeps the API key in a [1Claw](https://1claw.co) vault. The docs owner stores
the key as an HTTP binding limited to the API host and hands over a scoped agent key. Nothing else changes:

```bash
1claw agent create doc-doctor --execution-intents \
  --execution-guardrails '{"allowed_hosts":["api.context.dev"],"allowed_binding_types":["http"]}'
1claw agent binding create <agent-id> --name context-dev --type http \
  --config '{"base_url":"https://api.context.dev"}' \
  --guardrails '{"allowed_hosts":["api.context.dev"]}' --credential-from-env CONTEXT_DEV_API_KEY
# ~/.config/doc-doctor/1claw.env: ONECLAW_AGENT_ID=..., ONECLAW_AGENT_API_KEY=ocv_...
```

In each sandbox the API host resolves to the machine itself, where `1claw agent binding proxy` forwards the
call to the vault and the vault adds the real credential. Samples still call `https://api.context.dev` and read
`$CONTEXT_DEV_API_KEY` exactly as published; that variable holds a per-sandbox proxy token that is worthless
anywhere else. The owner can see every call in 1Claw and revoke the agent at any time.

What this does and does not protect: the real key never reaches the sandbox, the recordings or the person
running the tool. The sandbox does hold the agent key, which can make calls to that one host until revoked.

## Safety

- Hard credit budget, checked against the provider's usage endpoint after every sample.
- Samples that delete, cancel or rotate are never run.
- Resources a sample creates (monitors, batches) are removed afterwards; anything that existed before the run is never touched.
- The API key is written to the sandbox as a file, never passed on a command line, and is redacted from every recording.
- Samples run with no keyboard attached, like CI.
- Webhook signing secrets and token fields that a sample prints are masked in the report.
- A report contains whatever else the samples printed. Samples that read your account (`whoami`, list calls) print
  your email, resource names and billing details, so read a report before you publish it.

Requires Node 20+ and the Boat CLI. MIT licence.
