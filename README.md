# GitHub core clone

A standalone, GitHub-compatible git forge in one Node 22 process, standard
library only, no git binary, no UI: git smart HTTP (upload-pack protocol v2,
receive-pack v0), the REST v3 API under `/api/v3`, GraphQL at `/api/graphql`,
and MCP at `/mcp`, all over one in-memory store.

Run it with `node main.ts` (Node >= 22.18). It binds an ephemeral port,
registers it at `$MAKEFUN_ENV_URL/register`, serves until the env answers
`{"done": true}` on `/done`, then exits 0. Requests carry
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

Layout: `main.ts` is the lifecycle, `app.ts` the HTTP server, `store.ts` the
in-memory store, `git.ts` the object model / packfiles / pkt-lines,
`git-http.ts` the smart-HTTP protocol, `rest.ts` the REST routes, `graphql.ts`
the GraphQL executor, `mcp.ts` the MCP endpoint.
