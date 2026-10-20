{-# LANGUAGE OverloadedStrings #-}
module Ledger.Data (encodeData, decodeData, numericData) where

import Cardano.Api qualified as C
import Codec.CBOR.Term
import Codec.CBOR.Read (deserialiseFromBytes)
import Data.Aeson
import Data.Aeson.Types (Parser, parseEither)
import Control.Monad.State.Strict (StateT, evalStateT, get, put, lift)
import Data.Bits ((.&.), shiftR)
import Data.Word (Word8)
import Data.Aeson.Key qualified as Key
import Data.Aeson.KeyMap qualified as KM
import Data.ByteString qualified as BS
import Data.ByteString.Lazy qualified as BL
import Data.List (sortOn, foldl')
import Ledger.Cbor qualified as CBOR
import LiveTx qualified as B

numericData :: Value -> Parser Value
numericData (Object o) = Object . KM.fromList <$> traverse field (KM.toList o)
  where field (key,String text) | key == "int" || key == "constructor" = (,) key . Number . fromInteger <$> B.integerP (String text)
        field (key,value) = (,) key <$> numericData value
numericData (Array values) = Array <$> traverse numericData values
numericData value = pure value

encodeData :: Bool -> C.ScriptData -> BS.ByteString
encodeData canonical = CBOR.encode . term . stored
  where
    term (C.ScriptDataConstructor index fields)
      | index >= 0 && index <= 6 = TTagged (fromInteger (121 + index)) (items (map term fields))
      | index >= 7 && index <= 127 = TTagged (fromInteger (1280 + index - 7)) (items (map term fields))
      | otherwise = TTagged 102 (items [TInteger index,items (map term fields)])
    term (C.ScriptDataList values) = items (map term values)
    term (C.ScriptDataMap pairs) =
      let sorted = if canonical then sortOn (\(key,_) -> let bytes=encodeData True key in (BS.length bytes,bytes)) pairs else sortOn (ordered . fst) pairs
          terms = [(term key,term value) | (key,value) <- sorted]
      in (if canonical || null terms then TMap else TMapI) terms
    term (C.ScriptDataNumber integer)
      | integer >= 0 && integer <= 18446744073709551615 = TInteger integer
      | integer < 0 && integer >= -18446744073709551616 = TInteger integer
      | integer >= 0 = TTagged 2 (bytes (integerBytes integer))
      | otherwise = TTagged 3 (bytes (integerBytes (-1-integer)))
    term (C.ScriptDataBytes value) = bytes value
    items values = (if canonical || null values then TList else TListI) values
    bytes value = if BS.length value <= 64 then TBytes value else TBytesI (BL.fromChunks (chunks value))
    chunks value | BS.null value = []
                 | otherwise = let (a,b)=BS.splitAt 64 value in a:chunks b
    integerBytes 0 = BS.singleton 0
    integerBytes integer = BS.reverse (BS.unfoldr (\n -> if n == 0 then Nothing else Just (fromInteger (n `mod` 256),n `div` 256)) integer)

stored :: C.ScriptData -> C.ScriptData
stored (C.ScriptDataConstructor n xs) = C.ScriptDataConstructor n (map stored xs)
stored (C.ScriptDataList xs) = C.ScriptDataList (map stored xs)
stored (C.ScriptDataMap xs) = C.ScriptDataMap (foldl' insert [] [(stored k,stored v) | (k,v) <- xs])
  where insert pairs pair@(key,_) = filter ((/= key) . fst) pairs <> [pair]
stored value = value

ordered :: C.ScriptData -> C.ScriptData
ordered (C.ScriptDataConstructor n xs) = C.ScriptDataConstructor n (map ordered xs)
ordered (C.ScriptDataList xs) = C.ScriptDataList (map ordered xs)
ordered (C.ScriptDataMap xs) = C.ScriptDataMap (sortOn fst [(ordered k,ordered v) | (k,v) <- xs])
ordered value = value

decodeData :: BS.ByteString -> Parser C.ScriptData
decodeData bytes = do
  -- Lucid's public Data.from reads one value and permits trailing bytes.
  let strict = do
        (_,value) <- B.eitherP (deserialiseFromBytes CBOR.decodeCompatible (BL.fromStrict bytes))
        fromTerm value
  raw <- case parseEither (const strict) Null of
    Right value -> pure value
    Left _ -> either fail pure (decodeLegacy bytes)
  pure (decoded raw)
  where
    fromTerm (TInt n) = pure (C.ScriptDataNumber (fromIntegral n))
    fromTerm (TInteger n) = pure (C.ScriptDataNumber n)
    fromTerm (TBytes bytes) = pure (C.ScriptDataBytes bytes)
    fromTerm (TBytesI bytes) = pure (C.ScriptDataBytes (BL.toStrict bytes))
    fromTerm (TList xs) = C.ScriptDataList <$> traverse fromTerm xs
    fromTerm (TListI xs) = C.ScriptDataList <$> traverse fromTerm xs
    fromTerm (TMap pairs) = C.ScriptDataMap <$> traverse (\(k,v) -> (,) <$> fromTerm k <*> fromTerm v) pairs
    fromTerm (TMapI pairs) = fromTerm (TMap pairs)
    fromTerm (TTagged n value)
      | n >= 121 && n <= 127 = C.ScriptDataConstructor (fromIntegral n-121) <$> (CBOR.list value >>= traverse fromTerm)
      | n >= 1280 && n <= 1400 = C.ScriptDataConstructor (fromIntegral n-1280+7) <$> (CBOR.list value >>= traverse fromTerm)
      | n == 102 = do
          parts <- CBOR.list value
          case parts of
            [index,fields] -> do
              i <- CBOR.integer index
              if i < 0 || i > 18446744073709551615 then fail "Constructor index is outside uint64" else C.ScriptDataConstructor i <$> (CBOR.list fields >>= traverse fromTerm)
            _ -> fail "Constructor 102 must contain an index and fields"
      | n == 2 || n == 3 = do
          bytes <- CBOR.bytes value
          let integer = BS.foldl' (\acc byte -> acc * 256 + fromIntegral byte) 0 bytes
          pure (C.ScriptDataNumber (if n == 2 then integer else -1-integer))
    fromTerm _ = fail "CBOR value is not Plutus data"

-- Resolve keys against the original values before recursively converting them.
-- Nested duplicate maps can otherwise make distinct compound keys appear equal.
decoded :: C.ScriptData -> C.ScriptData
decoded (C.ScriptDataConstructor index fields) = C.ScriptDataConstructor index (map decoded fields)
decoded (C.ScriptDataList values) = C.ScriptDataList (map decoded values)
decoded (C.ScriptDataMap values) = C.ScriptDataMap [(decoded key,decoded (maybe value id (lookup key values))) | (key,value) <- values]
decoded value = value

-- Compatibility with the former WASM decoder is confined to public Data.from:
-- it accepts early container breaks, ignores tag-102's declared outer length,
-- and reads definite byte lengths through a 32-bit WASM usize.
decodeLegacy :: BS.ByteString -> Either String C.ScriptData
decodeLegacy input = evalStateT datum 0
  where
    bad message = lift (Left message)
    byte = do
      offset <- get
      if offset >= BS.length input then bad "Truncated Plutus data" else do
        put (offset+1)
        pure (BS.index input offset)
    breakHere = do
      offset <- get
      if offset >= BS.length input then bad "Truncated Plutus data"
      else if BS.index input offset == 255 then put (offset+1) >> pure True else pure False
    argument :: Word8 -> StateT Int (Either String) Integer
    argument info
      | info < 24 = pure (fromIntegral info)
      | info >= 24 && info <= 27 = number (2 ^ (fromIntegral info-24 :: Int)) 0
      | otherwise = bad "Invalid CBOR head"
    number 0 value = pure value
    number count value = byte >>= \next -> number (count-1) (value*256+fromIntegral next)
    size :: Word8 -> StateT Int (Either String) Integer
    size info = (.&. 4294967295) <$> argument info
    header = do value <- byte; pure (value `shiftR` 5,value .&. 31)
    chunk truncateLength info = do
      length <- (if truncateLength then size else argument) info
      if length > 64 then bad "Plutus byte chunk exceeds 64 bytes" else do
        let count = fromInteger length
        offset <- get
        if count > BS.length input-offset then bad "Truncated Plutus bytes" else do
          put (offset+count)
          pure (BS.take count (BS.drop offset input))
    bytes 31 = chunks
    bytes info = chunk True info
    chunks = do
      done <- breakHere
      if done then pure BS.empty else do
        (major,info) <- header
        if major /= 2 || info == 31 then bad "Invalid Plutus byte chunk" else (<>) <$> chunk False info <*> chunks
    sequenceItems count item = case count of
      Just 0 -> pure []
      _ -> do
        done <- breakHere
        if done then pure [] else (:) <$> item <*> sequenceItems (subtract 1 <$> count) item
    count 31 = pure Nothing
    count info = Just <$> argument info
    list = do
      (major,info) <- header
      if major /= 4 then bad "Expected Plutus fields" else count info >>= flip sequenceItems datum
    general = do
      (major,info) <- header
      if major /= 4 then bad "Expected constructor tuple" else pure ()
      if info == 31 then pure () else do
        length <- argument info
        if length < 2 then bad "Constructor tuple is too short" else pure ()
      (indexMajor,indexInfo) <- header
      if indexMajor /= 0 then bad "Invalid constructor index" else pure ()
      index <- argument indexInfo
      fields <- list
      if info == 31 then breakHere >>= \done -> if done then pure () else bad "Missing constructor break" else pure ()
      pure (C.ScriptDataConstructor index fields)
    datum = do
      (major,info) <- header
      case major of
        0 -> C.ScriptDataNumber <$> argument info
        1 -> C.ScriptDataNumber . (-1-) <$> argument info
        2 -> C.ScriptDataBytes <$> bytes info
        4 -> C.ScriptDataList <$> (count info >>= flip sequenceItems datum)
        5 -> C.ScriptDataMap <$> (count info >>= flip sequenceItems ((,) <$> datum <*> datum))
        6 -> do
          tag <- argument info
          if tag == 102 then general
          else if tag >= 121 && tag <= 127 then C.ScriptDataConstructor (tag-121) <$> list
          else if tag >= 1280 && tag <= 1400 then C.ScriptDataConstructor (tag-1280+7) <$> list
          else if tag == 2 || tag == 3 then do
            (bytesMajor,bytesInfo) <- header
            if bytesMajor /= 2 then bad "Bignum payload must be bytes" else pure ()
            payload <- bytes bytesInfo
            let value = BS.foldl' (\acc next -> acc*256+fromIntegral next) 0 payload
            pure (C.ScriptDataNumber (if tag == 2 then value else -1-value))
          else bad "Invalid Plutus constructor tag"
        _ -> bad "CBOR value is not Plutus data"
