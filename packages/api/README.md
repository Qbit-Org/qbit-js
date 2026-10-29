# @qbit-oss/api

Typed [esplora](https://github.com/Blockstream/esplora/blob/master/API.md) REST
client for qbit wallets and apps. Talks to an electrs/esplora endpoint
**directly** against a configurable per-chain base URL — no centralized facade.

```ts
import { EsploraClient } from '@qbit-oss/api'

const client = new EsploraClient({ baseUrl: 'https://esplora.example/regtest/api' })

const balance = await client.getAddressBalance(address) // { confirmedSats, mempoolSats, totalSats }
const utxos = await client.getAddressUtxos(address)
const history = await client.getAddressHistory(address) // { confirmed, mempool }
const fees = await client.getFeeTiers() // [{ target, feeRate }] ascending
const txid = await client.broadcastTx(rawTxHex) // see docs/broadcasting.md
```

`MempoolQbitClient`, its fee adapters and its address-history pagination: see [docs/endpoints.md](docs/endpoints.md#mempoolqbitclient).

Complete address-history scans: see [docs/address-history.md](docs/address-history.md).

Broadcasting: see [docs/broadcasting.md](docs/broadcasting.md).

Endpoints: see [docs/endpoints.md](docs/endpoints.md).

Resilience: see [docs/resilience.md](docs/resilience.md).

Redirects and transport security: see [docs/transport-security.md](docs/transport-security.md).

Logging errors: see [docs/logging-and-redaction.md](docs/logging-and-redaction.md).

Scope: see [docs/endpoints.md](docs/endpoints.md#scope).

Response validation: see [docs/response-validation.md](docs/response-validation.md).

Configuration: see [docs/configuration.md](docs/configuration.md).
