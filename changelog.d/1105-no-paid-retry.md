### fix(modules): a failure after the provider succeeds no longer buys the run again

The cloud video doors did the model call, the parse, the download and the R2 write in one retried workflow step, so a failure after a paid success bought the clip up to three times. The call is now its own step, the parse runs once, and the download and write retry on their own step without reaching the provider. A failed parse or store fails the render with a clear error. A provider call that throws still retries.
