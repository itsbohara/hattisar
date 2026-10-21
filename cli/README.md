# hattisar CLI

Command line client for a [hattisar](https://github.com/itsbohara/hattisar) server's JSON API.
Node 24 or newer, no dependencies.

```sh
npm install -g hattisar
hattisar login https://hattisar.example.com   # paste an API token from Settings → API tokens
hattisar projects create "My App"
psql "$(hattisar projects url my-app)"
```

The token is read from a hidden prompt, or from stdin when stdin is not a terminal
(`hattisar login <url> < token.txt`). It is never accepted as an argument.

## Commands

```
hattisar login <url>                 hattisar logout              hattisar whoami
hattisar projects list [--deleted]
hattisar projects create <name> [--ref <ref>] [--box <id> | --new-box]
hattisar projects show <ref>
hattisar projects url <ref> [--transaction]
hattisar projects rotate <ref>
hattisar projects delete <ref> --confirm <ref>
hattisar projects restore <ref>
hattisar backups list <ref>
hattisar backups run <ref>
hattisar backups restore <ref> <backup-id> --confirm <ref>
hattisar boxes list
```

Every command takes `--help` and `--json`; `--json` prints the API's JSON.

`projects url` prints one URL with the real password: the session pooler on the shared box, the
direct connection elsewhere. `--transaction` picks the transaction pooler instead. Migrations stay
with the official `supabase` CLI: `supabase db push --db-url "$(hattisar projects url my-app)"`.

`projects restore` takes a project back out of the trash. `backups restore` replaces a project's
data with one of its backups.

## Configuration

`login` saves `{ "url", "token" }` to `$XDG_CONFIG_HOME/hattisar/config.json` (default
`~/.config/hattisar/config.json`), mode 0600. `HATTISAR_URL` and `HATTISAR_TOKEN` override it,
for CI.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | API or network error |
| 2 | Usage error |
| 3 | Not logged in, or the token was refused |

Errors go to stderr as `hattisar: <message>`.
