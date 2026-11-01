### fix(studio): a temporary R2 error no longer fails a film part

Every R2 call through `studioEnv` now retries codes 10001, 10043, 10058 and a lost connection, five attempts over about 3.7 s. Real errors fail at once. A conditional put and a stream body are not repeated. One R2 internal error used to end a part, because core turns any throw in a tick into a terminal failure. An outage longer than the backoff still does that.
