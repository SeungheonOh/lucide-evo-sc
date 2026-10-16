{-# LANGUAGE DataKinds #-}
{-# LANGUAGE GADTs #-}
{-# LANGUAGE ImportQualifiedPost #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}
{-# LANGUAGE TypeApplications #-}
module Main (main) where

import Cardano.Api qualified as C
import Control.Exception (SomeException, displayException, try)
import Control.Monad.Except (runExceptT)
import Control.Monad.IO.Class (liftIO)
import Control.Tracer (Tracer (..))
import Convex.BuildTx qualified as Build
import Convex.CoinSelection (BalanceTxError, ChangeOutputPosition (TrailingChange), TxBalancingMessage)
import Convex.MockChain qualified as Mock
import Convex.MockChain.CoinSelection (tryBalanceAndSubmit)
import Convex.MockChain.Defaults qualified as Defaults
import Convex.Wallet qualified as Wallet
import Convex.Wallet.MockWallet qualified as Wallet
import Data.Aeson (Value, eitherDecode, encode, object, (.=))
import Data.ByteString qualified as BS
import Data.ByteString.Base16 qualified as Base16
import Data.ByteString.Lazy.Char8 qualified as BL
import Data.IORef
import Data.Text.Encoding (decodeUtf8)
import LucidBridge (handleRequest)
import MatchingNumber
import PortChecks (portChecks)
import System.Environment (getArgs)
import Text.Read (readMaybe)

summary :: String -> C.Tx C.ConwayEra -> Value
summary label tx = object
  [ "stage" .= label
  , "txId" .= C.serialiseToRawBytesHexText (C.getTxId body)
  , "cborHex" .= decodeUtf8 (Base16.encode bytes)
  , "bytes" .= BS.length bytes
  , "feeLovelace" .= fee
  , "inputs" .= map (show . fst) (C.txIns content)
  , "outputs" .= map output (C.txOuts content)
  , "textEnvelope" .= C.serialiseToTextEnvelope Nothing tx
  , "ledgerAccepted" .= True
  ]
  where
    body = C.getTxBody tx
    content = C.getTxBodyContent body
    bytes = C.serialiseToCBOR tx
    fee = case C.txFee content of C.TxFeeExplicit _ value -> value
    output (C.TxOut address value _ _) = object
      [ "address" .= C.serialiseAddress address
      , "lovelace" .= C.txOutValueToLovelace value
      ]

runScenario :: Integer -> Integer -> Integer -> IO Value
runScenario amount datum redeemer = do
  traces <- newIORef ([] :: [TxBalancingMessage])
  completed <- newIORef ([] :: [Value])
  let tracer = Tracer $ \event -> liftIO $ modifyIORef' traces (event :)
      save name tx = liftIO $ modifyIORef' completed (++ [summary name tx])
      script = C.PlutusScript C.PlutusScriptV2 matchingNumber
      lock = Build.execBuildTx $
        Build.payToScriptDatumHash Defaults.networkId script datum C.NoStakeAddress (C.lovelaceToValue (C.Coin amount))
      action = do
        locked <- tryBalanceAndSubmit tracer Wallet.w1 lock TrailingChange []
        save "lock" locked
        let ref = C.TxIn (C.getTxId (C.getTxBody locked)) (C.TxIx 0)
            spend = Build.execBuildTx $ Build.spendPlutus ref matchingNumber datum redeemer
        redeemed <- tryBalanceAndSubmit tracer Wallet.w1 spend TrailingChange []
        save "redeem" redeemed
  outcome <- try @SomeException $
    Mock.runMockchain0IO [(Wallet.w1, C.Coin 100000000), (Wallet.w2, C.Coin 20000000)] $
      runExceptT @(BalanceTxError C.ConwayEra) action
  events <- reverse <$> readIORef traces
  transactions <- readIORef completed
  let errorMessage = case outcome of
        Left e -> Just (displayException e)
        Right (Left e, _) -> Just (show e)
        Right (Right (), _) -> Nothing
  pure $ object
    [ "ok" .= maybe True (const False) errorMessage
    , "error" .= errorMessage
    , "engine" .= ("sc-tools / GHC WASM / Cardano ledger" :: String)
    , "upstreamCommit" .= ("4546122230491db4839a4a42fc2bc601f7900909" :: String)
    , "network" .= ("browser-local mockchain" :: String)
    , "amountLovelace" .= amount
    , "datum" .= show datum
    , "redeemer" .= show redeemer
    , "validator" .= source
    , "scriptCborHex" .= decodeUtf8 (Base16.encode (C.serialiseToCBOR matchingNumber))
    , "transactions" .= transactions
    , "trace" .= events
    , "portabilityChecks" .= portChecks
    ]

main :: IO ()
main = do
  args <- getArgs
  result <- case args of
    ["json"] -> do
      contents <- BL.getContents
      either (pure . (\e -> object ["ok" .= False, "error" .= e])) handleRequest (eitherDecode contents)
    [a, d, r] | Just amount <- readMaybe a, Just datum <- readMaybe d, Just redeemer <- readMaybe r,
                 amount > 0, amount <= 1000000000000 -> runScenario amount datum redeemer
    _ -> pure $ object ["ok" .= False, "error" .= ("Expected positive lovelace amount, integer datum, integer redeemer" :: String)]
  BL.putStrLn (encode result)
