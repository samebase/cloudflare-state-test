import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { decodeFqn } from "alchemy/FQN";
import { type BucketObjects, makeBucketState, type WriteCondition } from "alchemy/State/BucketState";
import { State, StateStoreError } from "alchemy/State/State";
import * as Console from "effect/Console";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

/**
 * An Alchemy state store on a branch of a GitHub repository.
 *
 * Built on Alchemy's BucketState, like the S3 and Cloud Storage stores. The
 * "bucket" is one Git branch: a key is a path, an object's version is its
 * blob sha. Writes queue up and one worker turns everything queued into one
 * commit through the Git Data API; the ref update with `force: false` is the
 * compare-and-swap, and a lost race starts the batch again on the new head.
 *
 * The lease (`__lease__.json`), which BucketState rewrites every 20 seconds
 * during a run, lives on a second branch, `<branch>-lock`, so the state branch
 * holds only state.
 */

export interface GitHubStateOptions {
  /** `owner/name`. @default GITHUB_REPOSITORY, else the `origin` remote */
  readonly repository?: string;
  /** @default "alchemy-state-store" */
  readonly branch?: string;
}

const API = "https://api.github.com";
const LEASE_FILE = "__lease__.json";
const MAX_CAS_ATTEMPTS = 20;

const STATE_README = `# Alchemy state

This branch holds the Alchemy state of this repository. Alchemy deploys write it; do not edit it
by hand. Each resource is one file, \`{stack}/{stage}/{resource}.json\`.

Secret values are sealed with a passphrase (ALCHEMY_STATE_PASSPHRASE): a file that holds a secret
starts with an \`alchemy:sealed:1:passphrase:\` header line, and each secret value is
\`{"__sealed__": "<ciphertext>"}\`. Every other value is plain JSON.

The deploy lock of each stage is on the branch of the same name with \`-lock\` at the end.
`;

const LOCK_README = `# Alchemy deploy locks

This branch holds the lock (\`{stack}/{stage}/__lease__.json\`) of each stage while a deploy runs.
The state itself is on the branch without \`-lock\`.
`;

// GitHub responses, validated.
const RefResponse = Schema.Struct({ object: Schema.Struct({ sha: Schema.String }) });
const TreeResponse = Schema.Struct({
  sha: Schema.String,
  truncated: Schema.Boolean,
  tree: Schema.Array(
    Schema.Struct({ path: Schema.String, type: Schema.String, sha: Schema.String }),
  ),
});
const ShaResponse = Schema.Struct({ sha: Schema.String });
const ContentsResponse = Schema.Struct({
  type: Schema.String,
  sha: Schema.String,
  encoding: Schema.String,
  content: Schema.String,
});

class Retryable extends Data.TaggedError("Retryable")<{ readonly message: string }> {}

interface Response {
  readonly status: number;
  readonly json: unknown;
}

/** A branch head: its commit, its tree, and every file's blob sha. */
interface Head {
  readonly commit: string;
  readonly tree: string;
  readonly files: ReadonlyMap<string, string>;
}

/** A queued write (`body`) or delete (`body` undefined). */
interface Pending {
  readonly key: string;
  readonly body: string | undefined;
  readonly condition: WriteCondition | undefined;
  readonly done: Deferred.Deferred<string | undefined, StateStoreError>;
}

/** The git blob sha of `text`: what GitHub reports as the file's sha. */
const blobSha = (text: string) => {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
};

const fail = (message: string) => new StateStoreError({ message });

const errorMessage = (json: unknown) =>
  typeof json === "object" && json !== null && "message" in json && typeof json.message === "string"
    ? json.message
    : "";

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** `owner/name` from GITHUB_REPOSITORY or the `origin` remote. */
const resolveRepository = (explicit: string | undefined) =>
  Effect.try({
    try: () => {
      const fromEnv = explicit ?? process.env["GITHUB_REPOSITORY"];
      if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
      const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
      const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
      if (match?.[1] === undefined) throw new Error(`origin is not a GitHub remote: ${url}`);
      return match[1];
    },
    catch: (cause) =>
      fail(
        `GitHub state store: no repository. Set GITHUB_REPOSITORY or pass { repository }. ${cause instanceof Error ? cause.message : ""}`,
      ),
  });

