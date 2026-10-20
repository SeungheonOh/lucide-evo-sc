import type { RedeemerTag } from "@lucid-evolution/core-types";
const tags: readonly RedeemerTag[] = [
  "spend",
  "mint",
  "publish",
  "withdraw",
  "vote",
  "propose",
];
export function toRedeemerTagIndex(tag: string): number {
  const index = tags.indexOf(tag as RedeemerTag);
  if (index < 0) throw new Error(`Unknown redeemer tag: ${tag}`);
  return index;
}
export function fromRedeemerTagIndex(index: number): RedeemerTag {
  const tag = tags[index];
  if (!tag) throw new Error(`Unknown redeemer tag index: ${index}`);
  return tag;
}
