{-# LANGUAGE OverloadedStrings #-}
module Ledger.Address (inspect, fromCredentials) where

import Cardano.Api qualified as C
import Cardano.Ledger.Address (getNetwork)
import Data.Aeson
import Data.Aeson.Types (Parser, parseEither)
import Data.Bits
import Data.ByteString qualified as BS
import Data.Text (Text)
import Ledger.Keys qualified as Keys
import LiveTx qualified as B

inspect :: Text -> Parser Value
inspect value = case parseEither (const (Keys.unbech32 value)) Null of
  Right bytes -> raw bytes
  Left _ -> case parseEither (const (B.hexBytes value)) Null of
    Right bytes -> raw bytes
    Left _ -> case C.deserialiseAddress C.AsAddressAny value of
      Just address@(C.AddressByron _) -> byron address
      _ -> fail "Invalid address"
  where
    byron address = do
      eraAddress <- B.eitherP (C.anyAddressInEra C.ConwayEra address)
      pure $ object ["type" .= ("Byron" :: Text),"networkId" .= (if getNetwork (C.toShelleyAddr eraAddress) == C.toShelleyNetwork C.Mainnet then 1 :: Int else 0),
        "address" .= object ["hex" .= C.serialiseToRawBytesHexText address,"bech32" .= ("" :: Text)]]
    raw bytes
      | BS.null bytes = fail "Empty address"
      | kind <= 3 && BS.length bytes >= 57 = pure (details "Base" ["paymentCredential" .= credential (kind .&. 1 == 1) (BS.take 28 (BS.drop 1 bytes)),"stakeCredential" .= credential (kind .&. 2 == 2) (BS.take 28 (BS.drop 29 bytes))])
      | (kind == 4 || kind == 5) && BS.length bytes >= 32 = do
          pointer (BS.drop 29 bytes) 3
          pure (details "Pointer" ["paymentCredential" .= credential (kind == 5) (BS.take 28 (BS.drop 1 bytes))])
      | (kind == 6 || kind == 7) && BS.length bytes >= 29 = pure (details "Enterprise" ["paymentCredential" .= credential (kind == 7) (BS.take 28 (BS.drop 1 bytes))])
      | (kind == 14 || kind == 15) && BS.length bytes >= 29 = pure (details "Reward" ["stakeCredential" .= credential (kind == 15) (BS.take 28 (BS.drop 1 bytes))])
      | kind == 8 = B.raw C.AsAddressAny (B.hexText bytes) >>= byron
      | otherwise = fail "Invalid address payload"
      where kind = BS.head bytes `shiftR` 4
            network = BS.head bytes .&. 15
            prefix = (if kind >= 14 then "stake" else "addr") <> (if network == 0 then "_test" else "")
            details kind fields = object (["type" .= (kind :: Text),"networkId" .= network,"address" .= object ["hex" .= B.hexText bytes,"bech32" .= Keys.bech32 prefix bytes]] <> fields)
    credential script hash = object ["type" .= (if script then "Script" else "Key" :: Text),"hash" .= B.hexText hash]
    pointer _ 0 = pure ()
    pointer bytes count = consume bytes 0 >>= \remaining -> pointer remaining (count-1)
    consume bytes width = case BS.uncons bytes of
      Nothing -> fail "Truncated address pointer"
      Just (byte,remaining) | width >= 10 -> fail "Address pointer is too large"
                            | byte .&. 128 == 0 -> pure remaining
                            | otherwise -> consume remaining (width+1)

fromCredentials :: Object -> Parser Text
fromCredentials o = do
  network <- o .: "network" :: Parser Int
  if network < 0 || network > 15 then fail "Network ID must fit four bits" else pure ()
  payment <- o .:? "payment" >>= traverse credential
  stake <- o .:? "stake" >>= traverse credential
  (kind,payload) <- case (payment,stake) of
    (Just (p,pk),Just (s,sk)) -> pure (p + 2*s,pk <> sk)
    (Just (p,pk),Nothing) -> pure (6+p,pk)
    (Nothing,Just (s,sk)) -> pure (14+s,sk)
    _ -> fail "An address requires a credential"
  let bytes = BS.cons (fromIntegral (kind * 16 + network)) payload
      prefix = (if kind >= 14 then "stake" else "addr") <> (if network == 0 then "_test" else "")
  pure (Keys.bech32 prefix bytes)
  where credential = withObject "credential" $ \value -> do
          kind <- value .: "type" :: Parser Text
          hash <- value .: "hash" >>= B.hexBytes
          if BS.length hash /= 28 then fail "Credential hash must have 28 bytes" else pure ()
          tag <- case kind of "Key" -> pure 0; "Script" -> pure 1; _ -> fail "Credential must be Key or Script"
          pure (tag,hash)
