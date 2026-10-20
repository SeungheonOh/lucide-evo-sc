import type {
  AddressDetails,
  Credential,
  Network,
  RewardAddress,
  CertificateValidator,
  WithdrawalValidator,
} from "@lucid-evolution/core-types";
import { ledger } from "@lucid-evolution/ledger";
import { networkToId } from "./network.js";
import { validatorToScriptHash } from "./scripts.js";

export function getAddressDetails(address: string): AddressDetails {
  try {
    return ledger("address.inspect", { address });
  } catch {
    throw new Error(`No address type matched for: ${address}`);
  }
}

export const addressFromHexOrBech32 = getAddressDetails;

export function credentialToRewardAddress(
  network: Network,
  stakeCredential: Credential,
): RewardAddress {
  return ledger("address.fromCredentials", {
    network: networkToId(network),
    stake: stakeCredential,
  });
}

export function validatorToRewardAddress(
  network: Network,
  validator: CertificateValidator | WithdrawalValidator,
): RewardAddress {
  return credentialToRewardAddress(network, {
    type: "Script",
    hash: validatorToScriptHash(validator),
  });
}
