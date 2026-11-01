### fix(studio, modules): retry temporary R2 errors

Every R2 call through `studioEnv`, and through each module that binds `R2_RENDERS`, now retries codes 10001, 10043, 10054, 10058 and a lost connection: five attempts over 3.7 to 4.6 s, with jitter. Real errors fail at once. One R2 internal error used to end a film part.

Limits. A conditional put and a stream put are not repeated. Reading a body after `get` is not covered. An outage longer than the backoff still fails what it failed before. A repeated plain put can overwrite a newer write when the first try landed and errored, which is rare.
