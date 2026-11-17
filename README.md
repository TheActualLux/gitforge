# gitforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/TheActualLux/gitforge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/TheActualLux/gitforge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process: git smart
HTTP for clone and push, the REST v3 API for repositories, issues, pull
requests and contents, GraphQL v4, and an MCP endpoint, all served from the
process's own store with no UI, no outside service and no git binary.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 node main.ts
```

It binds an ephemeral port, registers it with the suite, serves the API, and
long-polls the suite's `/done` before exiting 0.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
