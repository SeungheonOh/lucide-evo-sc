{-# LANGUAGE DataKinds, GADTs, OverloadedStrings, ScopedTypeVariables, TypeApplications, FlexibleContexts #-}
module Simulator (simulatorRequest) where
import LiveTx
import Cardano.Api qualified as C
import Cardano.Api.Ledger qualified as L
import Cardano.Api.Query (toLedgerUTxO)
import Cardano.Api.Tx (toShelleyTxOut, fromShelleyTxIn)
import Cardano.Ledger.State qualified as UTxO
import Cardano.Binary qualified as CB
import Cardano.Ledger.Binary qualified as LB
import Cardano.Ledger.Shelley.API (LedgerEnv(..), Coin(..))
import Cardano.Ledger.Shelley.LedgerState (smartUTxOState, lsCertStateL, certDStateL, utxosDonationL, utxosDepositedL, utxosFeesL, utxosGovStateL)
import Cardano.Ledger.Conway.State qualified as LS
import Cardano.Ledger.Core (ppKeyDepositL)
import Cardano.Ledger.DRep (drepDepositL)
import Cardano.Ledger.Compactible (fromCompact, toCompact)
import Cardano.Ledger.Keys (coerceKeyRole)
import Cardano.Ledger.State (ChainAccountState(..), accountsL, accountsMapL)
import Cardano.Slotting.Time (mkSlotLength)
import Convex.MockChain qualified as M
import Convex.MockChain.Defaults qualified as D
import Convex.Class qualified as Class
import Convex.CardanoApi.Lenses qualified as Lens
import Convex.NodeParams (NodeParams(..))
import Control.Lens ((&),(.~),(^.),(%~),ix,_1)
import Control.Monad (forM_, when, unless)
import Data.Default (def)
import Data.Aeson
import Data.Aeson.Types (parseEither, Parser)
import Data.Aeson.KeyMap qualified as KM
import Data.Map.Strict qualified as Map
import Data.Set qualified as Set
import Data.Text qualified as T
import Data.ByteString qualified as BS

-- Snapshot state contains the actual convex-mockchain ledger state, not a JS ledger.
-- It can be persisted across isolated WASI instances and is updated only on success.
simulatorRequest :: Value -> IO Value
simulatorRequest value = case parseEither parse value of
  Left e -> pure $ object ["ok" .= False,"error" .= e]
  Right (operation, chainJSON, params, state, request) -> do
    let respond st extra = object $ ["ok" .= True, "state" .= encodeState st, "chain" .= chainState params chainJSON st, "utxos" .= outputs st, "datums" .= datumJSON st, "accounts" .= accountsJSON params st, "treasury" .= show (treasuryOf st)] <> extra
        failure :: String -> Value
        failure e = object ["ok" .= False,"error" .= e]
    case operation of
      "submit" -> case parseEither (\o -> o .: "cbor" >>= cbor (C.AsTx C.AsConwayEra)) request of
        Left e -> pure (failure e)
        Right tx -> do
          (result,next) <- M.runMockchainT (Class.sendTx tx) params state
          pure $ case result of
            Left e -> failure (show e)
            Right hash -> respond (settleDonations next { M.mcsEnv = (M.mcsEnv next) { ledgerIx = succ (ledgerIx (M.mcsEnv next)) } }) ["txHash" .= C.serialiseToRawBytesHexText hash]
      "reward" -> case parseEither (\o -> intField o "amount") request of
        Left e -> pure (failure e)
        Right amount | amount < 0 -> pure (failure "Negative reward")
        Right amount -> do
          let creds = Map.keys (M.mcsPoolState state ^. lsCertStateL . certDStateL . accountsL . accountsMapL)
              action = forM_ creds $ \cred -> do
                let apiCred = C.fromShelleyStakeCredential cred
                (rewards,pools) <- Class.queryStakeAddresses (Set.singleton apiCred) (npNetworkId params)
                let addr = C.makeStakeAddress (npNetworkId params) apiCred
                when (Map.member addr pools) $ Class.setReward apiCred (Coin amount)
          (_,next) <- M.runMockchainT action params state
          pure (respond next [])
      "setFixtures" -> case parseEither (\o -> do
          utxos <- o .: "utxos" >>= traverse resolvedLedgerOutput
          datums <- o .: "datums" >>= traverse (cbor C.AsHashableScriptData)
          treasury <- intField o "treasury"
          deposit <- maybe (fail "Stake deposit is outside uint64") pure (toCompact (C.unLedgerProtocolParameters (npProtocolParameters params) ^. ppKeyDepositL))
          entries <- o .: "accounts" >>= traverse (withObject "account fixture" $ \a -> do
            C.StakeAddress _ cred <- a .: "address" >>= stakeAddress
            amount <- intField a "rewards"
            compact <- maybe (fail "Reward balance is outside uint64") pure (toCompact (Coin amount))
            poolText <- a .:? "poolId"
            pool <- traverse (\t -> case C.deserialiseFromBech32 t of
              Right (C.StakePoolKeyHash h) -> pure h
              Left _ -> do C.StakePoolKeyHash h <- raw (C.AsHash C.AsStakePoolKey) t; pure h) poolText
            let old = Map.findWithDefault (LS.ConwayAccountState mempty deposit Nothing Nothing) cred (accounts state)
            pure (cred,old & LS.balanceAccountStateL .~ compact & LS.stakePoolDelegationAccountStateL .~ pool))
          pure (utxos,datums,treasury,Map.fromList entries)) request of
        Left e -> pure (failure e)
        Right (utxos,datums,treasury,accts) -> do
          let ledger = UTxO.UTxO (Map.fromList utxos)
              old = M.mcsPoolState state ^. Lens.utxoState
              deposits xs = sum [C.unCoin (fromCompact (a ^. LS.depositAccountStateL)) | a <- Map.elems xs]
              depositDelta = deposits accts - deposits (accounts state)
              pot = Coin (C.unCoin (old ^. utxosDepositedL) + depositDelta)
              nextUtxo = smartUTxOState (C.unLedgerProtocolParameters (npProtocolParameters params)) ledger pot (old ^. utxosFeesL) (old ^. utxosGovStateL) (old ^. utxosDonationL)
              poolFixtures = Map.fromList [(h,def) | a <- Map.elems accts, Just h <- [a ^. LS.stakePoolDelegationAccountStateL]]
              next = state { M.mcsPoolState = M.mcsPoolState state & Lens.utxoState .~ nextUtxo
                    & lsCertStateL . certDStateL . accountsL . accountsMapL .~ accts
                    & lsCertStateL . LS.certPStateL . LS.psStakePoolsL %~ (\pools -> Map.union pools poolFixtures),
                  M.mcsEnv = (M.mcsEnv state) { ledgerAccount = ChainAccountState (Coin treasury) (Coin 0) },
                  M.mcsDatums = Map.fromList [(C.hashScriptDataBytes d,d) | d <- datums] }
          pure (respond next [])
      "setRewards" -> case parseEither (\o -> (o .: "updates" :: Parser [Value]) >>= traverse (withObject "reward update" $ \u -> do
          C.StakeAddress _ cred <- u .: "address" >>= stakeAddress
          amount <- intField u "rewards"
          unless (Map.member cred (accounts state)) (fail "Reward account is not registered")
          compact <- maybe (fail "Reward balance is outside uint64") pure (toCompact (Coin amount))
          pure (cred,compact))) request of
        Left e -> pure (failure e)
        Right updates -> pure $ respond (state { M.mcsPoolState = foldl (\st (cred,amount) -> st & lsCertStateL . certDStateL . accountsL . accountsMapL . ix cred . LS.balanceAccountStateL .~ amount) (M.mcsPoolState state) updates }) []
      "delegation" -> case parseEither (\o -> o .: "address" >>= stakeAddress) request of
        Left e -> pure (failure e)
        Right addr@(C.StakeAddress _ cred) -> do
          ((rewards,pools),_) <- M.runMockchainT (Class.queryStakeAddresses (Set.singleton (C.fromShelleyStakeCredential cred)) (npNetworkId params)) params state
          let C.Quantity reward = Map.findWithDefault 0 addr rewards
          pure $ respond state ["rewards" .= show reward,"poolId" .= fmap C.serialiseToBech32 (Map.lookup addr pools),"registered" .= Map.member addr rewards]
      "init" -> pure (respond state [])
      "query" -> pure (respond state [])
      _ -> pure (failure "Unknown mockchain operation")
  where
    parse = withObject "mockchain request" $ \o -> do
      operation <- o .: "operation" :: Parser String
      chainInput <- o .:? "chain"
      start <- o .:? "systemStart" .!= ("0" :: T.Text)
      overrides <- o .:? "protocolParameters" .!= Object mempty
      let fullParams = mergeJSON overrides (toJSON (C.unLedgerProtocolParameters D.bundledProtocolParameters))
          defaultChain = object ["network" .= ("custom" :: String),"networkMagic" .= (0 :: Int),"systemStart" .= start,"protocolParameters" .= fullParams,
            "eraSummaries" .= [object ["start" .= object ["time" .= (0 :: Int),"slot" .= (0 :: Int),"epoch" .= (0 :: Int)],"end" .= object ["time" .= (432000000000 :: Integer),"slot" .= (432000000000 :: Integer),"epoch" .= (1000000 :: Int)],"parameters" .= object ["slot_length" .= (1 :: Int),"epoch_length" .= (432000 :: Int),"safe_zone" .= (432000000000 :: Integer)]]]]
          chain = maybe defaultChain id chainInput
      dummy <- address ("60" <> T.replicate 56 "0")
      -- parseContext shares exactly the same era and parameter decoding as balancing.
      let contextObject = KM.fromList [("chain",chain),("wallet",object ["utxos" .= ([] :: [Value]),"changeAddress" .= C.serialiseAddress dummy]),("blocks",toJSON ([] :: [Value]))]
      (ctx,_,_,_,_) <- parseContext contextObject
      let params = NodeParams (ctxNetwork ctx) (ctxParams ctx) (ctxStart ctx) (ctxHistory ctx) Set.empty (mkSlotLength 1)
      saved <- o .:? "state"
      initialInputs <- o .:? "utxos" .!= [] >>= traverse resolvedLedgerOutput
      initialPools <- o .:? "stakePools" .!= [] >>= traverse (\text -> case C.deserialiseFromBech32 text of
        Right pool -> pure pool
        Left _ -> raw (C.AsHash C.AsStakePoolKey) text)
      initialDatums <- o .:? "datums" .!= [] >>= traverse (cbor C.AsHashableScriptData)
      treasury <- o .:? "treasury" >>= maybe (pure 0) integerP
      state <- case saved of
        Nothing -> do
          let s = M.initialState params
              ledger = UTxO.UTxO (Map.fromList initialInputs)
              us = smartUTxOState (C.unLedgerProtocolParameters (ctxParams ctx)) ledger (Coin 0) (Coin 0) def (Coin 0)
          pure s { M.mcsPoolState = M.mcsPoolState s & Lens.utxoState .~ us
                     & lsCertStateL . LS.certPStateL . LS.psStakePoolsL .~ Map.fromList [(h,def) | C.StakePoolKeyHash h <- initialPools],
                   M.mcsEnv = (M.mcsEnv s) { ledgerAccount = ChainAccountState (Coin treasury) (Coin 0) },
                   M.mcsDatums = Map.fromList [(C.hashScriptDataBytes d,d) | d <- initialDatums] }
        Just v -> withObject "mockchain state" (\state -> do
          bytes <- state .: "ledger" >>= hexBytes
          ledger <- eitherP (LB.decodeFullDecoder' (LB.natVersion @10) "mockchain ledger" LB.decNoShareCBOR bytes)
          ds <- state .: "datums" >>= traverse (cbor C.AsHashableScriptData)
          t <- intField state "treasury"
          ix <- state .:? "index" .!= 0
          let s = M.initialState params
          pure s { M.mcsPoolState = ledger, M.mcsDatums = Map.fromList [(C.hashScriptDataBytes d,d) | d <- ds], M.mcsEnv = (M.mcsEnv s) { ledgerAccount = ChainAccountState (Coin t) (Coin 0), ledgerIx = toEnum ix } }) v
      slot <- o .:? "slot" >>= maybe (pure 0) integerP
      when (slot < 0) (fail "Negative slot")
      let next = state { M.mcsEnv = (M.mcsEnv state) { ledgerSlotNo = fromInteger slot } }
      pure (operation,chain,params,next,o)

encodeState state = object ["ledger" .= hexText (LB.serialize' (LB.natVersion @10) (M.mcsPoolState state)),"datums" .= map (hexText . C.serialiseToCBOR) (Map.elems (M.mcsDatums state)),"treasury" .= show (case ledgerAccount (M.mcsEnv state) of ChainAccountState (Coin t) _ -> t),"index" .= fromEnum (ledgerIx (M.mcsEnv state))]
datumJSON state = [object ["hash" .= C.serialiseToRawBytesHexText h,"cbor" .= hexText (C.serialiseToCBOR d)] | (h,d) <- Map.toList (M.mcsDatums state)]
outputs state = let UTxO.UTxO utxos = M.mcsPoolState state ^. Lens.utxoState . Lens._UTxOState . _1
                in [object ["input" .= inputText (fromShelleyTxIn i), "cbor" .= hexText (LB.serialize' (LB.natVersion @10) o)] | (i,o) <- Map.toList utxos]

accounts state = M.mcsPoolState state ^. lsCertStateL . certDStateL . accountsL . accountsMapL
coinString :: Coin -> String
coinString (Coin c) = show c
treasuryOf state = case ledgerAccount (M.mcsEnv state) of ChainAccountState (Coin t) _ -> t
-- The Emulator API makes donations available immediately, without an epoch tick.
-- Transfer the donation pot to the mockchain's treasury environment atomically.
settleDonations state =
  let donation = M.mcsPoolState state ^. Lens.utxoState . utxosDonationL
      ChainAccountState treasury reserves = ledgerAccount (M.mcsEnv state)
  in state { M.mcsPoolState = M.mcsPoolState state & Lens.utxoState . utxosDonationL .~ Coin 0,
             M.mcsEnv = (M.mcsEnv state) { ledgerAccount = ChainAccountState (treasury <> donation) reserves } }
accountsJSON params state =
  [object ["address" .= C.serialiseAddress (C.makeStakeAddress (npNetworkId params) (C.fromShelleyStakeCredential cred)),
           "rewards" .= coinString (fromCompact (account ^. LS.balanceAccountStateL)),
           "poolId" .= fmap (C.serialiseToBech32 . C.StakePoolKeyHash) (account ^. LS.stakePoolDelegationAccountStateL)]
  | (cred,account) <- Map.toList (accounts state)]
credentialJSON cred amount = case C.fromShelleyStakeCredential (coerceKeyRole cred) of
  C.StakeCredentialByKey h -> object ["type" .= ("Key" :: String),"hash" .= C.serialiseToRawBytesHexText h,"deposit" .= coinString amount]
  C.StakeCredentialByScript h -> object ["type" .= ("Script" :: String),"hash" .= C.serialiseToRawBytesHexText h,"deposit" .= coinString amount]
chainState params (Object chain) state = Object $ KM.union (KM.fromList
  [("stakePools",toJSON [C.serialiseToRawBytesHexText (C.StakePoolKeyHash h) | h <- Map.keys (M.mcsPoolState state ^. lsCertStateL . LS.certPStateL . LS.psStakePoolsL)]),
   ("stakeDeposits",toJSON [credentialJSON cred (fromCompact (a ^. LS.depositAccountStateL)) | (cred,a) <- Map.toList (accounts state)]),
   ("drepDeposits",toJSON [credentialJSON cred (a ^. drepDepositL) | (cred,a) <- Map.toList (M.mcsPoolState state ^. lsCertStateL . LS.certVStateL . LS.vsDRepsL)])]) chain
chainState _ chain _ = chain
