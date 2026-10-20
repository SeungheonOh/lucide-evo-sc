#include <Rts.h>
#include <stdlib.h>

void lucid_init(void) {
  RtsConfig config = defaultRtsConfig;
  config.rts_opts_enabled = RtsOptsAll;
  config.rts_opts = "-K64m";
  hs_init_ghc(NULL, NULL, config);
}

void *lucid_alloc(size_t length) {
  return malloc(length);
}

void lucid_free(void *pointer) {
  free(pointer);
}
