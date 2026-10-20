{-# LANGUAGE DataKinds, GADTs, OverloadedStrings, ScopedTypeVariables, TypeApplications, FlexibleContexts #-}
module LucidBalance (balanceRequest, evaluateRequest) where

import LiveTx
import Ledger.Canonical qualified as Canonical
import Cardano.Api qualified as C
import Cardano.Api.Experimental qualified as E
import GHC.IsList (toList, fromList)
import Cardano.Api.Tx (substituteExecutionUnits, toScriptIndex)
import Cardano.Api.Query (LedgerEpochInfo(..))
import Cardano.Ledger.Binary qualified as LB
import Cardano.Api.Ledger qualified as L
import Cardano.Ledger.Api qualified as L
import Cardano.Ledger.Core qualified as L
import Cardano.Ledger.Babbage.Core qualified as L
import Cardano.Ledger.Alonzo.PParams qualified as L
import Cardano.Ledger.Keys (coerceKeyRole)
import Cardano.Ledger.Conway.TxCert qualified as LC
import Convex.BuildTx qualified as B
import Convex.Wallet qualified as W
import Convex.Utxos (UtxoSet(..))
import Data.Aeson
import Data.Aeson.Types (Parser, parseEither)
import Data.Aeson.KeyMap qualified as KM
import Data.Map.Strict qualified as Map
import Data.Set qualified as Set
import Data.Text qualified as T
import Data.ByteString qualified as BS
import Data.List (sortOn, sort)
import Data.Ord (Down(..))
import Control.Monad (when, unless, forM)
import Control.Monad.Except
import Control.Lens ((^.), (&), (.~), (%~))

-- Values and witnesses stay in Cardano types throughout balancing. Coin selection
-- uses convex-wallet; evaluation, fees, and deposits use the ledger APIs used by sc-tools.
type Balance = Either String
liftE :: Show e => Either e a -> Balance a
liftE = either (Left . show) Right
require :: Bool -> String -> Balance ()
require b e = unless b (Left e)
feeOf b = case C.txFee b of C.TxFeeExplicit _ c -> c
setFee q b = b { C.txFee = C.TxFeeExplicit C.ShelleyBasedEraConway q }
-- cardano-api 11's experimental witness conversion drops witnessless positions.
-- The validated legacy constructor indexes certificates, voters, and proposals
-- against the entire body, as the Conway ledger requires.
mkBody = liftE . C.createAndValidateTransactionBody C.ShelleyBasedEraConway
outValue (C.TxOut _ v _ _) = C.txOutValueToValue v
coinValue n = C.lovelaceToValue (C.Coin n)
mkOutput addr v = C.TxOut addr (B.mkTxOutValue v) C.TxOutDatumNone C.ReferenceScriptNone
minimumCoin pp = C.unCoin . C.calculateMinimumUTxO C.ShelleyBasedEraConway (C.unLedgerProtocolParameters pp)
plutusIndices body = [i | (i, C.AnyScriptWitness (C.PlutusScriptWitness {})) <- C.collectTxBodyScriptWitnesses C.ShelleyBasedEraConway body]

indexJSON :: C.ScriptWitnessIndex -> Value
indexJSON i = let (tag, ix) = case i of
                   C.ScriptWitnessIndexTxIn n -> ("spend",n)
                   C.ScriptWitnessIndexMint n -> ("mint",n)
                   C.ScriptWitnessIndexCertificate n -> ("publish",n)
                   C.ScriptWitnessIndexWithdrawal n -> ("withdraw",n)
                   C.ScriptWitnessIndexVoting n -> ("vote",n)
                   C.ScriptWitnessIndexProposing n -> ("propose",n)
             in object ["tag" .= (tag :: String), "index" .= ix]
indexP o = do
  tag <- o .: "redeemer_tag" :: Parser String
  ix <- o .: "redeemer_index"
  case tag of
    "spend" -> pure (C.ScriptWitnessIndexTxIn ix)
    "mint" -> pure (C.ScriptWitnessIndexMint ix)
    "publish" -> pure (C.ScriptWitnessIndexCertificate ix)
    "withdraw" -> pure (C.ScriptWitnessIndexWithdrawal ix)
    "vote" -> pure (C.ScriptWitnessIndexVoting ix)
    "propose" -> pure (C.ScriptWitnessIndexProposing ix)
    _ -> fail "Unknown redeemer tag"
unitsP = withObject "evaluation" $ \o -> do
  i <- indexP o
  u <- o .: "ex_units"
  mem <- intField u "mem"; steps <- intField u "steps"
  when (mem < 0 || steps < 0) (fail "Negative execution units")
  pure (i, C.ExecutionUnits (fromInteger steps) (fromInteger mem))
unitsJSON (i, C.ExecutionUnits steps mem) = case indexJSON i of
  Object o -> object ["purpose" .= Object o, "mem" .= mem,"steps" .= steps]
  _ -> Null

balanceRequest :: Value -> IO Value
balanceRequest v = pure $ either failure id $ parseEither prepare v >>= parseEither parse >>= runBalance
  where failure e = object ["ok" .= False, "error" .= e]
        prepare value = withObject "balanceV2" (\o -> do
          options <- o .:? "options" .!= mempty
          canonical <- options .:? "canonical" .!= False
          if canonical then Canonical.request value else pure value) value
        parse = withObject "balanceV2" $ \o -> do
          ctx <- parseContext o
          walletJSON <- o .: "wallet"
          collateralInputs <- walletJSON .: "utxos" >>= traverse walletOutput
          extraCollateral <- walletJSON .:? "collateral" .!= [] >>= traverse walletOutput
          fallbackCollateral <- walletJSON .:? "collateralFallback" .!= [] >>= traverse walletOutput
          blocks <- o .: "blocks" :: Parser [Value]
          explicitOutputs <- fmap concat $ forM blocks $ withObject "block" $ \block -> do
            kind <- block .: "type" :: Parser T.Text
            if kind == "output" then (:[]) <$> (block .: "output" >>= outputLedger) else pure []
          let nativeOutputs = Map.fromList [(index,output ^. L.referenceScriptTxOutL) | (index,output) <- zip [0 :: Int ..] explicitOutputs]
          nativeWitnesses <- fmap concat $ forM blocks $ withObject "block" $ \block -> do
            witness <- block .:? "witness"
            case witness of
              Nothing -> pure []
              Just value -> withObject "witness" (\w -> do
                encoded <- w .:? "nativeScriptCbor"
                case encoded of
                  Nothing -> pure []
                  Just text -> do
                    script <- nativeLedgerScript text
                    normalized <- nativeScriptP w
                    pure [(C.hashScript (C.SimpleScript normalized),script)]) value
          opts <- o .:? "options" .!= mempty
          select <- opts .:? "coinSelection" .!= True
          canonical <- opts .:? "canonical" .!= False
          minFee <- opts .:? "minFee" >>= maybe (pure 0) integerP
          explicitFee <- opts .:? "explicitFee" .!= False
          collateral <- opts .:? "setCollateral" >>= maybe (pure 5000000) integerP
          dust <- opts .:? "includeLeftoverLovelaceAsFee" .!= False
          mode <- opts .:? "evaluation" .!= ("local" :: String)
          units <- opts .:? "exUnits" .!= [] >>= traverse unitsP
          expected <- opts .:? "expectedInputs" :: Parser (Maybe [T.Text])
          chain <- o .: "chain"
          pools <- chain .:? "stakePools" .!= [] >>= traverse (raw (C.AsHash C.AsStakePoolKey))
          refunds <- chain .:? "stakeDeposits" .!= [] >>= traverse (withObject "stake deposit" $ \d -> do
            cred <- credentialP d; amount <- C.Coin <$> intField d "deposit"; pure (cred, amount))
          drepRefunds <- chain .:? "drepDeposits" .!= [] >>= traverse (withObject "DRep deposit" $ \d -> do
            cred <- credentialP d; amount <- C.Coin <$> intField d "deposit"; pure (coerceKeyRole (C.toShelleyStakeCredential cred), amount))
          when (minFee < 0 || collateral < 0) (fail "Fee and collateral must be nonnegative")
          unless (mode `elem` ["local","provided","bootstrap"]) (fail "Invalid evaluation mode")
          pure (ctx,select,C.Coin minFee,explicitFee,collateral,dust,mode,Map.fromList units,expected,Set.fromList pools,Map.fromList refunds,Map.fromList drepRefunds,Map.fromList (collateralInputs <> fallbackCollateral),Map.fromList extraCollateral,canonical,Map.fromListWith (<>) [(hash,[script]) | (hash,script) <- nativeWitnesses],nativeOutputs)

credentialP o = do
  typ <- o .: "type" :: Parser String
  hash <- o .: "hash"
  if typ == "Key" then C.StakeCredentialByKey <$> raw (C.AsHash C.AsStakeKey) hash
    else if typ == "Script" then C.StakeCredentialByScript <$> raw C.AsScriptHash hash
    else fail "Invalid credential"

runBalance ((ctx,wallet,change,builder,extra),selection,minFee,explicitFee,collateralFloor,allowDust,mode,supplied,expected,pools,stakeDeposits,drepDeposits,collateralWallet,preferredCollateral,canonical,nativeWitnesses,nativeOutputs) = do
  let pp = ctxParams ctx
      ledgerPP = C.unLedgerProtocolParameters pp
      C.UTxO allUtxos = ctxUtxo ctx
      C.UTxO walletMap = wallet
      original = B.buildTx builder
      initial = original { C.txProtocolParams = C.BuildTxWith (Just pp) }
      makeBody content = do
        originalBody <- mkBody content
        let C.ShelleyTxBody era ledgerBody scripts scriptData auxiliary validity = originalBody
            replaceScript script = Map.findWithDefault [script] (C.fromShelleyScriptHash (L.hashScript script)) nativeWitnesses
            outputs = ledgerBody ^. L.outputsTxBodyL
            replaced = fromList [output & L.referenceScriptTxOutL .~ Map.findWithDefault (output ^. L.referenceScriptTxOutL) index nativeOutputs | (index,output) <- zip [0 :: Int ..] (toList outputs)]
            body = C.ShelleyTxBody era (ledgerBody & L.outputsTxBodyL .~ replaced) (concatMap replaceScript scripts) scriptData auxiliary validity
        if not canonical then pure body else do
          transaction <- parseEither (const $ do
            bytes <- Canonical.transaction (C.serialiseToCBOR (C.makeSignedTransaction [] body))
            eitherP (C.deserialiseFromCBOR (C.AsTx C.AsConwayEra) bytes)) Null
          pure (C.getTxBody transaction)

      -- Explicit deregistration refunds default to Lucid's parameter snapshot.
      defaultRefunds = case C.txCertificates initial of
        C.TxCertificatesNone -> Map.empty
        C.TxCertificates _ cs -> Map.fromList [(cred, ledgerPP ^. L.ppKeyDepositL) | (_,C.BuildTxWith (Just (cred,_))) <- toList cs]
      defaultDRepRefunds = case C.txCertificates initial of
        C.TxCertificatesNone -> Map.empty
        C.TxCertificates _ cs -> Map.fromList [pair | (E.Certificate cert,_) <- toList cs, Just pair <- [LC.getUnRegDRepTxCert cert]]
      balance b = do
        txbody <- makeBody b
        pure $ C.txOutValueToValue $ C.evaluateTransactionBalance C.ShelleyBasedEraConway ledgerPP pools (Map.union stakeDeposits defaultRefunds) (Map.union drepDeposits defaultDRepRefunds) (ctxUtxo ctx) txbody
      asFunding m = UtxoSet (Map.map (\o -> (C.InAnyCardanoEra C.ConwayEra o,())) m)
      addFunds need body = do
        require selection "Insufficient funds with coinSelection disabled"
        let spent = Set.fromList (map fst (C.txIns body))
            available = Map.withoutKeys walletMap spent
        (_, ids) <- maybe (Left ("Insufficient funds: " <> show need)) Right (W.selectMixedInputsCovering (asFunding available) need)
        require (not (null ids)) "Coin selection made no progress"
        pure $ B.buildTx (B.liftTxBodyEndo (const body) <> B.execBuildTx (mapM_ B.spendPublicKeyOutput ids))
      valueSize v = BS.length (LB.serialize' (LB.natVersion @10) (C.toMaryValue v))
      maxValueSize = fromIntegral (ledgerPP ^. L.ppMaxValSizeL)
      -- Large token bundles need multiple change outputs. Reserve the largest coin
      -- encoding while partitioning, then allocate minimum ADA to every bundle.
      changeOutputs value = do
        let tokens = [(a,q) | (a,q) <- C.valueToList value, a /= C.AdaAssetId]
            padded v = v <> coinValue 18446744073709551615
            pack [] current acc = reverse ([current | current /= mempty] <> acc)
            pack (token:rest) current acc =
              let next = current <> C.valueFromList [token]
              in if current /= mempty && valueSize (padded next) > maxValueSize
                 then pack (token:rest) mempty (current:acc)
                 else pack rest next acc
            bundles = if null tokens then [mempty] else pack tokens mempty []
            minimumFor v = minimumCoin pp (mkOutput change (padded v))
            required = if null tokens then minimumCoin pp (mkOutput change value) else sum (map minimumFor bundles)
            ada = C.unCoin (C.selectLovelace value)
            allocate [] = []
            allocate (b:bs) = mkOutput change (b <> coinValue (ada - sum (map minimumFor bs))) : [mkOutput change (v <> coinValue (minimumFor v)) | v <- bs]
        require (all ((<= maxValueSize) . valueSize . padded) bundles) "An asset exceeds maxValueSize"
        pure (required, allocate bundles)
      chooseCollateral fee body = if null (plutusIndices body) then Right body else do
        let needed = max collateralFloor (if mode == "bootstrap" then 0 else (C.unCoin fee * toInteger (ledgerPP ^. L.ppCollateralPercentageL) + 99) `div` 100)
            insufficient = "Your wallet does not have enough funds to cover the required " <> show needed <> " Lovelace collateral within maxCollateralInputs"
            fixed = case C.txInsCollateral original of C.TxInsCollateral _ ids -> ids; _ -> []
            usable (C.TxOut (C.AddressInEra _ (C.ShelleyAddress _ (L.KeyHashObj _) _)) _ _ C.ReferenceScriptNone) = True
            usable _ = False
            candidates m = sortOn (Down . C.selectLovelace . outValue . snd) (Map.toList (Map.filter usable m))
            takeEnough ids value rest
              | C.unCoin (C.selectLovelace value) >= needed
                && (C.valueToLovelace value /= Nothing || C.unCoin (C.selectLovelace value) - needed >= minimumCoin pp (mkOutput change (value <> coinValue (-needed)))) = Right (ids,value)
              | length ids >= fromIntegral (ledgerPP ^. L.ppMaxCollateralInputsL) = Left insufficient
              | otherwise = case rest of
                  [] -> Left insufficient
                  (i,o):xs | i `elem` ids -> takeEnough ids value xs
                           | otherwise -> takeEnough (ids<>[i]) (value <> outValue o) xs
        let select m = takeEnough fixed (foldMap (maybe mempty outValue . (`Map.lookup` allUtxos)) fixed) (candidates m)
            exact = [(i,o) | (i,o) <- candidates preferredCollateral, C.valueToLovelace (outValue o) == Just (C.Coin needed)]
        (ids,value) <- case (fixed,exact) of
          ([],(i,o):_) -> pure ([i],outValue o)
          _ -> case select preferredCollateral of
            Right selected -> Right selected
            Left _ ->
              let preferred = candidates preferredCollateral
                  seed = Set.toList (Set.fromList (fixed <> map fst preferred))
                  value = foldMap (maybe mempty outValue . (`Map.lookup` allUtxos)) seed
                  combined = Map.union preferredCollateral collateralWallet
                  extend = if C.unCoin (C.selectLovelace value) >= collateralFloor && length seed <= fromIntegral (ledgerPP ^. L.ppMaxCollateralInputsL)
                           then takeEnough seed value (candidates combined)
                           else Left insufficient
              in case extend of
                Right selected -> Right selected
                Left _ -> select combined
        let returnedValue = value <> coinValue (-needed)
            returned = mkOutput change returnedValue
            remainder = C.unCoin (C.selectLovelace returnedValue)
        if returnedValue == mempty then pure body { C.txInsCollateral=C.TxInsCollateral C.AlonzoEraOnwardsConway ids, C.txTotalCollateral=C.TxTotalCollateral C.BabbageEraOnwardsConway (C.Coin needed), C.txReturnCollateral=C.TxReturnCollateralNone }
        else if remainder >= minimumCoin pp returned then pure body { C.txInsCollateral=C.TxInsCollateral C.AlonzoEraOnwardsConway ids, C.txTotalCollateral=C.TxTotalCollateral C.BabbageEraOnwardsConway (C.Coin needed), C.txReturnCollateral=C.TxReturnCollateral C.BabbageEraOnwardsConway returned }
        else if C.valueToLovelace returnedValue /= Nothing then pure body { C.txInsCollateral=C.TxInsCollateral C.AlonzoEraOnwardsConway ids, C.txTotalCollateral=C.TxTotalCollateral C.BabbageEraOnwardsConway (C.selectLovelace value), C.txReturnCollateral=C.TxReturnCollateralNone }
        else Left "Collateral return does not have enough minimum ADA"
      run n base fee known previous = do
        require (n < 40) "sc-tools balancing did not converge"
        let indices = plutusIndices base
            maxUnits = ledgerPP ^. L.ppMaxTxExUnitsL
            bootstrap = Map.fromList [(i,C.ExecutionUnits (fromIntegral (L.exUnitsSteps maxUnits) `div` fromIntegral (max 1 (length indices))) (fromIntegral (L.exUnitsMem maxUnits) `div` fromIntegral (max 1 (length indices)))) | i <- indices]
            units = if mode == "bootstrap" then bootstrap else Map.union (if mode == "provided" then supplied else known) (Map.fromList [(i,C.ExecutionUnits 0 0) | i <- indices])
        let usedMemory = sum [toInteger mem | C.ExecutionUnits _ mem <- Map.elems units]
            usedSteps = sum [toInteger steps | C.ExecutionUnits steps _ <- Map.elems units]
        -- Like CML, external evaluation may supply synthetic budgets for
        -- inspection. Local execution and mockchain submission enforce limits.
        when (mode /= "provided") $ require (usedMemory <= toInteger (L.exUnitsMem maxUnits) && usedSteps <= toInteger (L.exUnitsSteps maxUnits)) "Transaction exceeds maximum execution budget"
        budgeted <- liftE (substituteExecutionUnits units (setFee fee base))
        col <- chooseCollateral fee budgeted
        bal <- balance col
        let missing = [(a,negate q) | (a,q) <- C.valueToList bal, q < 0]
        if not (null missing) || null (C.txIns col) then do
          more <- addFunds (if null missing then [(C.AdaAssetId,1)] else missing) base
          run (n+1) more fee Map.empty Nothing
        else do
          (requiredChange, changeOuts) <- changeOutputs bal
          let ada = C.unCoin (C.selectLovelace bal)
              enough = ada >= requiredChange
              dust = bal /= mempty && not enough && C.valueToLovelace bal /= Nothing && allowDust
          if bal /= mempty && not enough && not dust then do
            more <- addFunds [(C.AdaAssetId,C.Quantity (requiredChange - ada))] base
            run (n+1) more fee Map.empty Nothing
          else do
            let finalFee = if dust then fee + C.Coin ada else fee
                content = (setFee finalFee col) { C.txOuts = C.txOuts original <> (if bal /= mempty && not dust then changeOuts else []) }
            body <- makeBody content
            -- Bootstrap budgets only shape delayed redeemers. With an explicit
            -- fee, match CML by not charging the maximum transaction budget to
            -- a candidate that will be evaluated again before it can be signed.
            feeBody <- if mode == "bootstrap" && explicitFee
              then liftE (substituteExecutionUnits (Map.map (const (C.ExecutionUnits 0 0)) units) content) >>= makeBody
              else pure body
            let count = C.estimateTransactionKeyWitnessCount content + extra
                C.ShelleyTx _ feeTx = C.makeSignedTransaction [] feeBody
                minimumFee = max minFee (L.calcMinFeeTx (ctxLedgerUtxo ctx) ledgerPP feeTx (fromIntegral count))
                ids = sort (map (inputText . fst) (C.txIns content))
                unsigned = C.makeSignedTransaction [] body
                result refresh = object ["ok" .= True,"transaction" .= inspect unsigned,"needsRedeemers" .= refresh,"costModels" .= (case toJSON ledgerPP of Object o -> KM.lookup "costModels" o; _ -> Nothing),"inputs" .= ids,"witnessEstimate" .= count,"exUnits" .= map unitsJSON (Map.toList units)]
            require (BS.length (C.serialiseToCBOR unsigned) + fromIntegral count * 101 <= fromIntegral (ledgerPP ^. L.ppMaxTxSizeL)) "Transaction exceeds maxTxSize"
            if minimumFee > finalFee || (not dust && minimumFee /= fee && not (allowDust && bal == mempty)) then run (n+1) base minimumFee units Nothing
            else if maybe False ((/= ids) . sort) expected then pure (result True)
            else if mode /= "local" then pure (result False)
            else do
              evaluated <- evaluateLedger ctx body
              let fingerprint = C.serialiseToCBOR unsigned
              if evaluated == units && previous == Just fingerprint then do
                require (BS.length fingerprint + fromIntegral count * 101 <= fromIntegral (ledgerPP ^. L.ppMaxTxSizeL)) "Transaction exceeds maxTxSize"
                pure (result False)
              else run (n+1) base finalFee evaluated (Just fingerprint)
  mapM_ (\o -> require (BS.length (LB.serialize' (LB.natVersion @10) (C.toMaryValue (outValue o))) <= fromIntegral (ledgerPP ^. L.ppMaxValSizeL)) "Output exceeds maxValueSize") (C.txOuts initial)
  mapM_ (\o -> require (C.unCoin (C.txOutValueToLovelace (case o of C.TxOut _ v _ _ -> v)) >= minimumCoin pp o) "Output below minimum ADA") (C.txOuts initial)
  funded <- if null (C.txIns initial) then addFunds [(C.AdaAssetId,1)] initial else pure initial
  run (0 :: Int) funded minFee supplied Nothing

evaluateRequest :: Value -> IO Value
evaluateRequest v = pure $ either (\e -> object ["ok" .= False,"error" .= e]) id $ parseEither parser v >>= \(ctx,tx) -> do
  values <- evaluateLedger ctx (C.getTxBody tx)
  pure $ object ["ok" .= True,"exUnits" .= map unitsJSON (Map.toList values)]
  where parser = withObject "evaluate" $ \o -> do
          (ctx,_,_,_,_) <- parseContext o
          tx <- o .: "cbor" >>= cbor (C.AsTx C.AsConwayEra)
          pure (ctx,tx)

-- Keep memoized reference-script bytes in both fee calculation and evaluation.
-- Cardano API's SimpleScript value intentionally discards their CBOR encoding.
evaluateLedger ctx body = do
  let C.ShelleyTx _ tx = C.makeSignedTransaction [] body
      LedgerEpochInfo epochInfo = C.toLedgerEpochInfo (ctxHistory ctx)
      evaluated = L.evalTxExUnitsWithLogs (C.unLedgerProtocolParameters (ctxParams ctx)) tx (ctxLedgerUtxo ctx) epochInfo (ctxStart ctx)
  Map.fromList <$> traverse (\(purpose,result) -> do
    (_,units) <- liftE result
    pure (toScriptIndex C.AlonzoEraOnwardsConway purpose,C.fromAlonzoExUnits units)) (Map.toList evaluated)
