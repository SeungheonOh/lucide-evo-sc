{-# LANGUAGE OverloadedStrings, ScopedTypeVariables #-}
module LucidBridge (handleRequest) where
import Data.Aeson
import Data.Aeson.Types (parseEither, Parser)
import Data.Scientific (Scientific)
import Cardano.Api qualified as C
import Convex.MockChain.Defaults qualified as D
import Control.Monad (unless)
import Control.Exception (SomeException, try, displayException)
import LiveTx qualified
import Simulator
import LucidBalance
import Ledger (ledgerRequest)
handleRequest :: Value -> IO Value
handleRequest value = do
  result <- try $ case parseEither (withObject "request" (.: "action")) value of
    Right ("ledger" :: String) -> ledgerRequest value
    Right "balanceV2" -> balanceRequest value
    Right "lucidContext" -> pure (contextRequest value)
    Right "mockchain" -> simulatorRequest value
    Right "evaluateV2" -> evaluateRequest value
    Right "capabilities" -> pure $ object ["ok" .= True,"bridgeVersion" .= (2 :: Int)]
    _ -> LiveTx.handleRequest value
  pure $ LiveTx.exactJSON $ either (\e -> object ["ok" .= False,"error" .= displayException (e :: SomeException)]) id result

-- A balancing context contains Lucid's provider parameters and slot mapping.
-- All parameters used for fees, deposits, limits and script evaluation are
-- supplied by Lucid. Defaults fill fields used only by consensus/governance
-- transitions, which balancing never runs. This is not a live node snapshot.
contextRequest value = either (\e -> object ["ok" .= False,"error" .= e]) id (parseEither parser value)
  where parser = withObject "Lucid balancing context" $ \o -> do
          network <- o .: "network" :: Parser String
          unless (network `elem` ["mainnet","preprod","preview","custom"]) (fail "Invalid network")
          overrides <- o .: "protocolParameters"
          slots <- o .: "slotConfig"
          zeroTime <- LiveTx.intField slots "zeroTime"
          zeroSlot <- LiveTx.intField slots "zeroSlot"
          milliseconds <- LiveTx.intField slots "slotLength"
          unless (milliseconds > 0) (fail "Slot length must be positive")
          let length = fromInteger milliseconds / 1000 :: Scientific
              start = fromInteger (zeroTime - zeroSlot * milliseconds) / 1000 :: Scientific
              endSlot = 432000000000 :: Integer
              fullParams = LiveTx.mergeJSON overrides (toJSON (C.unLedgerProtocolParameters D.bundledProtocolParameters))
          params <- C.LedgerProtocolParameters <$> parseJSON (LiveTx.protocolJSON fullParams) :: Parser (C.LedgerProtocolParameters LiveTx.Era)
          pure $ object ["ok" .= True, "chain" .= object
            ["network" .= network,"systemStart" .= show start,"protocolParameters" .= toJSON (C.unLedgerProtocolParameters params),
             "eraSummaries" .= [object ["start" .= object ["time" .= (0 :: Int),"slot" .= (0 :: Int),"epoch" .= (0 :: Int)],
               "end" .= object ["time" .= (fromInteger endSlot * length),"slot" .= endSlot,"epoch" .= (1000000 :: Int)],
               "parameters" .= object ["slot_length" .= length,"epoch_length" .= (432000 :: Int),"safe_zone" .= endSlot]]]]]
