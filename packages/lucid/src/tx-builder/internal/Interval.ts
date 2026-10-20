import { recordScValidity } from "../../sc-tools/intent.js";
import * as Effect from "effect/Effect";
import { UnixTime } from "@lucid-evolution/core-types";
import * as TxBuilder from "../TxBuilder.js";
import { unixTimeToEnclosingSlot } from "@lucid-evolution/plutus";
import { TxConfig } from "./Service.js";

export const validFrom = (unixTime: UnixTime) =>
  Effect.gen(function* () {
    const { config } = yield* TxConfig;
    const slot = unixTimeToEnclosingSlot(
      unixTime,
      config.lucidConfig.slotConfig,
    );
    recordScValidity(config, "from", slot);
  });
export const validTo = (unixTime: UnixTime) =>
  Effect.gen(function* () {
    const { config } = yield* TxConfig;
    const slot = unixTimeToEnclosingSlot(
      unixTime,
      config.lucidConfig.slotConfig,
    );
    recordScValidity(config, "until", slot);
  });
