`data-codec.json.gz` records the public Data codec results from this fork's
Lucid Evolution 0.8.1 baseline, commit `6e290f7c28e4a785b776daf4207148f43ad242b4`,
before replacing its implementation. The source revision is also stored in the
fixture.

The corpus uses the original `data-cbor.test.ts` deterministic generators:
xorshift128+ with seeds `0x9e3779b9` and `0x243f6a88`. It includes 3,000 input
values with both node and canonical encodings, plus 15,000 decoding outcomes
covering nonminimal CBOR, chunked bytes/bignums, constructor tags, map order and
duplicate keys, truncation, malformed inputs, and trailing bytes.

These expectations were captured from the old implementation. Tests never
regenerate them with the Haskell codec under test. Map entries in recorded
values preserve iteration order; semantic comparisons between the two encoding
formats use maps directly because canonical key order can differ.
