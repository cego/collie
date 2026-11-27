import * as Arr from "effect/Array";

export interface ActivityPost {
  readonly seq: number;
  readonly id: string;
  readonly kind: string;
  readonly at: string;
  readonly actor: { readonly by: string; readonly kind: string };
  readonly text: string;
  readonly about: ReadonlyArray<string>;
  readonly source: { readonly kind: string; readonly run: string | null } | null;
}

const what = (post: ActivityPost) =>
  post.source === null ? post.kind : `${post.kind} · ${post.source.run ?? post.source.kind}`;

export const activityLines = (posts: ReadonlyArray<ActivityPost>) =>
  Arr.map(
    posts,
    (post) => `${post.at} · ${post.actor.by} · ${what(post)}: ${post.text} (${post.id})`,
  );

// WARNING: adding an older page above what is shown keeps one order and one anchor, however many pages are loaded.
export const withOlderPage = (
  shown: ReadonlyArray<ActivityPost>,
  older: ReadonlyArray<ActivityPost>,
) => [...Arr.filter(older, (post) => !Arr.some(shown, (one) => one.id === post.id)), ...shown];
