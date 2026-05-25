# Client identity binds to the user's existing `~/.ssh/id_ed25519` keypair

`install/client.sh` registers the public half of `~/.ssh/id_ed25519` rather than generating a SideChat-scoped keypair under `.sidechat/`. The server-side Client fingerprint is `sha256(raw 32-byte ed25519 pubkey)` of that key.

We picked this for install UX: most developers already have an Ed25519 SSH key, so registration becomes zero-key-management — no new secret to back up, no extra prompt at install, no path for the bot to lose its identity when its project dir is wiped. The cost is reduced blast-radius isolation: a SideChat compromise also exposes the user's general-purpose SSH credential, and there is no way to rotate "just SideChat's key" without rotating the user's SSH key everywhere.

## Consequences

- **One Client per machine, by construction.** Since each user has one `~/.ssh/id_ed25519`, every project dir running `install/client.sh` lands on the same fingerprint. Multiple Claude Code sessions on a machine are the same Client; this is the intended model (see `CONTEXT.md` → Client).
- **No SideChat-scoped key rotation.** Compromise response means rotating the user's SSH key everywhere it's used, then re-registering with SideChat and getting Admin re-approval.
- **`409 already registered` is load-bearing.** A second registration attempt on the same machine (e.g. a re-run of `install/client.sh` in a new project dir) is rejected by the server because the fingerprint already exists. `--force` exists to skip re-registration and just write the new project's config files against the existing identity.
