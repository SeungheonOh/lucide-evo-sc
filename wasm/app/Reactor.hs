{-# LANGUAGE ForeignFunctionInterface #-}
{-# LANGUAGE OverloadedStrings #-}
module Main where

import Control.Exception (SomeException, try, evaluate, displayException)
import Data.Aeson (eitherDecodeStrict, encode, object, (.=))
import Data.ByteString qualified as BS
import Data.ByteString.Lazy qualified as BL
import Data.IORef
import Foreign.C.Types
import Foreign.Marshal.Alloc (mallocBytes)
import Foreign.Marshal.Utils (copyBytes)
import Foreign.Ptr
import LucidBridge (handleRequest)
import System.IO.Unsafe (unsafePerformIO)

{-# NOINLINE resultLength #-}
resultLength :: IORef CSize
resultLength = unsafePerformIO (newIORef 0)

foreign export ccall "lucid_run" lucidRun :: Ptr CChar -> CSize -> IO (Ptr CChar)
foreign export ccall "lucid_result_len" lucidResultLength :: IO CSize

lucidRun :: Ptr CChar -> CSize -> IO (Ptr CChar)
lucidRun pointer length = do
  input <- BS.packCStringLen (pointer, fromIntegral length)
  encoded <- try $ do
    result <- either (pure . (\e -> object ["ok" .= False, "error" .= e])) handleRequest (eitherDecodeStrict input)
    evaluate (BL.toStrict (encode result))
  let bytes = either (\exception -> BL.toStrict (encode (object ["ok" .= False, "error" .= displayException (exception :: SomeException)]))) id encoded
  output <- mallocBytes (BS.length bytes)
  BS.useAsCStringLen bytes $ \(source, size) -> copyBytes output source size
  writeIORef resultLength (fromIntegral (BS.length bytes))
  pure output

lucidResultLength :: IO CSize
lucidResultLength = readIORef resultLength

main :: IO ()
main = pure ()