/** What the commit message calls a key: `{stack}/{stage}/{file}`. */
const describeKey = (key: string) => {
  const parts = key.split("/");
  const file = parts[parts.length - 1] ?? key;
  if (parts.length < 3) return { group: "", name: file.replace(/\.json$/, "") };
  const name =
    file === "__stack_output__.json"
      ? "stack output"
      : file === LEASE_FILE
        ? "lock"
        : decodeFqn(file.replace(/\.json$/, ""));
  return { group: `${parts.slice(0, -2).join("/")} ${parts[parts.length - 2]}`, name };
};

const listNames = (verb: string, names: ReadonlyArray<string>) =>
  names.length === 0
    ? []
    : names.length <= 5
      ? [`${verb} ${names.join(", ")}`]
      : [`${verb} ${names.length} resources`];

/** `owner/name prod: set Deployment, Site; delete Old`, one line per stage. */
const commitMessage = (
  changes: ReadonlyArray<{ readonly key: string; readonly deleted: boolean; readonly lock: string }>,
) => {
  const groups = new Map<string, { set: string[]; deleted: string[]; lock: string[] }>();
  for (const change of changes) {
    const { group, name } = describeKey(change.key);
    const entry = groups.get(group) ?? { set: [], deleted: [], lock: [] };
    if (change.lock !== "") entry.lock.push(change.lock);
    else if (change.deleted) entry.deleted.push(name);
    else entry.set.push(name);
    groups.set(group, entry);
  }
  return Array.from(groups, ([group, entry]) => {
    const what = [
      ...entry.lock,
      ...listNames("set", entry.set),
      ...listNames("delete", entry.deleted),
    ].join("; ");
    return group === "" ? `store: ${what}` : `${group}: ${what}`;
  }).join("\n");
};

