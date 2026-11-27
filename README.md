# Alchemy state on a GitHub branch

An example app that [Alchemy v2](https://alchemy.run) deploys, with its Alchemy state in this
repository, on the branch
[`alchemy-state-store`](https://github.com/samebase/cloudflare-state-test/tree/alchemy-state-store).
The state needs no bucket, no database, and no extra account: the repository and the `GITHUB_TOKEN`
of the run are enough.

[Live site](https://elated-clam-974.convex.site) ·
[The state](https://github.com/samebase/cloudflare-state-test/tree/alchemy-state-store) ·
[The deploys](https://github.com/samebase/cloudflare-state-test/actions/workflows/alchemy.yml) ·
[The store's package](https://github.com/samebase/samebase/tree/main/packages/alchemy-kit#github-state-store)

## The whole setup

One line in [`alchemy.run.ts`](./alchemy.run.ts) gives the stack its state store (shortened here):

```ts
import * as GitHubState from "@samebase/alchemy-kit/github-state";

export default Alchemy.Stack(
  repository,
  {
    providers: Layer.mergeAll(Convex.providers(), IdentityBroker.providers()),
    state: Convex.withRunRecord(GitHubState.state()),
  },
  program,
);
```

`withRunRecord` adds the commit and the run to each stage output. The store works without it.

The workflow [`alchemy.yml`](./.github/workflows/alchemy.yml) gives each run two things:

- `permissions: contents: write`, so the run writes the branch with its own `GITHUB_TOKEN`.
- The repository secret `ALCHEMY_GITHUB_STATE_KEY`, which seals each secret in the state.

The first deploy made the two branches. The
[quick start](https://github.com/samebase/samebase/tree/main/packages/alchemy-kit#quick-start) has
the same steps for your repository.

## Where to look

- **[The state](https://github.com/samebase/cloudflare-state-test/tree/alchemy-state-store)** is one
  JSON file for each resource, `{stack}/{stage}/{resource}.json`.
  [`prod/IdentityHubClient.json`](https://github.com/samebase/cloudflare-state-test/blob/alchemy-state-store/samebase/cloudflare-state-test/prod/IdentityHubClient.json)
  is plain JSON, and its client secret is sealed with AES-256-GCM.
- **[Each write is a commit](https://github.com/samebase/cloudflare-state-test/commits/alchemy-state-store)**
  that names what it changed, such as `samebase/cloudflare-state-test prod: set Site`.
- **[The lock](https://github.com/samebase/cloudflare-state-test/commits/alchemy-state-store-lock)**
  of each stage is on the branch `alchemy-state-store-lock`. A second deploy of the same stage
  fails at once.
- **The stages.** A push to `main` deploys the stage `prod`. Each pull request deploys the stage
  `pr-<number>`, and closing it removes the preview and its state.
- **A preview and production deploy at the same time.** A preview reads the Convex project from the
  state of `prod` (`Convex.Project.ref("Project", { stage: "prod" })`). That read takes no lock, so
  each deploy holds only the lock of its own stage.

## How the store works

- It is Alchemy's own `makeBucketState` (`alchemy/State/BucketState`) with a Git branch as the
  bucket, read and written through GitHub's Git database API.
- All the writes that are waiting go into one commit. When another deploy moved the branch first,
  the store reads the new head and tries again.
- The lock is a lease file. A deploy renews it while it runs, and it ends after 60 seconds if the
  deploy stops without a release.
- The sealing of secrets is the package's own until Alchemy releases state encryption
  ([alchemy-run/alchemy#3167](https://github.com/alchemy-run/alchemy/pull/3167)).

The [package's README](https://github.com/samebase/samebase/tree/main/packages/alchemy-kit#limits)
has the limits, and
[`GitHubState.ts`](https://github.com/samebase/samebase/blob/main/packages/alchemy-kit/src/github-state/GitHubState.ts)
is the source.

## The app

The app is the [samebase/base](https://github.com/samebase/base) starter: a public todo list on
[Convex](https://convex.dev), with Google sign-in on every pull request preview. Its README has the
app, the sign-in, and local development.

One thing differs here: a local `alchemy` run needs `GITHUB_TOKEN` and `ALCHEMY_GITHUB_STATE_KEY` in
its environment. See
[From your laptop](https://github.com/samebase/samebase/tree/main/packages/alchemy-kit#from-your-laptop).

- [How deploys work](./docs/deploys.md): the stages, the state, and local `alchemy deploy`.
- [Google sign-in](./docs/google-sign-in.md): the broker, `/oauth-client.json`, development, the
  broker's terms, and how to run your own broker.
- [Files](./docs/files.md): where things are, and which files are generated.

## License

[MIT](./LICENSE). Copy it, change it, ship it; keep the copyright line. See
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for
included third-party material.
