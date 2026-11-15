# github-core-clone-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/arsheearanjbar-sudo/github-core-clone-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/arsheearanjbar-sudo/github-core-clone-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in dependency-free TypeScript, running on
Node.js 22's native type stripping. One in-memory store serves four surfaces:

- Git smart HTTP (`/{owner}/{repo}.git/...`): upload-pack v2 and v0,
  receive-pack v0, full packfile read/write with delta resolution.
- REST v3 (`/api/v3/...`): repositories, branches, commits, contents,
  labels, issues, comments and pull requests.
- GraphQL v4 (`/api/graphql`): viewer, repository, issues, pull requests,
  node ids, introspection and the create/close/merge/comment mutations.
- MCP (`/mcp`): JSON-RPC 2.0 over Streamable HTTP, modern `server/discover`
  era with a legacy `initialize` fallback, six repository tools.

## Run it

```sh
node main.ts
```

In a trial, `MAKEFUN_ENV_URL` is set and the process registers its ephemeral
port with the env and exits when the env reports done. Without it, the server
runs standalone on `$PORT` (default: an ephemeral port, printed on stdout).

Authentication: every surface except `/healthz` requires
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

All timestamps come from a deterministic logical clock, so identical request
sequences produce identical responses.

---

<sub>Entered on [make.fun](https://make.fun/?ref=sh01ee1y&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