/** The BucketObjects of one branch (plus its `-lock` branch), bound to the ambient scope. */
export const makeGitHubObjects = (options: GitHubStateOptions = {}) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const token = process.env["GITHUB_TOKEN"] || process.env["GH_TOKEN"];
    if (token === undefined || token === "") {
      return yield* fail("GitHub state store: set GITHUB_TOKEN or GH_TOKEN");
    }
    const repository = yield* resolveRepository(options.repository);
    const stateBranch = options.branch ?? "alchemy-state-store";
    const repoPath = `/repos/${encodePath(repository)}`;

    const stats = {
      calls: 0,
      writeCalls: 0,
      retries: 0,
      rateLimited: 0,
      conflicts: 0,
      commits: new Map<string, number>(),
      rateFirst: "",
      rateLast: "",
    };
    // Added first, so it runs after every other finalizer of the store.
    yield* Effect.addFinalizer(() =>
      Console.error(
        `[github-state] ${repository}: ${stats.calls} GitHub API calls (${stats.writeCalls} POST/PATCH), ` +
          `commits ${JSON.stringify(Object.fromEntries(stats.commits))}, ${stats.conflicts} ref conflicts, ` +
          `${stats.retries} retries, ${stats.rateLimited} rate limited, ` +
          `x-ratelimit-remaining ${stats.rateFirst} -> ${stats.rateLast}`,
      ),
    );

    const call = (method: "GET" | "POST" | "PATCH", path: string, body?: unknown) =>
      Effect.gen(function* () {
        const base = HttpClientRequest.make(method)(`${API}${repoPath}${path}`, {
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "alchemy-github-state",
          },
        });
        const request = body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, body);
        stats.calls++;
        if (method !== "GET") stats.writeCalls++;
        const response = yield* client
          .execute(request)
          .pipe(Effect.mapError((cause) => new Retryable({ message: cause.message })));
        const remaining = response.headers["x-ratelimit-remaining"];
        if (remaining !== undefined) {
          if (stats.rateFirst === "") stats.rateFirst = remaining;
          stats.rateLast = remaining;
        }
        const text = yield* response.text.pipe(
          Effect.mapError((cause) => new Retryable({ message: cause.message })),
        );
        const json: unknown = yield* Effect.try({
          try: (): unknown => (text === "" ? undefined : JSON.parse(text)),
          catch: () => new Retryable({ message: `${method} ${path}: not JSON (${response.status})` }),
        });
        const status = response.status;
        const retryAfter = response.headers["retry-after"];
        const limited =
          (status === 403 || status === 429) &&
          (retryAfter !== undefined || remaining === "0" || /rate limit/i.test(errorMessage(json)));
        if (limited) {
          stats.rateLimited++;
          const seconds = Number(retryAfter ?? "60");
          if (seconds > 120) {
            return yield* fail(
              `GitHub rate limit on ${method} ${path}: retry after ${seconds}s (${errorMessage(json)})`,
            );
          }
          yield* Effect.sleep(`${seconds} seconds`);
          return yield* new Retryable({ message: `${method} ${path}: rate limited (${status})` });
        }
        if (status >= 500) {
          return yield* new Retryable({ message: `${method} ${path}: ${status} ${errorMessage(json)}` });
        }
        const result: Response = { status, json };
        return result;
      }).pipe(
        Effect.tapError((error) =>
          error._tag === "Retryable"
            ? Effect.sync(() => {
                stats.retries++;
              })
            : Effect.void,
        ),
        Effect.retry({
          while: (error) => error._tag === "Retryable",
          schedule: Schedule.exponential("500 millis"),
          times: 5,
        }),
        Effect.mapError((error) =>
          error._tag === "Retryable" ? fail(`GitHub state store: ${error.message}`) : error,
        ),
      );

    const decode = <S extends Schema.Codec<unknown, unknown>>(schema: S, what: string) =>
      (json: unknown) =>
        Schema.decodeUnknownEffect(schema)(json).pipe(
          Effect.mapError((cause) => fail(`GitHub state store: unexpected ${what}: ${cause.message}`)),
        );

    const unexpected = (what: string, response: Response) =>
      fail(`GitHub state store: ${what} answered ${response.status} ${errorMessage(response.json)}`);

    /** A branch's head and every file in it; `undefined` when the branch does not exist. */
    const loadHead = (branch: string) =>
      Effect.gen(function* () {
        const ref = yield* call("GET", `/git/ref/heads/${encodePath(branch)}`);
        if (ref.status === 404) return undefined;
        if (ref.status !== 200) return yield* unexpected(`GET ref ${branch}`, ref);
        const commit = (yield* decode(RefResponse, "ref")(ref.json)).object.sha;
        const treeResponse = yield* call("GET", `/git/trees/${commit}?recursive=1`);
        if (treeResponse.status !== 200) return yield* unexpected(`GET tree ${branch}`, treeResponse);
        const tree = yield* decode(TreeResponse, "tree")(treeResponse.json);
        if (tree.truncated) {
          return yield* fail(`GitHub state store: the tree of ${branch} is too large (truncated)`);
        }
        const files = new Map<string, string>();
        for (const entry of tree.tree) if (entry.type === "blob") files.set(entry.path, entry.sha);
        const head: Head = { commit, tree: tree.sha, files };
        return head;
      });

    /** Every file path on a branch, with one call. */
    const listPaths = (branch: string) =>
      Effect.gen(function* () {
        const response = yield* call("GET", `/git/trees/${encodePath(branch)}?recursive=1`);
        if (response.status === 404 || response.status === 409) return [];
        if (response.status !== 200) return yield* unexpected(`GET tree ${branch}`, response);
        const tree = yield* decode(TreeResponse, "tree")(response.json);
        if (tree.truncated) {
          return yield* fail(`GitHub state store: the tree of ${branch} is too large (truncated)`);
        }
        return tree.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path);
      });

    /** A queue and the worker that turns everything queued into one commit on `branch`. */
    const makeBranch = (branch: string, readme: string) =>
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<Pending>();
        // The head this process last wrote. Used optimistically: the ref update fails
        // if another writer moved the branch since.
        let cached: Head | undefined;

        const commitBatch = (batch: ReadonlyArray<Pending>) =>
          Effect.gen(function* () {
            for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
              const fromCache = cached !== undefined;
              const base = cached ?? (yield* loadHead(branch));
              cached = undefined;
              const files = new Map(base?.files ?? []);
              const results: Array<string | undefined> = [];
              const changed = new Map<string, { body: string | undefined; lock: string }>();
              let conditionFailed = false;
              for (const pending of batch) {
                const current = files.get(pending.key);
                const condition = pending.condition;
                if (pending.body === undefined) {
                  // A delete of a missing file, or of one at another version, does nothing.
                  if (
                    current !== undefined &&
                    (condition === undefined ||
                      ("ifVersion" in condition && condition.ifVersion === current))
                  ) {
                    files.delete(pending.key);
                    changed.set(pending.key, { body: undefined, lock: "release lock" });
                  } else if (condition !== undefined) conditionFailed = true;
                  results.push(undefined);
                  continue;
                }
                if (condition !== undefined) {
                  const holds =
                    "ifAbsent" in condition
                      ? current === undefined
                      : current === condition.ifVersion;
                  if (!holds) {
                    conditionFailed = true;
                    results.push(undefined);
                    continue;
                  }
                }
                const sha = blobSha(pending.body);
                files.set(pending.key, sha);
                changed.set(pending.key, {
                  body: pending.body,
                  lock:
                    condition === undefined
                      ? ""
                      : "ifAbsent" in condition
                        ? "take lock"
                        : "renew lock",
                });
                results.push(sha);
              }
              const effective = Array.from(changed).filter(([path, change]) =>
                change.body === undefined
                  ? base?.files.has(path) === true
                  : base?.files.get(path) !== blobSha(change.body),
              );
              // A failed condition or "nothing to write" against the cached head may be
              // stale: check against the branch as it is now.
              if (fromCache && (conditionFailed || effective.length === 0)) continue;
              if (effective.length === 0) {
                cached = base;
                return results;
              }
              const isLock = branch !== stateBranch;
              const message = commitMessage(
                effective.map(([key, change]) => ({
                  key,
                  deleted: change.body === undefined,
                  lock: isLock ? change.lock : "",
                })),
              );
              const entries = effective.map(([path, change]) =>
                change.body === undefined
                  ? { path, mode: "100644", type: "blob", sha: null }
                  : { path, mode: "100644", type: "blob", content: change.body },
              );
              const treeResponse = yield* call(
                "POST",
                "/git/trees",
                base === undefined
                  ? {
                      tree: [
                        { path: "README.md", mode: "100644", type: "blob", content: readme },
                        ...entries.filter((entry) => !("sha" in entry)),
                      ],
                    }
                  : { base_tree: base.tree, tree: entries },
              );
              if (treeResponse.status !== 201) {
                return yield* unexpected(`POST tree ${branch}`, treeResponse);
              }
              const tree = (yield* decode(ShaResponse, "tree")(treeResponse.json)).sha;
              const commitResponse = yield* call("POST", "/git/commits", {
                message,
                tree,
                parents: base === undefined ? [] : [base.commit],
              });
              if (commitResponse.status !== 201) {
                return yield* unexpected(`POST commit ${branch}`, commitResponse);
              }
              const commit = (yield* decode(ShaResponse, "commit")(commitResponse.json)).sha;
              const refResponse =
                base === undefined
                  ? yield* call("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: commit })
                  : yield* call("PATCH", `/git/refs/heads/${encodePath(branch)}`, {
                      sha: commit,
                      force: false,
                    });
              if (refResponse.status === 422) {
                // Another writer moved (or created) the branch: start again on its head.
                stats.conflicts++;
                continue;
              }
              if (refResponse.status !== 200 && refResponse.status !== 201) {
                return yield* unexpected(`update ref ${branch}`, refResponse);
              }
              stats.commits.set(branch, (stats.commits.get(branch) ?? 0) + 1);
              cached = { commit, tree, files };
              return results;
            }
            return yield* fail(
              `GitHub state store: ${branch} kept moving; gave up after ${MAX_CAS_ATTEMPTS} attempts`,
            );
          });

        yield* Queue.takeAll(queue).pipe(
          Effect.flatMap((batch) =>
            commitBatch(batch).pipe(
              Effect.flatMap((results) =>
                Effect.forEach(
                  batch,
                  (pending, i) => Deferred.succeed(pending.done, results[i]),
                  { discard: true },
                ),
              ),
              Effect.catch((error) =>
                Effect.forEach(batch, (pending) => Deferred.fail(pending.done, error), {
                  discard: true,
                }),
              ),
            ),
          ),
          Effect.forever,
          Effect.forkScoped,
        );

        /** Queue a write or delete; the deferred resolves once its commit is on the branch. */
        return (key: string, body: string | undefined, condition: WriteCondition | undefined) =>
          Effect.gen(function* () {
            const done = yield* Deferred.make<string | undefined, StateStoreError>();
            yield* Queue.offer(queue, { key, body, condition, done });
            return done;
          });
      });

    const queueState = yield* makeBranch(stateBranch, STATE_README);
    const lockBranch = `${stateBranch}-lock`;
    const queueLock = yield* makeBranch(lockBranch, LOCK_README);
    const isLease = (key: string) => key === LEASE_FILE || key.endsWith(`/${LEASE_FILE}`);
    const branchOf = (key: string) => (isLease(key) ? lockBranch : stateBranch);
    const enqueue = (key: string, body: string | undefined, condition: WriteCondition | undefined) =>
      isLease(key) ? queueLock(key, body, condition) : queueState(key, body, condition);
    // A queued write lands even when its caller is interrupted, so the caller waits for it.
    // BucketState interrupts a lease renewal before it releases the lease; an interruptible
    // wait let the renewal land after the release read the lease, and the release then
    // deleted nothing (seen in check D2).
    const submit = (key: string, body: string | undefined, condition: WriteCondition | undefined) =>
      enqueue(key, body, condition).pipe(Effect.flatMap(Deferred.await), Effect.uninterruptible);

    const objects: BucketObjects = {
      listKeys: (prefix) =>
        listPaths(stateBranch).pipe(
          Effect.map((paths) => paths.filter((path) => path.startsWith(prefix))),
        ),
      listChildren: (prefix) =>
        listPaths(stateBranch).pipe(
          Effect.map((paths) => {
            const children = new Set<string>();
            for (const path of paths) {
              if (!path.startsWith(prefix)) continue;
              const rest = path.slice(prefix.length);
              const slash = rest.indexOf("/");
              if (slash > 0) children.add(rest.slice(0, slash));
            }
            return Array.from(children);
          }),
        ),
      read: (key) =>
        Effect.gen(function* () {
          const branch = branchOf(key);
          const response = yield* call(
            "GET",
            `/contents/${encodePath(key)}?ref=${encodeURIComponent(branch)}`,
          );
          if (response.status === 404) return undefined;
          if (response.status !== 200) return yield* unexpected(`GET contents ${key}`, response);
          const file = yield* decode(ContentsResponse, "contents")(response.json);
          if (file.type !== "file" || file.encoding !== "base64") {
            return yield* fail(
              `GitHub state store: ${key} is a ${file.type} with encoding ${file.encoding}, not a file`,
            );
          }
          return { text: Buffer.from(file.content, "base64").toString("utf8"), version: file.sha };
        }),
      write: (key, body, condition) => submit(key, body, condition),
      delete: (key, ifVersion) =>
        submit(key, undefined, ifVersion === undefined ? undefined : { ifVersion }).pipe(
          Effect.asVoid,
        ),
      // Queue every delete before waiting, so they land in one commit.
      deleteMany: (keys) =>
        Effect.forEach(keys, (key) => enqueue(key, undefined, undefined)).pipe(
          Effect.flatMap((pending) => Effect.forEach(pending, Deferred.await, { discard: true })),
          Effect.uninterruptible,
        ),
    };

    return objects;
  });

export const makeGitHubState = (options: GitHubStateOptions = {}) =>
  makeGitHubObjects(options).pipe(
    Effect.flatMap((objects) =>
      makeBucketState({ id: "github", label: "GitHub", objects: Effect.succeed(objects) }),
    ),
  );

/**
 * The State layer. Provide a StateEncryption to seal secrets:
 * `GitHubState.state().pipe(Layer.provide(passphraseEncryption()))`.
 */
export const state = (options: GitHubStateOptions = {}) =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const context = yield* Effect.context<HttpClient.HttpClient | SecureRandom.SecureRandom>();
      // Built on the first state operation, bound to this layer's scope.
      const make = Scope.provide(makeGitHubState(options), scope).pipe(
        Effect.orDie,
        Effect.provideContext(context),
      );
      return yield* Effect.cached(make);
    }),
  );
