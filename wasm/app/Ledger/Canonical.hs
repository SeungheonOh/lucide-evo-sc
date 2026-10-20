{-# LANGUAGE OverloadedStrings #-}
module Ledger.Canonical (transaction, redeemer, request, signed) where

import Codec.CBOR.Term
import Codec.CBOR.Decoding qualified as D
import Codec.CBOR.Encoding qualified as E
import Codec.CBOR.Read (deserialiseFromBytes)
import Codec.CBOR.Write (toStrictByteString)
import Control.Monad (replicateM)
import Data.Aeson
import Data.Aeson.Types (Parser)
import Data.Aeson.KeyMap qualified as KM
import Data.ByteString qualified as BS
import Data.ByteString.Lazy qualified as BL
import Data.List (sortOn)
import Data.Text.Lazy qualified as TL
import Ledger.Cbor qualified as CBOR
import LiveTx qualified as B

-- Plutus maps are ordered values. Canonical encoding may reorder their entries.
redeemer :: Term -> Term
redeemer original =
  let candidate = dataCanonical original
  in if semantic original == semantic candidate then candidate else original

-- Plutus byte strings use chunks of at most 64 bytes in both formats.
dataCanonical :: Term -> Term
dataCanonical (TInteger number)
  | number > 18446744073709551615 = TTagged 2 (dataCanonical (TBytes (integerBytes number)))
  | number < -18446744073709551616 = TTagged 3 (dataCanonical (TBytes (integerBytes (-1-number))))
  | otherwise = TInteger number
  where integerBytes = BS.reverse . BS.unfoldr (\n -> if n == 0 then Nothing else Just (fromInteger (n `mod` 256),n `div` 256))
dataCanonical (TBytes bytes)
  | BS.length bytes > 64 = TBytesI (BL.fromChunks (chunks bytes))
  | otherwise = TBytes bytes
  where chunks value | BS.null value = []
                     | otherwise = let (first,rest) = BS.splitAt 64 value in first : chunks rest
dataCanonical (TBytesI bytes) = dataCanonical (TBytes (BL.toStrict bytes))
dataCanonical (TList values) = TList (map dataCanonical values)
dataCanonical (TListI values) = dataCanonical (TList values)
dataCanonical (TMap values) = TMap (sortOn (\(key,_) -> let bytes=CBOR.encode key in (BS.length bytes,bytes)) [(dataCanonical k,dataCanonical v) | (k,v) <- values])
dataCanonical (TMapI values) = dataCanonical (TMap values)
dataCanonical (TTagged tag value) = TTagged tag (dataCanonical value)
dataCanonical value = CBOR.canonical value

semantic :: Term -> Term
semantic (TInt n) = TInteger (fromIntegral n)
semantic (TListI xs) = semantic (TList xs)
semantic (TList xs) = TList (map semantic xs)
semantic (TMapI xs) = semantic (TMap xs)
semantic (TMap xs) = TMap [(semantic k,semantic v) | (k,v) <- xs]
semantic (TBytesI bytes) = TBytes (BL.toStrict bytes)
semantic (TStringI text) = TString (TL.toStrict text)
semantic (TTagged tag value) | tag == 2 || tag == 3 = case value of
  TBytes bytes -> number bytes
  TBytesI bytes -> number (BL.toStrict bytes)
  _ -> TTagged tag (semantic value)
  where number bytes = let n = BS.foldl' (\acc byte -> acc*256 + fromIntegral byte) 0 bytes in TInteger (if tag == 2 then n else -1-n)
semantic (TTagged tag value) = TTagged tag (semantic value)
semantic value = value

request :: Value -> Parser Value
request (Object o) = Object . KM.fromList <$> traverse convert (KM.toList o)
  where convert ("redeemerCbor",String text) = do
          term <- B.hexBytes text >>= CBOR.decode
          pure ("redeemerCbor",String (B.hexText (CBOR.encode (redeemer term))))
        convert (key,value) = (,) key <$> request value
request (Array xs) = Array <$> traverse request xs
request value = pure value

signed :: Term -> Parser Bool
signed value = do
  parts <- CBOR.list value
  case parts of
    _:witnesses:_ -> do
      fields <- CBOR.pairs witnesses
      present <- traverse (\(key,value) -> if key `elem` [TInt 0,TInt 2,TInteger 0,TInteger 2]
        then not . null <$> CBOR.list value else pure False) fields
      pure (or present)
    _ -> fail "Transaction must contain a body and witnesses"

-- Raw spans retain memoized datum bytes, including deliberately non-minimal
-- integer/length encodings that a generic Term round trip would normalize.
data Raw = Raw { term :: Term, original :: BS.ByteString, children :: [Raw] }

rawDecoder :: BS.ByteString -> D.Decoder s Raw
rawDecoder input = do
  before <- D.peekByteOffset
  token <- D.peekTokenType
  (value,nested) <- case token of
    D.TypeListLen -> list =<< D.decodeListLen
    D.TypeListLen64 -> list =<< D.decodeListLen
    D.TypeListLenIndef -> do
      D.decodeListLenIndef
      values <- indefinite
      pure (TListI (map term values),values)
    D.TypeMapLen -> pairs =<< D.decodeMapLen
    D.TypeMapLen64 -> pairs =<< D.decodeMapLen
    D.TypeMapLenIndef -> do
      D.decodeMapLenIndef
      values <- indefinite
      pure (TMapI (pairTerms values),values)
    D.TypeTag -> tag =<< D.decodeTag64
    D.TypeTag64 -> tag =<< D.decodeTag64
    _ -> do value <- CBOR.decodeTermWith False False; pure (value,[])
  after <- D.peekByteOffset
  pure (Raw value (BS.take (fromIntegral (after-before)) (BS.drop (fromIntegral before) input)) nested)
  where
    recurse = rawDecoder input
    list count = do
      values <- replicateM count recurse
      pure (TList (map term values),values)
    pairs count = do
      values <- replicateM (count*2) recurse
      pure (TMap (pairTerms values),values)
    tag number = do
      value <- recurse
      pure (TTagged number (term value),[value])
    indefinite = do
      done <- D.decodeBreakOr
      if done then pure [] else (:) <$> recurse <*> indefinite
    pairTerms (key:value:rest) = (term key,term value):pairTerms rest
    pairTerms _ = []

rawList :: Raw -> Parser [Raw]
rawList value = case term value of
  TList _ -> pure (children value)
  TListI _ -> pure (children value)
  TTagged 258 _ -> case children value of [child] -> rawList child; _ -> fail "Invalid set"
  _ -> fail "Expected CBOR list"

rawPairs :: Raw -> Parser [(Raw,Raw)]
rawPairs value = case term value of
  TMap _ -> pair (children value)
  TMapI _ -> pair (children value)
  _ -> fail "Expected CBOR map"
  where pair [] = pure []
        pair (key:value:rest) = ((key,value):) <$> pair rest
        pair _ = fail "Invalid CBOR map"

encoded :: Raw -> BS.ByteString
encoded = CBOR.encode . CBOR.canonical . term

listBytes :: [BS.ByteString] -> BS.ByteString
listBytes values = toStrictByteString (E.encodeListLen (fromIntegral (length values)) <> foldMap E.encodePreEncoded values)

mapBytes :: [(BS.ByteString,BS.ByteString)] -> BS.ByteString
mapBytes values = toStrictByteString (E.encodeMapLen (fromIntegral (length values)) <> foldMap (\(key,value) -> E.encodePreEncoded key <> E.encodePreEncoded value) ordered)
  where ordered = sortOn (\(key,_) -> (BS.length key,key)) values

transaction :: BS.ByteString -> Parser BS.ByteString
transaction bytes = do
  (remaining,value) <- B.eitherP (deserialiseFromBytes (rawDecoder bytes) (BL.fromStrict bytes))
  if not (BL.null remaining) then fail "Trailing CBOR bytes" else pure ()
  parts <- rawList value
  case parts of
    [body,witnesses,isValid,auxiliary] -> do
      bodyEntries <- rawPairs body
      let committed = any (\(key,_) -> term key `elem` [TInt 11,TInteger 11]) bodyEntries
          auxiliaryCommitted = any (\(key,_) -> term key `elem` [TInt 7,TInteger 7]) bodyEntries
      bodyFields <- traverse bodyField bodyEntries
      witnessFields <- rawPairs witnesses >>= traverse (witnessField committed)
      pure (listBytes [mapBytes bodyFields,mapBytes witnessFields,encoded isValid,if auxiliaryCommitted then original auxiliary else encoded auxiliary])
    _ -> fail "A Conway transaction must have four fields"
  where
    tagged transform value = do
      values <- rawList value >>= traverse transform
      pure (toStrictByteString (E.encodeTag 258 <> E.encodePreEncoded (listBytes values)))
    bodyField (key,value) = do
      index <- CBOR.integer (term key)
      next <- case index of
        1 -> listBytes <$> (rawList value >>= traverse output)
        16 -> output value
        _ | index `elem` [0,4,13,14,18,20] -> tagged (pure . encoded) value
          | otherwise -> pure (encoded value)
      pure (encoded key,next)
    output value = case term value of
      TMap _ -> fields
      TMapI _ -> fields
      _ -> pure (encoded value)
      where fields = mapBytes . map (\(key,value) -> (encoded key,if term key `elem` [TInt 2,TInteger 2] then original value else encoded value)) <$> rawPairs value
    witnessField committed (key,value) = do
      index <- CBOR.integer (term key)
      next <- case index of
        _ | committed && index `elem` [4,5] -> pure (original value)
        1 -> tagged (pure . original) value
        4 -> tagged (pure . original) value
        5 -> redeemers value
        _ | index `elem` [0,1,2,3,6,7] -> tagged (pure . encoded) value
          | otherwise -> pure (encoded value)
      pure (encoded key,next)
    redeemers value = case term value of
      TMap _ -> mapBytes <$> (rawPairs value >>= traverse mappedRedeemer)
      TMapI _ -> mapBytes <$> (rawPairs value >>= traverse mappedRedeemer)
      _ -> listBytes <$> (rawList value >>= traverse legacyRedeemer)
    sameDatum datum = semantic (term datum) == semantic (dataCanonical (term datum))
    mappedRedeemer (key,value) = do
      fields <- rawList value
      case fields of
        [datum,units] -> pure (encoded key,if sameDatum datum then listBytes [CBOR.encode (redeemer (term datum)),encoded units] else original value)
        _ -> fail "Redeemer value must contain data and execution units"
    legacyRedeemer value = do
      fields <- rawList value
      case fields of
        [tag,index,datum,units] -> pure $ if sameDatum datum
          then listBytes [encoded tag,encoded index,CBOR.encode (redeemer (term datum)),encoded units]
          else original value
        _ -> fail "Legacy redeemer must contain four fields"
