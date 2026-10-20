{-# LANGUAGE DataKinds #-}
{-# LANGUAGE GADTs #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}
{-# LANGUAGE TypeApplications #-}
module Ledger (ledgerRequest) where

import Cardano.Api qualified as C
import Cardano.Api.Tx (toShelleyTxOut, fromShelleyTxOut)
import Cardano.Api.Ledger qualified as L
import Cardano.Ledger.Api qualified as L
import Cardano.Ledger.Core qualified as L
import Cardano.Ledger.Babbage.Core qualified as L
import Cardano.Ledger.Conway qualified as Era
import Data.Foldable (toList)
import Cardano.Binary qualified as CB
import Cardano.Ledger.Binary qualified as LB
import Cardano.Ledger.Alonzo.TxWits qualified as Wits
import Cardano.Ledger.Alonzo.Scripts (AsIx(..))
import Cardano.Ledger.Conway.Scripts qualified as Purpose
import Cardano.Ledger.Conway.UTxO qualified as ConwayUTxO
import Cardano.Ledger.State qualified as UTxO
import Cardano.Ledger.Keys (coerceKeyRole)
import Codec.CBOR.Term
import Control.Lens ((&), (%~), (^.), (.~))
import Control.Monad (forM, unless)
import Convex.MockChain.Defaults qualified as Defaults
import Convex.PlutusTx qualified as Plutus
import Crypto.Hash (Blake2b_224, Blake2b_256, Digest, hash)
import Crypto.PubKey.Ed25519 qualified as Ed
import Data.Aeson hiding (encode, decode)
import Data.Aeson.Types (Parser, parseEither)
import Data.Aeson.Key qualified as Key
import Data.Aeson.KeyMap qualified as KM
import Data.ByteArray (convert)
import Data.ByteString qualified as BS
import Data.ByteString.Lazy qualified as BL
import Data.ByteString.Short qualified as SBS
import Data.Map.Strict qualified as Map
import Data.Set qualified as Set
import Data.Text (Text)
import Data.Text qualified as T
import Ledger.Cbor qualified as CBOR
import Ledger.Data qualified as Datum
import Ledger.Address qualified as Address
import Ledger.Canonical qualified as Canonical
import Ledger.Keys qualified as Keys
import LiveTx qualified as B

ledgerRequest :: Value -> IO Value
ledgerRequest request = do
  let operation = parseEither (withObject "ledger request" (.: "operation")) request :: Either String Text
  result <- case operation of
    Right "key.generate" -> do
      bytes <- Keys.generate
      pure (Right (String (Keys.bech32 "ed25519_sk" bytes)))
    _ -> pure (parseEither (withObject "ledger request" run) request)
  pure $ either (\e -> object ["ok" .= False,"error" .= e]) (\v -> object ["ok" .= True,"result" .= v]) result

run :: Object -> Parser Value
run o = do
  op <- o .: "operation" :: Parser Text
  case op of
    "cbor.encode" -> do
      term <- o .: "value" >>= CBOR.parseTerm
      canonical <- o .:? "canonical" .!= False
      pure (String (B.hexText (CBOR.encode ((if canonical then CBOR.canonical else id) term))))
    "cbor.encodingLevel" -> do
      text <- o .: "cbor"
      let parsed bytes = if bytes == BS.singleton 255 then Just TNull else case parseEither (const (CBOR.decodeLenient bytes)) Null of
            Right term | compatible term -> Just term
            _ -> Nothing
          compatible (TBytesI _) = False
          compatible (TStringI _) = False
          compatible (TSimple n) = n == 23
          compatible (TList xs) = all compatible xs
          compatible (TListI xs) = all compatible xs
          compatible (TMap xs) = all (\(k,v) -> compatible k && compatible v) xs
          compatible (TMapI xs) = all (\(k,v) -> compatible k && compatible v) xs
          compatible (TTagged _ value) = compatible value
          compatible _ = True
      pure $ toJSON $ case parseEither (const (B.hexBytes text)) Null of
        Left _ -> 0 :: Int
        Right bytes -> case parsed bytes of
          Nothing -> 0
          Just (TBytes inner) -> maybe 1 (const 2) (parsed inner)
          Just _ -> 1
    "cbor.decode" -> CBOR.termJSON <$> (o .: "cbor" >>= B.hexBytes >>= CBOR.decode)
    "cbor.canonical" -> String . B.hexText . CBOR.encode . CBOR.canonical <$> (o .: "cbor" >>= B.hexBytes >>= CBOR.decode)
    "hash.blake2b" -> do
      bytes <- o .: "hex" >>= B.hexBytes
      size <- o .:? "size" .!= (32 :: Int)
      case size of
        28 -> pure (String (B.hexText (convert (hash bytes :: Digest Blake2b_224))))
        32 -> pure (String (B.hexText (convert (hash bytes :: Digest Blake2b_256))))
        _ -> fail "Supported Blake2b digest lengths are 28 and 32"
    "data.encode" -> do
      value <- o .: "data" >>= Datum.numericData
      datum <- B.eitherP (C.scriptDataFromJson C.ScriptDataJsonDetailedSchema value)
      canonical <- o .:? "canonical" .!= False
      pure (String (B.hexText (Datum.encodeData canonical (C.getScriptData datum))))
    "data.decode" -> do
      bytes <- o .: "cbor" >>= B.hexBytes
      datum <- Datum.decodeData bytes
      pure (C.scriptDataToJson C.ScriptDataJsonDetailedSchema (C.unsafeHashableScriptData datum))
    "data.hash" -> String . C.serialiseToRawBytesHexText . C.hashScriptDataBytes <$> (o .: "cbor" >>= B.cbor C.AsHashableScriptData)
    "address.inspect" -> o .: "address" >>= Address.inspect
    "address.fromCredentials" -> String <$> Address.fromCredentials o
    "key.fromSeed" -> Keys.fromSeed o
    "key.fromPrivate" -> do
      key <- o .: "privateKey" >>= Keys.private
      let public = Keys.public key
      pure $ object ["publicKey" .= Keys.bech32 "ed25519_pk" public,"publicKeyHex" .= B.hexText public,"keyHash" .= Keys.keyHash public]
    "key.hash" -> do
      value <- o .: "publicKey"
      bytes <- publicBytes value
      pure (String (Keys.keyHash bytes))
    "key.sign" -> do
      key <- o .: "privateKey" >>= Keys.private
      message <- o .: "message" >>= B.hexBytes
      pure (String (B.hexText (Keys.sign key message)))
    "key.verify" -> do
      key <- o .: "publicKey" >>= publicBytes >>= Keys.crypto . Ed.publicKey
      message <- o .: "message" >>= B.hexBytes
      signature <- o .: "signature" >>= B.hexBytes >>= Keys.crypto . Ed.signature
      pure (Bool (Ed.verify key message signature))
    "native.encode" -> do
      script <- o .: "script" >>= nativeJSON >>= parseJSON
      pure (String (B.hexText (C.serialiseToCBOR (C.SimpleScript script))))
    "script.hash" -> do
      kind <- o .: "type" :: Parser Text
      text <- o .: "script"
      if kind == "Native" then do
        hash <- B.nativeLedgerHash text
        pure (String (C.serialiseToRawBytesHexText hash))
      else do
        bytes <- B.hexBytes text
        wrapped <- CBOR.decode bytes >>= CBOR.bytes
        let script :: C.PlutusScript lang
            script = C.PlutusScriptSerialised (SBS.toShort wrapped)
        hash <- case kind of
          "PlutusV1" -> pure (C.hashScript (C.PlutusScript C.PlutusScriptV1 script))
          "PlutusV2" -> pure (C.hashScript (C.PlutusScript C.PlutusScriptV2 script))
          "PlutusV3" -> pure (C.hashScript (C.PlutusScript C.PlutusScriptV3 script))
          _ -> fail "Unknown Plutus script language"
        pure (String (C.serialiseToRawBytesHexText hash))
    "script.applyParams" -> do
      script <- o .: "script" >>= B.cbor (C.AsPlutusScript C.AsPlutusScriptV3)
      params <- o .: "params" >>= traverse (fmap (C.toPlutusData . C.getScriptData) . B.cbor C.AsHashableScriptData)
      applied <- B.eitherP (Plutus.applyParams script params)
      pure (String (B.hexText (C.serialiseToCBOR applied)))
    "output.encode" -> do
      value <- o .: "utxo"
      output <- domainOutputDescription value >>= B.outputLedger
      pure (String (B.hexText (LB.serialize' (LB.natVersion @10) output)))
    "output.decode" -> ledgerOutputJSON <$> (o .: "cbor" >>= decodeLedgerOutput)
    "output.minAda" -> do
      output <- o .:? "cbor" >>= maybe (o .: "output" >>= domainOutputDescription >>= B.outputLedger) decodeLedgerOutput
      cost <- o .: "coinsPerUtxoByte" >>= B.integerP
      unless (cost >= 0) (fail "coinsPerUtxoByte cannot be negative")
      let full = B.mergeJSON (object ["utxoCostPerByte" .= cost]) (toJSON (C.unLedgerProtocolParameters Defaults.bundledProtocolParameters))
      params <- parseJSON full
      pure (String (T.pack (show (C.unCoin (L.getMinCoinTxOut params output)))))
    "tx.inspect" -> do
      tx <- transaction o
      inspectTransaction tx
    "tx.hash" -> String . C.serialiseToRawBytesHexText . C.getTxId . C.getTxBody <$> transaction o
    "tx.minFee" -> do
      tx <- transaction o
      parameters <- o .: "protocolParameters" >>= parseJSON . B.protocolJSON
      utxos <- o .: "utxos" >>= traverse B.resolvedLedgerOutput
      let C.ShelleyTx _ ledger = tx
          fee = UTxO.getMinFeeTxUtxo parameters ledger (UTxO.UTxO (Map.fromList utxos))
      pure (String (T.pack (show (C.unCoin fee))))
    "tx.sign" -> do
      tx <- transaction o
      keys <- o .: "privateKeys" >>= traverse (Keys.private >=> Keys.witnessKey)
      let body = C.getTxBody tx
          witnesses = map (C.makeShelleyKeyWitness C.ShelleyBasedEraConway body) keys
          C.ShelleyTx _ ledger = C.makeSignedTransaction witnesses body
          keyWitnesses = ledger ^. L.witsTxL
            & L.scriptTxWitsL .~ mempty
            & L.datsTxWitsL .~ mempty
            & L.rdmrsTxWitsL .~ mempty
            & L.bootAddrTxWitsL .~ mempty
      pure (String (B.hexText (LB.serialize' (LB.natVersion @10) keyWitnesses)))
    "tx.mergeWitnesses" -> do
      tx@(C.ShelleyTx C.ShelleyBasedEraConway ledger) <- transaction o
      witnesses <- o .: "witnessSets" >>= traverse (\text -> do
        bytes <- B.hexBytes text
        B.eitherP (LB.decodeFullAnnotator (LB.natVersion @10) "CIP-30 witnesses" LB.decCBOR (BL.fromStrict bytes)))
      -- Ledger's witness Semigroup reconstructs redeemers in the current map
      -- format. Restore committed memo bytes when adding signatures, otherwise
      -- a legacy array transaction's script integrity hash becomes invalid.
      let original = ledger ^. L.witsTxL
          combined = original <> mconcat witnesses
          redeemers = original ^. L.rdmrsTxWitsL
          datums = original ^. L.datsTxWitsL
          preserved = combined
            & L.rdmrsTxWitsL .~ (if Map.null (Wits.unRedeemers redeemers) then combined ^. L.rdmrsTxWitsL else redeemers)
            & L.datsTxWitsL .~ (if Map.null (Wits.unTxDats datums) then combined ^. L.datsTxWitsL else datums)
          merged = C.ShelleyTx C.ShelleyBasedEraConway (ledger & L.witsTxL .~ preserved)
      pure (String (B.hexText (C.serialiseToCBOR merged)))
    "tx.canonical" -> do
      original <- o .: "cbor" >>= B.hexBytes
      term <- CBOR.decodePreserving original
      isSigned <- Canonical.signed term
      result <- if isSigned then pure original else Canonical.transaction original
      pure (String (B.hexText result))
    "tx.requiredKeys" -> requiredKeys o
    _ -> fail ("Unknown ledger operation: " <> T.unpack op)
  where (>=>) f g x = f x >>= g

publicBytes :: Text -> Parser BS.ByteString
publicBytes value = if T.length value == 64 then B.hexBytes value else Keys.unbech32 value

traverseWithKeys :: Applicative f => (Key.Key -> a -> f b) -> KM.KeyMap a -> f (KM.KeyMap b)
traverseWithKeys f = fmap KM.fromList . traverse (\(k,v) -> (,) k <$> f k v) . KM.toList

nativeJSON :: Value -> Parser Value
nativeJSON (Object o) = Object <$> traverseWithKeys field o
  where field key (String value) | key == "slot" || key == "required" = Number . fromInteger <$> B.integerP (String value)
        field _ value = nativeJSON value
nativeJSON (Array values) = Array <$> traverse nativeJSON values
nativeJSON value = pure value

scriptObject :: Object -> Parser Value
scriptObject o = do
  kind <- o .: "type" :: Parser Text
  cbor <- o .: "script" :: Parser Text
  pure (object ["language" .= kind, (if kind == "Native" then "nativeScriptCbor" else "scriptCbor") .= cbor])

scriptHash :: C.ScriptInAnyLang -> Text
scriptHash (C.ScriptInAnyLang _ script) = C.serialiseToRawBytesHexText (C.hashScript script)

scriptJSON :: C.ScriptInAnyLang -> Value
scriptJSON (C.ScriptInAnyLang _ script) = case script of
  C.SimpleScript value -> item "Native" (C.SimpleScript value)
  C.PlutusScript C.PlutusScriptV1 value -> item "PlutusV1" (C.PlutusScript C.PlutusScriptV1 value)
  C.PlutusScript C.PlutusScriptV2 value -> item "PlutusV2" (C.PlutusScript C.PlutusScriptV2 value)
  C.PlutusScript C.PlutusScriptV3 value -> item "PlutusV3" (C.PlutusScript C.PlutusScriptV3 value)
  C.PlutusScript C.PlutusScriptV4 value -> item "PlutusV4" (C.PlutusScript C.PlutusScriptV4 value)
  where item :: C.IsScriptLanguage lang => Text -> C.Script lang -> Value
        item kind value =
          let bytes = C.serialiseToCBOR value
              encoded = if kind == "Native" then bytes else CBOR.encode (TBytes bytes)
          in object ["type" .= kind,"script" .= B.hexText encoded]

-- Ledger CBOR owns the output representation, including datum and reference script encodings.
domainOutput :: Value -> Parser (C.TxOut C.CtxTx B.Era)
domainOutput value = domainOutputDescription value >>= B.output

domainOutputDescription :: Value -> Parser Value
domainOutputDescription = withObject "Lucid output" $ \o -> do
  address <- o .: "address" :: Parser Text
  assets <- o .: "assets" :: Parser Object
  amounts <- traverse (\(key,value) -> do
    n <- B.integerP value
    let unit = Key.toText key
    if unit == "lovelace" then pure Nothing else pure (Just (object ["policyId" .= T.take 56 unit,"assetName" .= T.drop 56 unit,"quantity" .= show n]))) (KM.toList assets)
  lovelace <- maybe (pure 0) B.integerP (KM.lookup "lovelace" assets)
  datum <- o .:? "datum" :: Parser (Maybe Text)
  datumHash <- o .:? "datumHash" :: Parser (Maybe Text)
  reference <- o .:? "scriptRef" >>= traverse (withObject "script reference" scriptObject)
  let mode = case (datumHash,datum) of (Just _,_) -> "hash" :: Text; (_,Just _) -> "inline"; _ -> "none"
      fields = ["address" .= address,"lovelace" .= show lovelace,"assets" .= [v | Just v <- amounts],"datumMode" .= mode]
        <> maybe [] (\v -> ["datumHash" .= v]) datumHash <> maybe [] (\v -> ["datumCbor" .= v]) datum <> maybe [] (\v -> ["referenceScript" .= v]) reference
  pure (object fields)

outputBytes :: C.TxOut C.CtxTx B.Era -> BS.ByteString
outputBytes = LB.serialize' (LB.natVersion @10) . toShelleyTxOut C.ShelleyBasedEraConway . C.toCtxUTxOTxOut

decodeOutput :: Text -> Parser (C.TxOut C.CtxTx B.Era)
decodeOutput text = B.hexBytes text >>= B.eitherP . CB.decodeFull'

decodeLedgerOutput :: Text -> Parser (L.TxOut Era.ConwayEra)
decodeLedgerOutput text = B.hexBytes text >>= B.eitherP . LB.decodeFull' (LB.natVersion @10)

ledgerOutputJSON :: L.TxOut Era.ConwayEra -> Value
ledgerOutputJSON output =
  let base = domainOutputJSON (fromShelleyTxOut C.ShelleyBasedEraConway output)
      native = [script | reference <- toList (output ^. L.referenceScriptTxOutL), Just script <- [L.getNativeScript reference]]
  in case (base,native) of
    (Object fields,script:_) -> Object (KM.insert "scriptRef" (object ["type" .= ("Native" :: Text),"script" .= B.hexText (LB.serialize' (LB.natVersion @10) script)]) fields)
    _ -> base

domainOutputJSON :: C.TxOut ctx B.Era -> Value
domainOutputJSON (C.TxOut address value datum script) = object $
  ["address" .= C.serialiseAddress address,"assets" .= Object (KM.fromList (("lovelace",String (T.pack (show (C.unCoin (C.txOutValueToLovelace value))))) : assets))]
  <> case datum of
      C.TxOutDatumNone -> ref
      C.TxOutDatumHash _ hash -> ["datumHash" .= C.serialiseToRawBytesHexText hash] <> ref
      C.TxOutDatumInline _ d -> ["datum" .= B.hexText (C.serialiseToCBOR d)] <> ref
      C.TxOutSupplementalDatum _ d -> ["datum" .= B.hexText (C.serialiseToCBOR d),"datumHash" .= C.serialiseToRawBytesHexText (C.hashScriptDataBytes d)] <> ref
  where assets = [(Key.fromText (C.serialiseToRawBytesHexText policy <> C.serialiseToRawBytesHexText name),String (T.pack (show quantity))) | (C.AssetId policy name,C.Quantity quantity) <- C.valueToList (C.txOutValueToValue value)]
        ref = case script of C.ReferenceScriptNone -> []; C.ReferenceScript _ s -> ["scriptRef" .= scriptJSON s]

transaction :: Object -> Parser (C.Tx B.Era)
transaction o = o .: "cbor" >>= B.cbor (C.AsTx C.AsConwayEra)

inspectTransaction :: C.Tx B.Era -> Parser Value
inspectTransaction tx@(C.ShelleyTx C.ShelleyBasedEraConway ledger) = do
  let body = C.getTxBodyContent (C.getTxBody tx)
      base = case B.inspect tx of Object o -> o; _ -> mempty
      bodyBytes = LB.serialize' (LB.natVersion @10) (ledger ^. L.bodyTxL)
      collateral = case toList (ledger ^. L.bodyTxL . L.collateralReturnTxBodyL) of out:_ -> ledgerOutputJSON out; _ -> Null
  pure (Object (KM.union (KM.fromList [
    ("bodyCbor",String (B.hexText bodyBytes)),
    ("lucidOutputs",toJSON (map ledgerOutputJSON (toList (ledger ^. L.bodyTxL . L.outputsTxBodyL)))),
    ("lucidCollateralReturn",collateral),
    ("datums",toJSON [object ["hash" .= C.serialiseToRawBytesHexText (C.hashScriptDataBytes (C.fromAlonzoData datum)),"cbor" .= B.hexText (C.serialiseToCBOR (C.fromAlonzoData datum))] | datum <- Map.elems (Wits.unTxDats (ledger ^. L.witsTxL . L.datsTxWitsL))]),
    ("redeemers",toJSON [redeemerJSON purpose datum units | (purpose,(datum,units)) <- Map.toList (Wits.unRedeemers (ledger ^. L.witsTxL . L.rdmrsTxWitsL))])]) base))
  where redeemerJSON purpose datum units =
          let (tag,index) = case purpose of
                Purpose.ConwaySpending (AsIx index) -> ("spend" :: Text,index)
                Purpose.ConwayMinting (AsIx index) -> ("mint",index)
                Purpose.ConwayCertifying (AsIx index) -> ("publish",index)
                Purpose.ConwayRewarding (AsIx index) -> ("withdraw",index)
                Purpose.ConwayVoting (AsIx index) -> ("vote",index)
                Purpose.ConwayProposing (AsIx index) -> ("propose",index)
              execution = C.fromAlonzoExUnits units
          in object ["tag" .= tag,"index" .= show index,"data" .= B.hexText (C.serialiseToCBOR (C.fromAlonzoData datum)),"exUnits" .= object ["mem" .= show (C.executionMemory execution),"steps" .= show (C.executionSteps execution)]]

requiredKeys :: Object -> Parser Value
requiredKeys o = do
  tx <- transaction o
  utxos <- o .: "utxos" :: Parser [Value]
  let body = C.getTxBodyContent (C.getTxBody tx)
      inputs = Set.fromList (map fst (C.txIns body) <> case C.txInsCollateral body of C.TxInsCollateral _ xs -> xs; _ -> [])
      signers = case C.txExtraKeyWits body of C.TxExtraKeyWitnesses _ xs -> map C.serialiseToRawBytesHexText xs; _ -> []
      withdrawalKeys = case C.txWithdrawals body of C.TxWithdrawalsNone -> []; C.TxWithdrawals _ xs -> [C.serialiseToRawBytesHexText key | (address,_,_) <- xs,C.StakeCredentialByKey key <- [C.stakeAddressCredential address]]
  inputKeys <- fmap concat $ forM utxos $ withObject "UTxO" $ \utxo -> do
    txHash <- utxo .: "txHash"
    index <- utxo .: "outputIndex" >>= B.integerP
    input <- B.input (txHash <> "#" <> T.pack (show index))
    if Set.member input inputs then do
      details <- utxo .: "address" >>= Address.inspect
      withObject "address details" (\details -> details .:? "paymentCredential" >>= maybe (pure []) (withObject "credential" $ \c -> do
        kind <- c .: "type" :: Parser Text
        if kind == "Key" then (:[]) <$> c .: "hash" else pure [])) details
    else pure []
  raw <- CBOR.decode (C.serialiseToCBOR tx)
  parts <- CBOR.list raw
  extra <- case parts of
    bodyTerm:witnessTerm:_ -> do
      natives <- CBOR.field 1 witnessTerm
      pure (concatMap byteHashes [v | Just v <- [natives]])
    _ -> pure []
  let C.ShelleyTx C.ShelleyBasedEraConway ledger = tx
      authors = ConwayUTxO.getConwayWitsVKeyNeeded (UTxO.UTxO mempty) (ledger ^. L.bodyTxL)
      authorHashes = [C.serialiseToRawBytesHexText (C.PaymentKeyHash (coerceKeyRole key)) | key <- Set.toList authors]
  pure (toJSON (Set.toList (Set.fromList (authorHashes <> signers <> withdrawalKeys <> inputKeys <> extra))))
  where byteHashes (TBytes bytes) | BS.length bytes == 28 = [B.hexText bytes]
        byteHashes (TList xs) = concatMap byteHashes xs
        byteHashes (TListI xs) = concatMap byteHashes xs
        byteHashes (TMap xs) = concat [byteHashes k <> byteHashes v | (k,v) <- xs]
        byteHashes (TMapI xs) = concat [byteHashes k <> byteHashes v | (k,v) <- xs]
        byteHashes (TTagged _ term) = byteHashes term
        byteHashes _ = []
