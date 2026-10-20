{-# LANGUAGE OverloadedStrings #-}
module Ledger.Cbor where

import Control.Applicative ((<|>))
import Codec.CBOR.Term
import Codec.CBOR.Decoding qualified as D
import Control.Monad (replicateM)
import Codec.CBOR.Read (deserialiseFromBytes)
import Codec.CBOR.Write (toStrictByteString)
import Data.Aeson hiding (encode, decode, pairs)
import Data.Aeson.Types (Parser)
import Data.Aeson.KeyMap qualified as KM
import Data.ByteString qualified as BS
import Data.ByteString.Lazy qualified as BL
import Data.Text qualified as T
import Data.Text.Lazy qualified as TL
import Data.List (sortOn)
import LiveTx qualified as B

encode :: Term -> BS.ByteString
encode = toStrictByteString . encodeTerm

decode :: BS.ByteString -> Parser Term
decode bytes = do
  (remaining, value) <- B.eitherP (deserialiseFromBytes decodeCompatible (BL.fromStrict bytes))
  if BL.null remaining then pure value else fail "Trailing CBOR bytes"

decodeCompatible :: D.Decoder s Term
decodeCompatible = decodeTermWith False False

decodeLenient :: BS.ByteString -> Parser Term
decodeLenient bytes = do
  (remaining,value) <- B.eitherP (deserialiseFromBytes (decodeTermWith True False) (BL.fromStrict bytes))
  if BL.null remaining then pure value else fail "Trailing CBOR bytes"

decodePreserving :: BS.ByteString -> Parser Term
decodePreserving bytes = do
  (remaining,value) <- B.eitherP (deserialiseFromBytes (decodeTermWith False True) (BL.fromStrict bytes))
  if BL.null remaining then pure value else fail "Trailing CBOR bytes"

decodeTermWith :: Bool -> Bool -> D.Decoder s Term
decodeTermWith lenient preserveInteger = do
  token <- D.peekTokenType
  case token of
    D.TypeString | lenient -> D.decodeUtf8ByteArray >> pure (TString "")
    D.TypeInteger -> do
      tag <- D.decodeTag64
      value <- recurse
      raw <- case value of TBytes bytes -> pure bytes; TBytesI bytes -> pure (BL.toStrict bytes); _ -> fail "Bignum payload must be bytes"
      let number = BS.foldl' (\acc byte -> acc * 256 + fromIntegral byte) 0 raw
      pure (if preserveInteger then TTagged tag value else TInteger (if tag == 2 then number else -1-number))
    D.TypeListLen -> TList <$> (D.decodeListLen >>= flip replicateM recurse)
    D.TypeListLen64 -> TList <$> (D.decodeListLen >>= flip replicateM recurse)
    D.TypeListLenIndef -> D.decodeListLenIndef >> TListI <$> indefinite recurse
    D.TypeMapLen -> TMap <$> (D.decodeMapLen >>= flip replicateM pair)
    D.TypeMapLen64 -> TMap <$> (D.decodeMapLen >>= flip replicateM pair)
    D.TypeMapLenIndef -> D.decodeMapLenIndef >> TMapI <$> indefinite pair
    D.TypeTag -> TTagged <$> D.decodeTag64 <*> recurse
    D.TypeTag64 -> TTagged <$> D.decodeTag64 <*> recurse
    _ -> decodeTerm
  where recurse = decodeTermWith lenient preserveInteger
        pair = (,) <$> recurse <*> recurse
        indefinite item = do
          done <- D.decodeBreakOr
          if done then pure [] else (:) <$> item <*> indefinite item

termJSON :: Term -> Value
termJSON term = case term of
  TInt n -> object ["int" .= show n]
  TInteger n -> object ["int" .= show n]
  TBytes b -> object ["bytes" .= B.hexText b]
  TBytesI b -> termJSON (TBytes (BL.toStrict b))
  TString t -> object ["text" .= t]
  TStringI t -> termJSON (TString (TL.toStrict t))
  TList ts -> object ["list" .= map termJSON ts]
  TListI ts -> object ["list" .= map termJSON ts, "indefinite" .= True]
  TMap pairs -> object ["map" .= map (\(k,v) -> [termJSON k,termJSON v]) pairs]
  TMapI pairs -> object ["map" .= map (\(k,v) -> [termJSON k,termJSON v]) pairs,"indefinite" .= True]
  TTagged tag value -> object ["tag" .= show tag,"value" .= termJSON value]
  TBool b -> Bool b
  TNull -> Null
  TSimple n -> object ["simple" .= n]
  THalf n -> object ["float" .= n]
  TFloat n -> object ["float" .= n]
  TDouble n -> object ["float" .= n]

parseTerm :: Value -> Parser Term
parseTerm Null = pure TNull
parseTerm (Bool b) = pure (TBool b)
parseTerm value = withObject "CBOR term" (\o -> case () of
  _ | KM.member "int" o -> TInteger <$> (o .: "int" >>= B.integerP)
    | KM.member "bytes" o -> TBytes <$> (o .: "bytes" >>= B.hexBytes)
    | KM.member "text" o -> TString <$> o .: "text"
    | KM.member "list" o -> do
        values <- o .: "list" >>= traverse parseTerm
        indefinite <- o .:? "indefinite" .!= False
        pure ((if indefinite then TListI else TList) values)
    | KM.member "map" o -> do
        values <- o .: "map" >>= traverse (\xs -> case xs of [k,v] -> (,) <$> parseTerm k <*> parseTerm v; _ -> fail "A CBOR map entry must have two terms")
        indefinite <- o .:? "indefinite" .!= False
        pure ((if indefinite then TMapI else TMap) values)
    | KM.member "tag" o -> do
        tag <- o .: "tag" >>= B.integerP
        if tag < 0 || tag > 18446744073709551615 then fail "CBOR tag is outside uint64" else TTagged (fromInteger tag) <$> (o .: "value" >>= parseTerm)
    | KM.member "float" o -> TDouble <$> o .: "float"
    | KM.member "simple" o -> TSimple <$> o .: "simple"
    | otherwise -> fail "Invalid CBOR term") value

canonical :: Term -> Term
canonical (TListI ts) = TList (map canonical ts)
canonical (TList ts) = TList (map canonical ts)
canonical (TMapI ps) = canonical (TMap ps)
canonical (TMap ps) = TMap (sortOn (\(key,_) -> let bytes=encode key in (BS.length bytes,bytes)) [(canonical k,canonical v) | (k,v) <- ps])
canonical (TBytesI b) = TBytes (BL.toStrict b)
canonical (TStringI t) = TString (TL.toStrict t)
canonical (TTagged n t) = TTagged n (canonical t)
canonical t = t

list :: Term -> Parser [Term]
list (TList xs) = pure xs
list (TListI xs) = pure xs
list (TTagged 258 t) = list t
list _ = fail "Expected CBOR list"

pairs :: Term -> Parser [(Term,Term)]
pairs (TMap ps) = pure ps
pairs (TMapI ps) = pure ps
pairs _ = fail "Expected CBOR map"

integer :: Term -> Parser Integer
integer (TInt n) = pure (fromIntegral n)
integer (TInteger n) = pure n
integer _ = fail "Expected CBOR integer"

bytes :: Term -> Parser BS.ByteString
bytes (TBytes b) = pure b
bytes (TBytesI b) = pure (BL.toStrict b)
bytes _ = fail "Expected CBOR bytes"

field :: Integer -> Term -> Parser (Maybe Term)
field key term = do
  ps <- pairs term
  pure (lookup (TInt (fromInteger key)) ps <|> lookup (TInteger key) ps)
