# How deploys work

`alchemy.run.ts` is the stack. The stage `prod` is the production deployment. Any other stage is a
preview deployment named after the stage, which `alchemy destroy` deletes. The push is the `deploy` package script, run by the
Convex deployment resource when the functions, the build inputs, `package.json`, or the lockfile
change; an unchanged checkout deploys nothing.

`.github/workflows/alchemy.yml` calls the shared deploy workflow of samebase/samebase, which names
the stages as [Alchemy's CI guide](https://alchemy.run/environments/ci) does: it deploys each push
to `main` to the stage `prod`, deploys each pull request from this repository to the stage
`pr-<number>`, a preview deployment with that name, keeps one comment on the pull request with the
stacks and their addresses, and destroys that stage when the pull request closes, all with the team token
`CONVEX_ACCESS_TOKEN`. The token names its team, and creates the Convex project of the repository
and the short-lived deploy keys of each run. No deploy key is stored anywhere.

The stack is named after the repository, `owner/name` (`GITHUB_REPOSITORY`, or the origin remote in
development), and so is its Convex project. Every run, in CI or local, keeps the state of its stage
on the branch `alchemy-state-store` of this repository, which the first run creates, under the stack
name: one JSON file for each resource, with each secret sealed by the key
`ALCHEMY_GITHUB_STATE_KEY`. The stage `prod` owns the project, and `alchemy destroy --stage prod`
deletes it. A deploy holds the lock of its stage on the branch `alchemy-state-store-lock`, so a
second deploy of the same stage fails at once; the workflow also queues the runs of one stage. See
the [store's README](https://github.com/samebase/samebase/tree/main/packages/alchemy-kit#github-state-store).

A local run needs `GITHUB_TOKEN` and `ALCHEMY_GITHUB_STATE_KEY` in its environment, and uses
`npx convex login` when `CONVEX_ACCESS_TOKEN` is not set:

```sh
pnpm exec alchemy deploy --stage my-preview
pnpm exec alchemy destroy --stage my-preview
```

`pnpm run deploy` runs `npx convex deploy` with the checks, the build, and the upload as its
`--cmd`, so a failed check stops the release before the push switches the site. Inside that build,
`scripts/ensure-convex-auth.ts` creates the Convex Auth keys on a new deployment or preview, keeps
keys that exist, and sets `OAUTH_CLIENT_ID` to `<site>/oauth-client.json` when it differs; it stops
the deploy when the deployment it selects is not the one that the deploy targets. Deploy with
`pnpm run deploy`, never with a plain `npx convex deploy`: a plain push serves the files of the last
deploy from this checkout, often another deployment's.

The build prerenders `/about` with the Convex client, so it needs `VITE_CONVEX_URL` in `.env.local`,
which the first `pnpm run dev` writes; CI passes a placeholder.

## Serving the files

`convex/http.ts` answers each path as a Cloudflare Worker with static assets does: a file of the
build, else the page that the server build of `src/server.ts` renders, including the 404 page. The
build prerenders `/about` into a file, served at `/about` (`--html-handling drop-trailing-slash`).
The files follow Cloudflare's static asset rules. See the
[convex-hosting documentation](https://github.com/samebase/convex-hosting#documentation) for custom
domains, headers, and the deploy options.
