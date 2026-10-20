{-# LANGUAGE ForeignFunctionInterface #-}
{-# LANGUAGE OverloadedStrings #-}
module Ledger.Keys where

import Cardano.Api qualified as C
import Cardano.Crypto.Wallet qualified as W
import Codec.Binary.Bech32 qualified as Bech32
import Crypto.Error
import Crypto.Hash (Blake2b_224, Digest, hash)
import Crypto.PubKey.Ed25519 qualified as E
import Data.Aeson
import Data.Aeson.Types (Parser)
import Data.ByteArray (convert)
import Data.ByteString qualified as BS
import Data.Text (Text)
import Data.Text.Encoding (encodeUtf8)
import Foreign.C.Types
import Foreign.Ptr
import Foreign.Marshal.Alloc
import Data.Word
import LiveTx qualified as B
import System.IO.Unsafe (unsafePerformIO)

foreign import ccall unsafe "__wasi_random_get" randomGet :: Ptr Word8 -> CSize -> IO CInt

generate :: IO BS.ByteString
generate = allocaBytes 32 $ \pointer -> do
  result <- randomGet pointer 32
  if result /= 0 then fail "Secure WASI randomness is unavailable" else BS.packCStringLen (castPtr pointer,32)

foreign import ccall unsafe "cardano_crypto_ed25519_publickey" extendedPublicKey :: Ptr Word8 -> Ptr Word8 -> IO ()

publicExtended :: BS.ByteString -> BS.ByteString
publicExtended secret = unsafePerformIO $ BS.useAsCString secret $ \input -> allocaBytes 32 $ \output -> do
  extendedPublicKey (castPtr input) output
  BS.packCStringLen (castPtr output,32)

bech32 :: Text -> BS.ByteString -> Text
bech32 prefix bytes = Bech32.encodeLenient (either (error . show) id (Bech32.humanReadablePartFromText prefix)) (Bech32.dataPartFromBytes bytes)

unbech32 :: Text -> Parser BS.ByteString
unbech32 value = do
  (_,part) <- B.eitherP (Bech32.decodeLenient value)
  maybe (fail "Invalid bech32 byte payload") pure (Bech32.dataPartToBytes part)

data Private = Normal E.SecretKey | Extended W.XPrv

crypto :: CryptoFailable a -> Parser a
crypto (CryptoPassed a) = pure a
crypto (CryptoFailed e) = fail (show e)

private :: Text -> Parser Private
private value = do
  bytes <- unbech32 value
  case BS.length bytes of
    32 -> Normal <$> crypto (E.secretKey bytes)
    64 -> Extended <$> B.eitherP (W.xprv (bytes <> publicExtended bytes <> BS.replicate 32 0))
    96 -> let secret=BS.take 64 bytes in Extended <$> B.eitherP (W.xprv (secret <> publicExtended secret <> BS.drop 64 bytes))
    128 -> Extended <$> B.eitherP (W.xprv bytes)
    _ -> fail "Private key must contain 32, 64, 96 or 128 bytes"

public :: Private -> BS.ByteString
public (Normal key) = convert (E.toPublic key)
public (Extended key) = BS.take 32 (W.unXPub (W.toXPub key))

keyHash :: BS.ByteString -> Text
keyHash bytes = B.hexText (convert (hash bytes :: Digest Blake2b_224))

sign :: Private -> BS.ByteString -> BS.ByteString
sign (Normal key) message = convert (E.sign key (E.toPublic key) message)
sign (Extended key) message = W.unXSignature (W.sign (BS.empty :: BS.ByteString) key message)

witnessKey :: Private -> Parser C.ShelleyWitnessSigningKey
witnessKey (Normal key) = C.WitnessPaymentKey <$> B.eitherP (C.deserialiseFromRawBytes (C.AsSigningKey C.AsPaymentKey) (convert key))
witnessKey (Extended key) = C.WitnessPaymentExtendedKey <$> B.eitherP (C.deserialiseFromRawBytes (C.AsSigningKey C.AsPaymentExtendedKey) (W.unXPrv key))

fromSeed :: Object -> Parser Value
fromSeed o = do
  entropy <- o .: "entropy" >>= B.hexBytes
  password <- o .:? "password" .!= ""
  account <- o .:? "accountIndex" .!= 0 :: Parser Integer
  network <- o .:? "network" .!= 1 :: Parser Int
  kind <- o .:? "addressType" .!= ("Base" :: Text)
  if account < 0 || account > 2147483647 then fail "Invalid account index" else pure ()
  let derive key n = W.deriveXPrv W.DerivationScheme2 (BS.empty :: BS.ByteString) key n
      root = W.generateNew entropy (encodeUtf8 password) (BS.empty :: BS.ByteString)
      accountKey = foldl derive root [2147485500,2147485463,2147483648 + fromInteger account]
      pay = derive (derive accountKey 0) 0
      stake = derive (derive accountKey 2) 0
      payHash = keyHash (public (Extended pay))
      stakeHash = keyHash (public (Extended stake))
      net = if network == 1 then C.Mainnet else C.Testnet (C.NetworkMagic 0)
  ph <- B.raw (C.AsHash C.AsPaymentKey) payHash
  sh <- B.raw (C.AsHash C.AsStakeKey) stakeHash
  let stakeCredential = C.StakeCredentialByKey sh
      address = C.makeShelleyAddress net (C.PaymentCredentialByKey ph) (if kind == "Enterprise" then C.NoStakeAddress else C.StakeAddressByValue stakeCredential)
      reward = C.makeStakeAddress net stakeCredential
  pure $ object ["address" .= C.serialiseAddress address,"rewardAddress" .= (if kind == "Enterprise" then Null else String (C.serialiseAddress reward)),
    "paymentKey" .= bech32 "ed25519e_sk" (BS.take 64 (W.unXPrv pay)),"stakeKey" .= (if kind == "Enterprise" then Null else String (bech32 "ed25519e_sk" (BS.take 64 (W.unXPrv stake))))]
