// The spike stack of `@samebase/alchemy-kit/github-state`: harmless resources whose state goes to the branch
// `alchemy-state-store` of this repository, secrets sealed with the key ALCHEMY_GITHUB_STATE_KEY.
// `withRunRecord` adds the record of the run to each stage output, under `samebase.run`.
//
// - `GitHub.Label` `spike-<stage>`: a real resource, managed with the run's GitHub token.
// - `Alchemy.Random`: its OUTPUT `text` is a secret.
// - `Note`: a resource that does nothing remote; its INPUT prop `secret` takes the Random value,
//   so the state holds a sealed input prop too.
// The stage `scale` has 40 Random resources and nothing else.
import * as GitHub from "@alchemy.run/github";
import * as GitHubState from "@samebase/alchemy-kit/github-state";
import { withRunRecord } from "@samebase/alchemy-kit/run-record";
import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";

type Note = Resource<
  "Spike.Note",
  { readonly secret: Redacted.Redacted<string>; readonly text: string },
  { readonly length: number }
>;
const Note = Resource<Note>("Spike.Note");
const NoteProvider = () =>
  Provider.succeed(Note, {
    reconcile: ({ news }) => Effect.succeed({ length: news.text.length }),
    delete: () => Effect.void,
  });

export default Alchemy.Stack(
  "github-state-spike",
  {
    providers: Layer.mergeAll(GitHub.providers(), Alchemy.RandomProvider(), NoteProvider()),
    state: withRunRecord(GitHubState.state()),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    if (stage === "scale") {
      for (let i = 0; i < 40; i++) yield* Alchemy.Random(`Random${i}`, { bytes: 8 });
      return { randoms: 40 };
    }
    const random = yield* Alchemy.Random("Secret", { bytes: 16 });
    const note = yield* Note("Note", {
      secret: random.text,
      text: process.env["SPIKE_NOTE"] ?? "first",
    });
    const label = yield* GitHub.Label("Label", {
      owner: "samebase",
      repository: "cloudflare-state-test",
      name: `spike-${stage}`,
      color: "c5def5",
      description: `GitHub state store spike, stage ${stage}`,
    });
    return { label: label.url, length: note.length };
  }),
);
