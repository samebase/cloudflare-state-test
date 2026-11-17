FIRST RESULT: works. Checks A to F done (D found a store bug, fixed). Next: G (GitHub Actions).

# GitHub state store spike: progress

## A. Laptop deploys, stage demo (2026-11-17, 02:49 to 02:50)

| Run | Result | Wall time | API calls by the store (POST/PATCH) | Commits alchemy-state | Commits alchemy-state-lock | Core rate limit (gh api rate_limit) |
|---|---|---|---|---|---|---|
| 1. first deploy, 3 creates | ok | 18 s | 41 (24) | 6 | 2 | 4964 -> 4947 |
| 2. same again | ok, "Plan: no changes" | 10 s | 27 (6) | 0 | 2 | 4943 -> 4922 |
| 3. change Note's input `text` | ok, 1 update | 15 s | 37 (15) | 3 | 2 | 4918 -> 4896 |

Rate limit numbers include the `gh api` calls of the measuring script and the Label provider's own calls.
The `x-ratelimit-remaining` header the store saw jumped around (run 2: 4942 -> 4949, up), so it is
not a reliable counter.

Lease: each deploy made 2 commits on the lock branch (take, release). No 20 s renewal landed, because
each run was under 20 s.

Fixes needed to get here (findings, details in the report):
- pnpm refused the PR preview of `@alchemy.run/github` (its `@distilled.cloud/github` dependency is a
  URL): `ERR_PNPM_EXOTIC_SUBDEP`. Needed `blockExoticSubdeps: false`.
- `GitHubState.state().pipe(Layer.provide(passphraseEncryption()))`, the PR's documented form, does
  not type-check as a stack's `state` (error type StateStoreError, not never). Needed `Layer.orDie`.

## B. Files on the branch

Paths: `README.md`, `__alchemy_store__.json` (`{"format":1}`), and
`samebase/cloudflare-state-test/github-state-spike/demo/{Label,Note,Secret,__stack_output__}.json`.
The slash in the stack name becomes real directories.

A file with a secret is NOT plain JSON: line 1 is `alchemy:sealed:1:passphrase:<wrapped data key>`,
the rest is JSON with `{"__sealed__": "..."}` for each secret. Label.json (no secret) is plain JSON.
Sealed: Secret.json `attr.text` (an OUTPUT) and Note.json `props.secret` (an INPUT prop).

CLI with the slashed stack name:
- `alchemy state ls` -> `samebase/` (the first path segment, not the stack).
- `alchemy state ls samebase` -> `samebase/cloudflare-state-test/` (stack "samebase", stage "cloudflare-state-test").
- `alchemy state ls .../demo` -> lists Label, Note, Secret plus a bogus `demo//` (decodeFqn of `__stack_output__`).
- `alchemy state read <stack>/demo/Note` -> `null`. The CLI cannot read any record of this stack.
- Every one of these read-only commands took the lease (2 commits on the lock branch), on the bogus
  stage `samebase cloudflare-state-test`.

## C. Without the key

- No passphrase: `plan` fails before reading state: `State encryption needs a passphrase`.
- Wrong passphrase: `plan` fails: `Could not open the encrypted secrets of '...github-state-spike/demo': wrong passphrase, or the state was moved from another stage`. No garbage.
- Store without any encryption layer (SPIKE_NO_ENCRYPTION=1): `plan` fails: `Failed to read state object '.../Note.json': its secrets are encrypted with 'passphrase', and this state store has no StateEncryption to open them.`
- So through Alchemy, a reader without the key cannot read even the plain fields of a sealed record.
  A reader of the raw file can: drop line 1 and parse the rest as JSON.
- Each failed plan still took and released the lease (2 lock commits).

## D. Concurrency

1. Two deploys of `demo` together (changed input): one done in 14 s; the other failed in 3.6 s with `another deploy holds the GitHub state lock 'samebase/cloudflare-state-test/github-state-spike/demo'`. It lost the ref race on the lock branch (1 conflict), reloaded, found the lease. `plan demo` afterwards: no changes. Consistent.
2. Two new stages `d2a`, `d2b` together: both succeeded, 30 s wall, 11 state commits, 7 ref conflicts on alchemy-state (d2a 1, d2b 6), 123 store API calls in total.
   BUG FOUND (this store): d2b exited 0 but left its lease on the lock branch. Its 20 s renewal commit landed at 00:53:27, one second after "Done". BucketState interrupts the renewal and then releases; the release read the lease (old version) while the renewal was still queued, the renewal landed, and the conditional delete then matched nothing. `plan d2b` and `destroy d2b` failed for up to 60 s (lease TTL) with "another deploy holds". Fix: the store waits for a queued write uninterruptibly (src/GitHubState.ts, submit). After the fix `destroy d2b` took over the expired lease and released it.
   Destroy of d2a: 20 s, 52 calls, 5 state commits. Destroy of d2b: 19 s, 53 calls, 5 state commits.

## E. Crash

- Started `deploy --stage demo` (changed input), printed the PID with `ps` (44110, node), `kill -9 44110` at 02:55:57.
- The kill landed after the apply: both `set Note` commits were on the branch, the output printed,
  but the lease was never released (last lock commit: `take lock` at 00:55:48Z). So this tested a
  crash while closing, not in the middle of a resource write.
- Deploy at 02:56:07 and 02:56:25: fail at once (2 to 3 s, 4 API calls) with
  `another deploy holds the GitHub state lock '.../demo'`. Nothing waits or retries.
- Deploy at 02:56:46 (lease `expiresAt` passed): took the expired lease over, `Plan: no changes`,
  10 s, 28 calls, released. Blocked time after the kill: 49 s (60 s TTL from the last write of the lease).

## F. Contract test

No shared suite exists upstream: `BucketState.test.ts` has one lease test over an in-memory bucket,
the GCS and S3 stores have no BucketObjects suite, `@alchemy.run/test` has none. Wrote
`src/GitHubState.test.ts` (vitest 5.0.5; `vp` is not installed in this worktree). Live, on a
throwaway branch `alchemy-state-test-<random>`, both branches deleted at the end (204, 204).

Run twice, 10/10 passed each time, 57 s. Results:
- ifAbsent creates the branch (root commit with README.md), second ifAbsent refused.
- Read right after write: 10/10 reads saw the new blob sha. No read-after-write lag seen.
- ifVersion stale loses, current wins. Conditional delete: wrong version keeps, right deletes, missing ok.
- listKeys / listChildren right.
- 10 concurrent writes from one store: 1 commit, 5 API calls.
- deleteMany of 4 keys (one missing): 1 commit.
- Two independent stores, ifAbsent on one key at once: exactly one wins (loser: 1 ref conflict, reload, refused).
- Same for ifVersion from one base: exactly one wins.
- Lease key goes only to the `-lock` branch.
- A serial write costs about 1.8 s (10 writes plus 10 reads: 18.4 s) and 3 POST/PATCH calls.

