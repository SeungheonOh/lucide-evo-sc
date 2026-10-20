{-# LANGUAGE DataKinds #-}
{-# LANGUAGE FlexibleContexts #-}
{-# LANGUAGE FlexibleInstances #-}
{-# LANGUAGE GADTs #-}
{-# LANGUAGE GeneralizedNewtypeDeriving #-}
{-# LANGUAGE LambdaCase #-}
{-# LANGUAGE MultiParamTypeClasses #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}
{-# LANGUAGE TypeApplications #-}
module LiveTx where

import Cardano.Api qualified as C
import Cardano.Api.Experimental qualified as E
import Cardano.Api.Ledger qualified as L
import Cardano.Ledger.Core (ppKeyDepositL)
import Cardano.Ledger.Core qualified as L
import Cardano.Ledger.Babbage.Core qualified as L
import Cardano.Api.Tx (toShelleyTxOut, fromShelleyTxIn)
import Cardano.Ledger.TxIn qualified as TxIn
import Cardano.Ledger.Conway qualified as Era
import Cardano.Ledger.State qualified as LedgerState
import Cardano.Ledger.Address (getNetwork)
import Data.Scientific (Scientific)
import Cardano.Binary qualified as CB
import Cardano.Ledger.Binary qualified as LB
import Cardano.Slotting.Time (SystemStart(..), RelativeTime(..), mkSlotLength)
import Control.Exception (SomeException, displayException, try, evaluate)
import Control.Lens ((&), (%~), (^.))
import Control.Monad (unless, when, forM, forM_)
import Control.Monad.Except
import Control.Monad.Reader
import Control.Tracer (Tracer(..))
import Convex.BuildTx qualified as B
import Convex.Class (MonadBlockchain(..))
import Convex.CoinSelection qualified as CS
import Convex.Utxos (UtxoSet(..))
import Data.Aeson hiding (Error)
import Data.Aeson.Types (Parser, parseEither)
import Data.Aeson.KeyMap qualified as KM
import Data.ByteString qualified as BS
import Data.ByteString.Base16 qualified as Hex
import Data.ByteString.Lazy qualified as BL
import Data.Map.Strict qualified as Map
import Data.Set qualified as Set
import Data.Text (Text)
import Data.Text qualified as T
import Data.Text.Encoding (encodeUtf8, decodeUtf8)
import Data.Time.Clock.POSIX (posixSecondsToUTCTime)
import Data.IORef
import GHC.IsList (toList)
import Data.SOP.NonEmpty (NonEmpty(..))
import Ouroboros.Consensus.HardFork.History qualified as H
import Ouroboros.Consensus.Block.Abstract (GenesisWindow(..))
import Text.Read (readMaybe)
import ExampleScripts (exampleScripts)

mergeJSON (Object a) (Object b) = Object (KM.unionWith mergeJSON a b)
mergeJSON a _ = a

type Era = C.ConwayEra
type Builder = B.TxBuilder Era

eitherP :: Show e => Either e a -> Parser a
eitherP = either (fail . show) pure
hexBytes :: Text -> Parser BS.ByteString
hexBytes t = eitherP (Hex.decode (encodeUtf8 (T.strip t)))
hexText :: BS.ByteString -> Text
hexText = decodeUtf8 . Hex.encode
integerP :: Value -> Parser Integer
integerP (String t) = maybe (fail "Expected an integer string") pure (readMaybe (T.unpack t))
integerP v = parseJSON v
intField o name = o .: name >>= integerP
positive o name = do n <- intField o name; when (n < 0) (fail "Amounts must be nonnegative"); pure n
raw :: C.SerialiseAsRawBytes a => C.AsType a -> Text -> Parser a
raw typ t = hexBytes t >>= eitherP . C.deserialiseFromRawBytes typ
cbor :: C.SerialiseAsCBOR a => C.AsType a -> Text -> Parser a
cbor typ t = hexBytes t >>= eitherP . C.deserialiseFromCBOR typ
address :: Text -> Parser (C.AddressInEra Era)
address t = case C.deserialiseAddress (C.AsAddressInEra C.AsConwayEra) t of
  Just a -> pure a
  Nothing -> do
    a <- raw C.AsAddressAny t
    eitherP (C.anyAddressInEra C.ConwayEra a)
input :: Text -> Parser C.TxIn
input t = case T.splitOn "#" t of
  [tx, ix] -> do
    txid <- raw C.AsTxId tx
    n <- integerP (String ix)
    unless (n >= 0 && n <= 65535) (fail "Output index must be 0–65535")
    pure (C.TxIn txid (C.TxIx (fromInteger n)))
  _ -> fail "Input must be transaction-hash#output-index"
inputText :: C.TxIn -> Text
inputText (C.TxIn txid (C.TxIx n)) = C.serialiseToRawBytesHexText txid <> "#" <> T.pack (show n)
scriptData :: Value -> Parser C.HashableScriptData
scriptData v = rawJSON v >>= eitherP . C.scriptDataFromJson C.ScriptDataJsonDetailedSchema
rawJSON :: Value -> Parser Value
rawJSON (String text) = either fail pure (eitherDecodeStrict (encodeUtf8 text))
rawJSON v = pure v

newtype WalletOutput = WalletOutput (C.TxIn, C.TxOut C.CtxUTxO Era)
instance CB.FromCBOR WalletOutput where
  fromCBOR = do
    CB.decodeListLenOf 2
    CB.decodeListLenOf 2
    bytes <- CB.decodeBytes
    txid <- either (fail . show) pure (C.deserialiseFromRawBytes C.AsTxId bytes)
    index <- CB.decodeWord
    let i = C.TxIn txid (C.TxIx index)
    o <- CB.fromCBOR
    pure (WalletOutput (i,o))
walletOutput :: Text -> Parser (C.TxIn, C.TxOut C.CtxUTxO Era)
walletOutput t = do
  bytes <- hexBytes t
  WalletOutput item <- eitherP (CB.decodeFull' bytes)
  pure item

asset :: Value -> Parser (C.AssetId, C.Quantity)
asset = withObject "asset" $ \o -> do
  policy <- o .: "policyId" >>= raw C.AsPolicyId
  name <- o .: "assetName" >>= raw C.AsAssetName
  qty <- intField o "quantity"
  pure (C.AssetId policy name, C.Quantity qty)
value :: Object -> Parser C.Value
value o = do
  amount <- positive o "lovelace"
  assets <- o .:? "assets" .!= [] >>= traverse asset
  when (any ((< 0) . snd) assets) (fail "Output asset quantities must be nonnegative")
  pure $ C.valueFromList ((C.AdaAssetId, C.Quantity amount):assets)

-- Scripts and redeemers are decoded by Cardano inside WASM. JavaScript never
-- implements a Cardano transaction builder, fee estimator, or script evaluator.
data SomePlutus where
  SomePlutus :: (C.HasScriptLanguageInEra lang Era, C.IsPlutusScriptLanguage lang) => C.PlutusScriptVersion lang -> C.PlutusScript lang -> SomePlutus
plutus :: Object -> Parser SomePlutus
plutus o = do
  lang <- o .: "language" :: Parser Text
  bytes <- o .: "scriptCbor"
  case lang of
    "PlutusV1" -> SomePlutus C.PlutusScriptV1 <$> cbor (C.AsPlutusScript C.AsPlutusScriptV1) bytes
    "PlutusV2" -> SomePlutus C.PlutusScriptV2 <$> cbor (C.AsPlutusScript C.AsPlutusScriptV2) bytes
    "PlutusV3" -> SomePlutus C.PlutusScriptV3 <$> cbor (C.AsPlutusScript C.AsPlutusScriptV3) bytes
    _ -> fail "Choose PlutusV1, PlutusV2, or PlutusV3"
-- Keep native scripts in the ledger's memoized representation when their
-- byte encoding contributes to a policy ID or script address.
nativeLedgerScript :: Text -> Parser (L.Script Era.ConwayEra)
nativeLedgerScript text = do
  bytes <- hexBytes text
  eitherP (LB.decodeFullAnnotator (LB.natVersion @10) "native script" LB.decCBOR (BL.fromStrict (BS.pack [130,0] <> bytes)))

nativeLedgerHash :: Text -> Parser C.ScriptHash
nativeLedgerHash text = C.fromShelleyScriptHash . L.hashScript <$> nativeLedgerScript text

outputLedger :: Value -> Parser (L.TxOut Era.ConwayEra)
outputLedger value = do
  typed <- output value
  native <- withObject "output" (\o -> o .:? "referenceScript" >>= maybe (pure Nothing) (withObject "reference script" (.:? "nativeScriptCbor"))) value
  let ledger = toShelleyTxOut C.ShelleyBasedEraConway (C.toCtxUTxOTxOut typed)
  case native of
    Nothing -> pure ledger
    Just text -> do
      script <- nativeLedgerScript text
      pure (ledger & L.referenceScriptTxOutL %~ const (pure script))


nativeScriptP :: Object -> Parser C.SimpleScript
nativeScriptP o = o .:? "nativeScriptCbor" >>= maybe (o .: "nativeScript" >>= parseJSON) (fmap (\(C.SimpleScript s) -> s) . cbor (C.AsScript C.AsSimpleScript))

anyScript :: Value -> Parser C.ScriptInAnyLang
anyScript = withObject "script" $ \o -> do
  lang <- o .: "language" :: Parser Text
  if lang == "Native"
    then C.ScriptInAnyLang C.SimpleScriptLanguage . C.SimpleScript <$> nativeScriptP o
    else do SomePlutus version script <- plutus o
            pure (C.ScriptInAnyLang (C.PlutusScriptLanguage version) (C.PlutusScript version script))
scriptWitness :: forall ctx. C.ScriptDatum ctx -> Value -> Parser (C.ScriptWitness ctx Era)
scriptWitness dat = withObject "script witness" $ \o -> do
  lang <- o .: "language" :: Parser Text
  ref <- o .:? "reference" >>= traverse input
  if lang == "Native" then do
    s <- case ref of
      Just i -> pure (C.SReferenceScript i)
      Nothing -> C.SScript <$> nativeScriptP o
    pure (C.SimpleScriptWitness C.SimpleScriptInConway s)
  else do
    red <- o .:? "redeemerCbor" >>= maybe (o .: "redeemer" >>= scriptData) (cbor C.AsHashableScriptData)
    let mk :: forall l. (C.HasScriptLanguageInEra l Era, C.IsPlutusScriptLanguage l) => C.PlutusScriptVersion l -> C.PlutusScript l -> C.ScriptWitness ctx Era
        mk version s = C.PlutusScriptWitness (C.scriptLanguageInEra @l @Era) version (maybe (C.PScript s) (\i -> C.PReferenceScript i) ref) dat red (C.ExecutionUnits 0 0)
    case ref of
      Nothing -> do SomePlutus version s <- plutus o; pure (mk version s)
      Just _ -> case lang of
        "PlutusV1" -> pure (mk C.PlutusScriptV1 (C.PlutusScriptSerialised mempty))
        "PlutusV2" -> pure (mk C.PlutusScriptV2 (C.PlutusScriptSerialised mempty))
        "PlutusV3" -> pure (mk C.PlutusScriptV3 (C.PlutusScriptSerialised mempty))
        _ -> fail "Unsupported script language"

output :: Value -> Parser (C.TxOut C.CtxTx Era)
output = withObject "output" $ \o -> do
  addr <- o .: "address" >>= address
  val <- value o
  mode <- o .:? "datumMode" .!= ("none" :: Text)
  dat <- case mode of
    "none" -> pure C.TxOutDatumNone
    "hash" -> C.TxOutDatumHash C.AlonzoEraOnwardsConway <$> (o .: "datumHash" >>= raw (C.AsHash C.AsScriptData))
    "inline" -> C.TxOutDatumInline C.BabbageEraOnwardsConway <$> ((o .:? "datumCbor" >>= maybe (o .: "datum" >>= scriptData) (cbor C.AsHashableScriptData)))
    "embedded" -> C.TxOutSupplementalDatum C.AlonzoEraOnwardsConway <$> ((o .:? "datumCbor" >>= maybe (o .: "datum" >>= scriptData) (cbor C.AsHashableScriptData)))
    _ -> fail "Unknown output datum mode"
  ref <- o .:? "referenceScript" >>= maybe (pure C.ReferenceScriptNone) (fmap (C.ReferenceScript C.BabbageEraOnwardsConway) . anyScript)
  pure (C.TxOut addr (B.mkTxOutValue val) dat ref)

stakeAddress :: Text -> Parser C.StakeAddress
stakeAddress t = maybe (raw C.AsStakeAddress t) pure (C.deserialiseAddress C.AsStakeAddress t)
stakeWitness :: Object -> Parser (Maybe (C.StakeCredential, C.Witness C.WitCtxStake Era))
stakeWitness o = do
  cred <- o .:? "credential"
  case cred of
    Nothing -> pure Nothing
    Just t -> do
      script <- o .:? "witness"
      case script of
        Nothing -> do k <- raw (C.AsHash C.AsStakeKey) t; pure (Just (C.StakeCredentialByKey k, C.KeyWitness C.KeyWitnessForStakeAddr))
        Just w -> do k <- raw C.AsScriptHash t; s <- scriptWitness C.NoScriptDatumForStake w; pure (Just (C.StakeCredentialByScript k,C.ScriptWitness C.ScriptWitnessForStakeAddr s))

block :: C.LedgerProtocolParameters Era -> Value -> Parser Builder
block params = withObject "transaction block" $ \o -> do
  kind <- o .: "type" :: Parser Text
  let build = pure . B.execBuildTx
  case kind of
    "output" -> o .: "output" >>= output >>= build . B.addOutput
    "input" -> do
      i <- o .: "input" >>= input
      wit <- o .:? "witness"
      case wit of
        Nothing -> build (B.spendPublicKeyOutput i)
        Just w -> do
          supplied <- o .:? "datumCbor" >>= traverse (cbor C.AsHashableScriptData)
          dat <- case supplied of
            Just d -> pure (C.ScriptDatumForTxIn (Just d))
            Nothing -> o .:? "datum" >>= maybe (pure C.InlineScriptDatum) (fmap (C.ScriptDatumForTxIn . Just) . scriptData)
          sw <- scriptWitness dat w
          build (B.addInputWithTxBody i (const (C.ScriptWitness C.ScriptWitnessForSpending sw)))
    "reference" -> o .: "input" >>= input >>= build . B.addReference
    "collateral" -> o .: "input" >>= input >>= build . B.addCollateral
    "signer" -> o .: "keyHash" >>= raw (C.AsHash C.AsPaymentKey) >>= build . B.addRequiredSignature
    "validity" -> do
      lower <- o .:? "from" >>= traverse integerP
      upper <- o .:? "until" >>= traverse integerP
      forM_ (lower ++? upper) $ \n -> when (n < 0 || n > 18446744073709551615) (fail "Slot is outside Word64")
      when (maybe False id ((>=) <$> lower <*> upper)) (fail "Validity interval is empty")
      build $ B.addBtx $ \b -> b {C.txValidityLowerBound=maybe C.TxValidityNoLowerBound (C.TxValidityLowerBound C.AllegraEraOnwardsConway . fromInteger) lower, C.txValidityUpperBound=C.TxValidityUpperBound C.ShelleyBasedEraConway (fromInteger <$> upper)}
    "metadata" -> do
      meta <- o .:? "cbor" >>= maybe (o .: "metadata" >>= rawJSON >>= eitherP . C.metadataFromJson C.TxMetadataJsonNoSchema) (cbor C.AsTxMetadata)
      build $ B.addBtx $ \b -> b {C.txMetadata=case C.txMetadata b of C.TxMetadataNone -> C.TxMetadataInEra C.ShelleyBasedEraConway meta; C.TxMetadataInEra e old -> C.TxMetadataInEra e (old <> meta)}
    "auxiliary" -> do
      s <- o .: "script" >>= anyScript
      scriptInEra <- maybe (fail "Script language unavailable in Conway") pure (C.toScriptInEra C.ShelleyBasedEraConway s)
      build (B.addAuxScript scriptInEra)
    "mint" -> do
      policy <- o .: "policyId" >>= raw C.AsPolicyId
      witnessValue <- o .: "witness"
      sw <- scriptWitness C.NoScriptDatumForMint witnessValue
      withObject "mint witness" (\wo -> do
        reference <- wo .:? "reference" :: Parser (Maybe Text)
        case reference of
          Just _ -> pure ()
          Nothing -> do
            native <- wo .:? "nativeScriptCbor"
            hash <- case native of
              Just text -> nativeLedgerHash text
              Nothing -> do
                C.ScriptInAnyLang _ actual <- anyScript witnessValue
                pure (C.hashScript actual)
            unless (C.PolicyId hash == policy) (fail "Policy ID does not match the minting script")) witnessValue
      assets <- (o .: "assets" :: Parser [Value]) >>= traverse (withObject "minted asset" $ \a -> (,) <$> (a .: "assetName" >>= raw C.AsAssetName) <*> (C.Quantity <$> intField a "quantity"))
      when (null assets) (fail "Mint block needs an asset")
      build $ forM_ assets $ \(name,qty) -> B.addMintWithTxBody policy name qty (const sw)
    "withdrawal" -> do
      addr <- o .: "address" >>= stakeAddress
      qty <- C.Quantity <$> positive o "lovelace"
      w <- o .:? "witness"
      wit <- maybe (pure (C.KeyWitness C.KeyWitnessForStakeAddr)) (fmap (C.ScriptWitness C.ScriptWitnessForStakeAddr) . scriptWitness C.NoScriptDatumForStake) w
      build (B.addWithdrawal addr qty wit)
    "certificate" -> do
      kind' <- o .:? "kind" .!= ("raw" :: Text)
      wit <- stakeWitness o
      cert <- case kind' of
        "raw" -> do bytes <- o .: "cbor" >>= hexBytes
                    E.Certificate <$> eitherP (LB.decodeFull' (LB.natVersion @10) bytes)
        _ -> do
          credential <- maybe (fail "Certificate requires a stake credential") (pure . fst) wit
          let deposit = C.unLedgerProtocolParameters params ^. ppKeyDepositL
          case kind' of
            "register" -> pure (E.makeStakeAddressRegistrationCertificate @Era credential deposit)
            "deregister" -> pure (E.makeStakeAddressUnregistrationCertificate @Era credential deposit)
            "delegate" -> do
              poolText <- o .: "poolId"
              pool <- case C.deserialiseFromBech32 poolText of
                Right p -> pure p
                Left _ -> raw (C.AsHash C.AsStakePoolKey) poolText
              let C.StakePoolKeyHash hash = pool
              pure (B.mkConwayStakeCredentialDelegationCertificate @Era credential (L.DelegStake hash))
            _ -> fail "Unsupported certificate type"
      build (B.addCertificate cert wit)
    "vote" -> do
      bytes <- o .: "cbor" >>= hexBytes
      votes <- eitherP (LB.decodeFull' (LB.natVersion @10) bytes)
      pairs <- (o .:? "witnesses" .!= [] :: Parser [Value]) >>= traverse (withObject "voter witness" $ \v -> do
        bytes' <- v .: "voterCbor" >>= hexBytes
        voter <- eitherP (LB.decodeFull' (LB.natVersion @10) bytes')
        witness <- v .: "witness" >>= scriptWitness C.NoScriptDatumForStake
        pure (voter,witness))
      unless (all (\(voter,_) -> Map.member voter (L.unVotingProcedures votes)) pairs) (fail "Witness supplied for a voter missing from the voting procedures")
      build $ B.addBtx $ \b -> b {C.txVotingProcedures=Just (C.Featured C.ConwayEraOnwardsConway (C.TxVotingProcedures votes (C.BuildTxWith (Map.fromList pairs))))}
    "proposal" -> do
      bytes <- o .: "cbor" >>= hexBytes
      proposal <- eitherP (LB.decodeFull' (LB.natVersion @10) bytes)
      w <- o .:? "witness" >>= traverse (scriptWitness C.NoScriptDatumForStake)
      build $ B.addBtx $ \b ->
        let existing = case C.txProposalProcedures b of
              Just (C.Featured _ (C.TxProposalProcedures xs)) -> [(p,w') | (p,C.BuildTxWith w') <- toList xs]
              _ -> []
        in b {C.txProposalProcedures=Just (C.Featured C.ConwayEraOnwardsConway (C.mkTxProposalProcedures (existing <> [(proposal,w)])))}
    "treasury" -> do
      donation <- C.Coin <$> positive o "lovelace"
      current <- o .:? "currentTreasury" >>= traverse integerP
      build $ B.addBtx $ \b -> b {C.txTreasuryDonation=Just (C.Featured C.ConwayEraOnwardsConway donation), C.txCurrentTreasuryValue=fmap (C.Featured C.ConwayEraOnwardsConway . Just . C.Coin) current}
    _ -> fail ("Unknown transaction block: " <> T.unpack kind)
  where (++?) a b = maybe [] (:[]) a <> maybe [] (:[]) b

-- The provider supplies exact era boundaries. No emulator clock or parameters
-- enter this path. A finite final boundary preserves the provider's safe horizon.
eraSummary :: Value -> Parser H.EraSummary
eraSummary = withObject "era summary" $ \o -> do
  start <- o .: "start" >>= bound
  end <- o .:? "end" >>= maybe (fail "Era history must include a finite safe horizon") (fmap H.EraEnd . bound)
  p <- o .: "parameters"
  epochLength <- p .: "epoch_length"
  slotLength <- p .: "slot_length"
  zone <- p .:? "safe_zone" .!= 4320
  pure (H.EraSummary start end (H.EraParams (C.EpochSize epochLength) (mkSlotLength (realToFrac (slotLength :: Double))) (H.StandardSafeZone zone) (GenesisWindow 4320) H.NoPerasEnabled))
  where bound = withObject "era bound" $ \b -> H.Bound <$> (RelativeTime . realToFrac <$> (b .: "time" :: Parser Double)) <*> b .: "slot" <*> b .: "epoch" <*> pure H.NoPerasEnabled
history :: [H.EraSummary] -> Parser C.EraHistory
history xs = case xs of
  [a] -> pure $ C.EraHistory $ H.mkInterpreter $ H.Summary $ NonEmptyOne a
  [a,b] -> pure $ C.EraHistory $ H.mkInterpreter $ H.Summary $ NonEmptyCons a $ NonEmptyOne b
  [a,b,c] -> pure $ C.EraHistory $ H.mkInterpreter $ H.Summary $ NonEmptyCons a $ NonEmptyCons b $ NonEmptyOne c
  [a,b,c,d] -> pure $ C.EraHistory $ H.mkInterpreter $ H.Summary $ NonEmptyCons a $ NonEmptyCons b $ NonEmptyCons c $ NonEmptyOne d
  [a,b,c,d,e] -> pure $ C.EraHistory $ H.mkInterpreter $ H.Summary $ NonEmptyCons a $ NonEmptyCons b $ NonEmptyCons c $ NonEmptyCons d $ NonEmptyOne e
  [a,b,c,d,e,f] -> pure $ C.EraHistory $ H.mkInterpreter $ H.Summary $ NonEmptyCons a $ NonEmptyCons b $ NonEmptyCons c $ NonEmptyCons d $ NonEmptyCons e $ NonEmptyOne f
  [a,b,c,d,e,f,g] -> pure $ C.EraHistory $ H.mkInterpreter $ H.Summary $ NonEmptyCons a $ NonEmptyCons b $ NonEmptyCons c $ NonEmptyCons d $ NonEmptyCons e $ NonEmptyCons f $ NonEmptyOne g
  [a,b,c,d,e,f,g,h] -> pure $ C.EraHistory $ H.mkInterpreter $ H.Summary $ NonEmptyCons a $ NonEmptyCons b $ NonEmptyCons c $ NonEmptyCons d $ NonEmptyCons e $ NonEmptyCons f $ NonEmptyCons g $ NonEmptyOne h
  _ -> fail "Expected 1–8 era summaries"

data Context = Context {ctxUtxo :: C.UTxO Era, ctxLedgerUtxo :: LedgerState.UTxO Era.ConwayEra, ctxParams :: C.LedgerProtocolParameters Era, ctxHistory :: C.EraHistory, ctxStart :: SystemStart, ctxNetwork :: C.NetworkId}
newtype Chain a = Chain {unChain :: ReaderT Context (ExceptT (CS.BalanceTxError Era) IO) a}
  deriving (Functor, Applicative, Monad, MonadIO, MonadReader Context, MonadError (CS.BalanceTxError Era))
instance MonadBlockchain Era Chain where
  sendTx _ = error "Submission belongs to the connected CIP-30 wallet"
  utxoByTxIn refs = asks $ \ctx -> case ctxUtxo ctx of C.UTxO m -> C.UTxO (Map.restrictKeys m refs)
  queryProtocolParameters = asks ctxParams
  queryStakePools = pure Set.empty
  queryStakeAddresses _ _ = error "Stake state must be supplied by the provider"
  queryStakeVoteDelegatees _ = error "Vote delegatees must be supplied by the provider"
  querySystemStart = asks ctxStart
  queryEraHistory = asks ctxHistory
  querySlotNo = error "Slot queries are not used by the browser balancer"
  queryNetworkId = asks ctxNetwork

parseContext :: Object -> Parser (Context, C.UTxO Era, C.AddressInEra Era, Builder, Word)
parseContext o = do
  wallet <- o .: "wallet"
  wutxos <- wallet .: "utxos" >>= traverse walletOutput
  collateral <- wallet .:? "collateral" .!= [] >>= traverse walletOutput
  fallbackCollateral <- wallet .:? "collateralFallback" .!= [] >>= traverse walletOutput
  external <- o .:? "resolvedInputs" .!= [] >>= traverse resolvedOutput
  ledgerWallet <- wallet .: "utxos" :: Parser [Value]
  ledgerCollateral <- wallet .:? "collateral" .!= []
  ledgerFallback <- wallet .:? "collateralFallback" .!= []
  ledgerExternal <- o .:? "resolvedInputs" .!= []
  ledgerUtxos <- traverse resolvedLedgerOutput (ledgerWallet <> ledgerCollateral <> ledgerFallback <> ledgerExternal)
  change <- wallet .: "changeAddress" >>= address
  chain <- o .: "chain"
  params <- C.LedgerProtocolParameters <$> (chain .: "protocolParameters" >>= parseJSON . protocolJSON)
  eras <- chain .: "eraSummaries" >>= traverse eraSummary >>= history
  startValue <- chain .: "systemStart"
  seconds <- case startValue of
    String t -> either fail pure (eitherDecodeStrict (encodeUtf8 t) :: Either String Scientific)
    v -> parseJSON v
  let start = SystemStart (posixSecondsToUTCTime (realToFrac seconds))
  net <- chain .: "network" :: Parser Text
  network <- case net of "mainnet" -> pure C.Mainnet; "preprod" -> pure (C.Testnet (C.NetworkMagic 1)); "preview" -> pure (C.Testnet (C.NetworkMagic 2)); "custom" -> C.Testnet . C.NetworkMagic <$> (chain .:? "networkMagic" .!= 0); _ -> fail "Unknown network"
  let allUtxos = Map.fromList (wutxos <> collateral <> fallbackCollateral <> external)
      addressNetwork :: C.AddressInEra Era -> L.Network
      addressNetwork = getNetwork . C.toShelleyAddr
  unless (addressNetwork change == C.toShelleyNetwork network) (fail "Change address does not match the selected network")
  blocks <- o .: "blocks" :: Parser [Value]

  builder <- mconcat <$> traverse (block params) blocks
  let body = B.buildTx builder
      refs = case C.txInsReference body of C.TxInsReference _ is _ -> is; _ -> []
      cols = case C.txInsCollateral body of C.TxInsCollateral _ is -> is; _ -> []
      spent = map fst (C.txIns body)
  forM_ [spent,refs,cols] $ \is -> unless (length is == Set.size (Set.fromList is)) (fail "Duplicate input in transaction")
  unless (Set.null (Set.intersection (Set.fromList spent) (Set.fromList refs))) (fail "An input cannot be spent and referenced")
  forM_ (spent <> refs <> cols) $ \i -> unless (Map.member i allUtxos) (fail ("Missing resolved UTXO: " <> T.unpack (inputText i)))
  forM_ (C.txOuts body) $ \(C.TxOut a _ _ _) -> unless (addressNetwork a == C.toShelleyNetwork network) (fail "Recipient address is on a different network")
  extra <- o .:? "additionalWitnesses" .!= 0
  pure (Context (C.UTxO allUtxos) (LedgerState.UTxO (Map.fromList ledgerUtxos)) params eras start network, C.UTxO (Map.withoutKeys (Map.fromList wutxos) (Set.fromList refs)),change,builder,extra)

resolvedLedgerOutput :: Value -> Parser (TxIn.TxIn, L.TxOut Era.ConwayEra)
resolvedLedgerOutput (String text) = hexBytes text >>= eitherP . LB.decodeFull' (LB.natVersion @10)
resolvedLedgerOutput value = withObject "resolved input" (\o -> (,) <$> (o .: "input" >>= input >>= pure . C.toShelleyTxIn) <*> (o .: "output" >>= outputLedger)) value

resolvedOutput :: Value -> Parser (C.TxIn, C.TxOut C.CtxUTxO Era)
resolvedOutput (String t) = walletOutput t
resolvedOutput v = withObject "resolved input" (\o -> (,) <$> (o .: "input" >>= input) <*> (C.toCtxUTxOTxOut <$> (o .: "output" >>= output))) v

valueAssets :: C.Value -> [Value]
valueAssets v = [object ["policyId" .= C.serialiseToRawBytesHexText p,"assetName" .= C.serialiseToRawBytesHexText n,"quantity" .= show q] | (C.AssetId p n,C.Quantity q) <- C.valueToList v]

outputJSON :: C.TxOut ctx Era -> Value
outputJSON out@(C.TxOut addr val dat ref) = object
  ["address" .= C.serialiseAddress addr,"lovelace" .= show (C.unCoin (C.txOutValueToLovelace val)),"assets" .= assets,"datum" .= datum,"referenceScript" .= refJSON,"cardano" .= toJSON out]
  where
    assets = [object ["policyId" .= C.serialiseToRawBytesHexText p,"assetName" .= C.serialiseToRawBytesHexText n,"quantity" .= show q] | (C.AssetId p n,C.Quantity q) <- C.valueToList (C.txOutValueToValue val)]
    datum = case dat of C.TxOutDatumNone -> Null; C.TxOutDatumHash _ h -> object ["hash" .= C.serialiseToRawBytesHexText h]; C.TxOutDatumInline _ d -> C.scriptDataToJson C.ScriptDataJsonDetailedSchema d; C.TxOutSupplementalDatum _ d -> C.scriptDataToJson C.ScriptDataJsonDetailedSchema d
    refJSON = case ref of C.ReferenceScriptNone -> Null; C.ReferenceScript _ s -> toJSON s

inspect :: C.Tx Era -> Value
inspect tx = object
  ["txId" .= C.serialiseToRawBytesHexText (C.getTxId body),"cborHex" .= hexText bytes,"bytes" .= BS.length bytes
  ,"feeLovelace" .= show (C.unCoin fee),"inputs" .= map (inputText . fst) (C.txIns b),"outputs" .= map outputJSON (C.txOuts b)
  ,"referenceInputs" .= references,"collateralInputs" .= collateral,"returnCollateral" .= ret,"totalCollateral" .= total
  ,"validity" .= object ["from" .= lower,"until" .= upper],"requiredSigners" .= signers,"metadata" .= metadata
  ,"mint" .= valueAssets (C.txMintValueToValue (C.txMintValue b)),"withdrawals" .= withdrawals,"certificates" .= certificates
  ,"votes" .= votes,"proposals" .= proposals,"treasuryDonation" .= donation
  ,"textEnvelope" .= C.serialiseToTextEnvelope Nothing tx,"witnesses" .= length (C.getTxWitnesses tx)]
  where
    body = C.getTxBody tx; b = C.getTxBodyContent body; bytes = C.serialiseToCBOR tx
    fee = case C.txFee b of C.TxFeeExplicit _ x -> x
    references = case C.txInsReference b of C.TxInsReference _ xs _ -> map inputText xs; _ -> []
    collateral = case C.txInsCollateral b of C.TxInsCollateral _ xs -> map inputText xs; _ -> []
    ret = case C.txReturnCollateral b of C.TxReturnCollateral _ x -> outputJSON x; _ -> Null
    total = case C.txTotalCollateral b of C.TxTotalCollateral _ x -> toJSON (show (C.unCoin x)); _ -> Null
    lower = case C.txValidityLowerBound b of C.TxValidityLowerBound _ x -> toJSON x; _ -> Null
    upper = case C.txValidityUpperBound b of C.TxValidityUpperBound _ x -> toJSON x
    signers = case C.txExtraKeyWits b of C.TxExtraKeyWitnesses _ xs -> map C.serialiseToRawBytesHexText xs; _ -> []
    withdrawals = case C.txWithdrawals b of C.TxWithdrawalsNone -> []; C.TxWithdrawals _ xs -> [object ["address" .= C.serialiseAddress a,"lovelace" .= show q] | (a,C.Coin q,_) <- xs]
    certificates = case C.txCertificates b of C.TxCertificatesNone -> []; C.TxCertificates _ xs -> [object ["description" .= show cert, "cbor" .= hexText (LB.serialize' (LB.natVersion @10) cert)] | (E.Certificate cert,_) <- toList xs]
    votes = case C.txVotingProcedures b of Just (C.Featured _ (C.TxVotingProcedures p _)) -> toJSON p; _ -> Null
    proposals = case C.txProposalProcedures b of Just (C.Featured _ (C.TxProposalProcedures xs)) -> [object ["description" .= show p, "cbor" .= hexText (LB.serialize' (LB.natVersion @10) p)] | (p,_) <- toList xs]; _ -> []
    donation = case C.txTreasuryDonation b of Just (C.Featured _ q) -> show (C.unCoin q); _ -> "0"
    metadata = case C.txMetadata b of C.TxMetadataNone -> Null; C.TxMetadataInEra _ x -> C.metadataToJson C.TxMetadataJsonNoSchema x

balance :: (Context,C.UTxO Era,C.AddressInEra Era,Builder,Word) -> IO Value
balance (ctx,wallet,change,builder,extra) = do
  traces <- newIORef []
  let tracer = Tracer (\e -> liftIO $ modifyIORef' traces (e:))
      C.UTxO wmap = wallet
      funding = UtxoSet (Map.map (\o -> (C.InAnyCardanoEra C.ConwayEra o,())) wmap)
      changeOut = B.payToAddressTxOut change mempty
      rebalance :: Int -> C.TxBodyContent C.BuildTx Era -> C.TxOut C.CtxTx Era -> Chain (C.BalancedTxBody Era)
      rebalance attempts content previousChange = do
        -- The first pass selects coins. Further passes reserve key witnesses
        -- and include collateral-return fields in the serialized fee estimate.
        let stripped = content {C.txOuts=init (C.txOuts content)}
            count = C.estimateTransactionKeyWitnessCount content + extra
            prepared = CS.prepCSInputs (CS.TransactionSignatureCount count) previousChange (ctxUtxo ctx) (B.liftTxBodyEndo (const stripped))
        (C.BalancedTxBody next _ finalChange fee,_) <- CS.balanceTransactionBody tracer (ctxStart ctx) (ctxHistory ctx) (ctxParams ctx) Set.empty prepared CS.TrailingChange
        let collateralIds = case C.txInsCollateral next of C.TxInsCollateral _ is -> is; _ -> []
            C.UTxO allInputs = ctxUtxo ctx
            collateralValue = foldMap (\i -> maybe mempty (\(C.TxOut _ v _ _) -> C.txOutValueToValue v) (Map.lookup i allInputs)) collateralIds
            (returned,total) = C.calcReturnAndTotalCollateral C.BabbageEraOnwardsConway fee (C.unLedgerProtocolParameters (ctxParams ctx)) (C.txInsCollateral next) C.TxReturnCollateralNone C.TxTotalCollateralNone change (C.toMaryValue collateralValue)
            corrected = next {C.txReturnCollateral=returned,C.txTotalCollateral=total}
        finalBody <- either (throwError . CS.ACoinSelectionError . CS.bodyError) pure (C.createTransactionBody C.ShelleyBasedEraConway corrected)
        let minimumFee = C.calculateMinTxFee C.ShelleyBasedEraConway (C.unLedgerProtocolParameters (ctxParams ctx)) (ctxUtxo ctx) finalBody count
        if minimumFee <= fee then pure (C.BalancedTxBody corrected finalBody finalChange fee)
          else if attempts > 0 then rebalance (attempts - 1) corrected finalChange
          else throwError (CS.ABalancingError (CS.BalancingError "Fee and collateral did not converge"))
      action = do
        (C.BalancedTxBody content _ changeResult _,_) <- CS.balanceTx tracer changeOut funding builder CS.TrailingChange
        rebalance 4 content changeResult
  outcome <- runExceptT $ runReaderT (unChain action) ctx
  events <- reverse <$> readIORef traces
  pure $ case outcome of
    Left e -> object ["ok" .= False,"error" .= show e,"trace" .= events]
    Right (C.BalancedTxBody content body changeOut' _) -> object
      ["ok" .= True,"transaction" .= inspect (C.makeSignedTransaction [] body),"change" .= outputJSON changeOut',"trace" .= events
      ,"selectedInputs" .= [object ["input" .= inputText i,"output" .= outputJSON out] | (i,_) <- C.txIns content, Just out <- [let C.UTxO m = ctxUtxo ctx in Map.lookup i m]]
      ,"witnessEstimate" .= (C.estimateTransactionKeyWitnessCount content + extra)]

handleRequest :: Value -> IO Value
handleRequest request = do
  outcome <- try @SomeException $ case parseEither (withObject "request" (\o -> o .: "action" :: Parser Text)) request of
    Left e -> pure (failure e)
    Right "exampleScripts" -> pure $ either failure id (parseEither exampleScripts request)
    Right "balance" -> case parseEither (withObject "balance request" parseContext) request of
      Left e -> pure (failure e)
      Right ctx -> balance ctx
    Right "wallet" -> pure $ either failure id $ parseEither (withObject "wallet request" $ \o -> do
      addr <- o .: "changeAddress" >>= address
      items <- o .: "utxos" >>= traverse walletOutput
      rewards <- o .:? "rewardAddresses" .!= [] >>= traverse stakeAddress
      pure $ object ["ok" .= True,"changeAddress" .= C.serialiseAddress addr,"rewardAddresses" .= map C.serialiseAddress rewards,"utxos" .= [object ["input" .= inputText i,"output" .= outputJSON out] | (i,out) <- items]]) request
    Right "mergeWitnesses" -> pure $ either failure (\tx -> object ["ok" .= True,"transaction" .= inspect tx]) $ parseEither (withObject "signing request" $ \o -> do
      tx <- o .: "cbor" >>= cbor (C.AsTx C.AsConwayEra)
      bytes <- o .: "witnessSet" >>= hexBytes
      witnesses <- eitherP (LB.decodeFullAnnotator (LB.natVersion @10) "CIP-30 witnesses" LB.decCBOR (BL.fromStrict bytes))
      let C.ShelleyTx C.ShelleyBasedEraConway ledger = tx
      let signed = C.ShelleyTx C.ShelleyBasedEraConway (ledger & L.witsTxL %~ (<> witnesses))
      context <- o .:? "balanceContext"
      forM_ context $ \v -> do
        (ctx,_,_,_,_) <- withObject "balance context" parseContext v
        let minimumFee = C.calculateMinTxFee C.ShelleyBasedEraConway (C.unLedgerProtocolParameters (ctxParams ctx)) (ctxUtxo ctx) (C.getTxBody signed) (fromIntegral (length (C.getTxWitnesses signed)))
            actualFee = case C.txFee (C.getTxBodyContent (C.getTxBody signed)) of C.TxFeeExplicit _ fee -> fee
        when (actualFee < minimumFee) (fail "Wallet returned more signatures than reserved. Increase Additional signatures and balance again.")
      pure signed) request
    Right "inspect" -> pure $ either failure (\tx -> object ["ok" .= True,"transaction" .= inspect tx]) $ parseEither (withObject "inspect request" $ \o -> o .: "cbor" >>= cbor (C.AsTx C.AsConwayEra)) request
    Right _ -> pure (failure "Unknown request action")
  pure $ exactJSON $ either (failure . displayException) id outcome
  where failure :: String -> Value
        failure e = object ["ok" .= False,"error" .= e]

-- JSON numbers outside JavaScript's exact integer range are returned as strings.
-- CBOR and raw datum JSON remain authoritative and preserve all integer widths.
exactJSON :: Value -> Value
exactJSON (Number n) | abs n > 9007199254740991 = String (T.pack (show (truncate n :: Integer)))
exactJSON (Array xs) = Array (fmap exactJSON xs)
exactJSON (Object xs) = Object (fmap exactJSON xs)
exactJSON v = v

-- Accept decimal strings for exact protocol quantities crossing JavaScript's JSON boundary.
protocolJSON :: Value -> Value
protocolJSON (String t) = case eitherDecodeStrict (encodeUtf8 t) of
  Right n@(Number _) -> n
  _ -> String t
protocolJSON (Object o) = Object (fmap protocolJSON o)
protocolJSON (Array a) = Array (fmap protocolJSON a)
protocolJSON v = v
