# How the code is laid out

One request travels through four small layers. Each file has one job.

```
public-api.ts      what the package exports: NrkClient and the types it returns
nrk-client.ts      NrkClient: checks arguments, spaces requests, shapes results, never throws
nrk-api.ts         one function per psapi.nrk.no endpoint: fetch, then check the answer's shape
nrk-client-raw.ts  HTTP: fetch with timeout and User-Agent, NrkHttpError, Retry-After
```

Support files:

- `types.ts` the public types, each followed by its validator (and the argument validators).
- `validate.ts`, `validation-error.ts` a small validation toolkit (no dependencies).
- `nrk-format.ts` pure helpers for NRK's strings: dates, durations, image sizes.

Rules that hold everywhere:

- Every value is validated on the way in (NRK's answer) and on the way out (the result).
- `NrkClient` never throws; everything below it throws, and `NrkClient` turns it into an error value.
- Nothing is stored between calls.

`docs/*.json` are NRK's own API descriptions. Tests run offline against recorded answers in
`test/fixtures` (`npm test`); `npm run record` records them again, `npm run test:live` uses the real API.
