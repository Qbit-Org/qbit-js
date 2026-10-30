import { QbitProtocolError } from './errors'
import type { parseQbitUri } from './uri'

/**
 * Name of a network in {@link qbitNetworks}: qbit mainnet, Testnet4, signet or
 * regtest.
 *
 * @remarks
 * See [Features](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/features.md).
 *
 * @category Networks
 */
export type QbitNetworkName = 'mainnet' | 'testnet4' | 'signet' | 'regtest'

/**
 * Parameters of a qbit network: its address HRP, default ports and BIP32
 * extended-key versions. {@link qbitNetworks} holds the four built-in sets.
 *
 * @remarks
 * Functions that take a network accept a {@link QbitNetworkName} or a
 * `QbitNetworkParams` object, except {@link parseQbitUri}, which takes a
 * name; {@link getQbitNetwork} returns an object as given, without checking
 * it. See [Features](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/features.md).
 *
 * @category Networks
 */
export interface QbitNetworkParams {
  /** The network's name. */
  name: QbitNetworkName
  /** Human-readable part of the network's bech32m addresses, such as `qb` on mainnet. */
  bech32Hrp: string
  /** Default peer-to-peer port. */
  p2pPort: number
  /** Default JSON-RPC port. */
  rpcPort: number
  /**
   * `true` when these SDK parameters match qbit Core v1.0.0 chainparams
   * (src/kernel/chainparams.cpp, src/chainparamsbase.cpp:46-54) and are
   * supported for production use.
   *
   * This does NOT mean "is mainnet": it is `true` for all four networks. To
   * identify mainnet, check `name === 'mainnet'` or `bech32Hrp === 'qb'`.
   */
  mainnetReady: boolean
  /** BIP32 extended-key version bytes and the Base58 prefixes they produce. */
  bip32: {
    /** Version bytes of extended public keys, as a big-endian uint32. */
    public: number
    /** Version bytes of extended private keys, as a big-endian uint32. */
    private: number
    /** Base58 prefix of extended public keys, such as `qpub` on mainnet. */
    publicPrefix: string
    /** Base58 prefix of extended private keys, such as `qprv` on mainnet. */
    privatePrefix: string
  }
}

/**
 * The parameters of qbit mainnet, Testnet4, signet and regtest, keyed by
 * {@link QbitNetworkName}.
 *
 * @remarks
 * Testnet4 and signet share the `tq` address HRP and the `tqpb`/`tqpv`
 * extended-key versions, so neither an address nor an extended key tells them
 * apart. See [Features](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/features.md).
 *
 * @category Networks
 */
export const qbitNetworks = {
  /** qbit mainnet. */
  mainnet: {
    /** The network's name. */
    name: 'mainnet',
    /** Human-readable part of the network's bech32m addresses, which start with `qb1`. */
    bech32Hrp: 'qb',
    /** Default peer-to-peer port. */
    p2pPort: 8355,
    /** Default JSON-RPC port. */
    rpcPort: 8352,
    /** Not a mainnet flag: `true` on every network. See {@link QbitNetworkParams.mainnetReady}. */
    mainnetReady: true,
    /** BIP32 extended-key version bytes and the Base58 prefixes they produce. */
    bip32: {
      /** Version bytes of extended public keys (`qpub`), as a big-endian uint32. */
      public: 0x03f72815,
      /** Version bytes of extended private keys (`qprv`), as a big-endian uint32. */
      private: 0x03f723db,
      /** Base58 prefix of extended public keys. */
      publicPrefix: 'qpub',
      /** Base58 prefix of extended private keys. */
      privatePrefix: 'qprv',
    },
  },
  /** qbit Testnet4. */
  testnet4: {
    /** The network's name. */
    name: 'testnet4',
    /** Human-readable part of the network's bech32m addresses, which start with `tq1`, as signet's do. */
    bech32Hrp: 'tq',
    /** Default peer-to-peer port. */
    p2pPort: 48355,
    /** Default JSON-RPC port. */
    rpcPort: 48352,
    /** Not a mainnet flag: `true` on every network. See {@link QbitNetworkParams.mainnetReady}. */
    mainnetReady: true,
    /** BIP32 extended-key version bytes and the Base58 prefixes they produce, shared by Testnet4 and signet. */
    bip32: {
      /** Version bytes of extended public keys (`tqpb`), as a big-endian uint32. */
      public: 0x0435dbad,
      /** Version bytes of extended private keys (`tqpv`), as a big-endian uint32. */
      private: 0x0435dc31,
      /** Base58 prefix of extended public keys. */
      publicPrefix: 'tqpb',
      /** Base58 prefix of extended private keys. */
      privatePrefix: 'tqpv',
    },
  },
  /** qbit signet. */
  signet: {
    /** The network's name. */
    name: 'signet',
    /** Human-readable part of the network's bech32m addresses, which start with `tq1`, as Testnet4's do. */
    bech32Hrp: 'tq',
    /** Default peer-to-peer port. */
    p2pPort: 38355,
    /** Default JSON-RPC port. */
    rpcPort: 38352,
    /** Not a mainnet flag: `true` on every network. See {@link QbitNetworkParams.mainnetReady}. */
    mainnetReady: true,
    /** BIP32 extended-key version bytes and the Base58 prefixes they produce, shared by Testnet4 and signet. */
    bip32: {
      /** Version bytes of extended public keys (`tqpb`), as a big-endian uint32. */
      public: 0x0435dbad,
      /** Version bytes of extended private keys (`tqpv`), as a big-endian uint32. */
      private: 0x0435dc31,
      /** Base58 prefix of extended public keys. */
      publicPrefix: 'tqpb',
      /** Base58 prefix of extended private keys. */
      privatePrefix: 'tqpv',
    },
  },
  /** qbit regtest. */
  regtest: {
    /** The network's name. */
    name: 'regtest',
    /** Human-readable part of the network's bech32m addresses, which start with `qbrt1`. */
    bech32Hrp: 'qbrt',
    /** Default peer-to-peer port. */
    p2pPort: 18460,
    /** Default JSON-RPC port. */
    rpcPort: 18452,
    /** Not a mainnet flag: `true` on every network. See {@link QbitNetworkParams.mainnetReady}. */
    mainnetReady: true,
    /** BIP32 extended-key version bytes and the Base58 prefixes they produce. */
    bip32: {
      /** Version bytes of extended public keys (`qrpb`), as a big-endian uint32. */
      public: 0x03f7d7b5,
      /** Version bytes of extended private keys (`qrpv`), as a big-endian uint32. */
      private: 0x03f7d83a,
      /** Base58 prefix of extended public keys. */
      publicPrefix: 'qrpb',
      /** Base58 prefix of extended private keys. */
      privatePrefix: 'qrpv',
    },
  },
} as const satisfies Record<QbitNetworkName, QbitNetworkParams>

/**
 * Resolve a network name to its parameters.
 *
 * @param network - A {@link QbitNetworkName}, or a {@link QbitNetworkParams}
 * object, which is returned as given without being checked.
 * @returns The network's entry in {@link qbitNetworks}, or `network` itself
 * when it is an object.
 * @throws {QbitProtocolError} `UNKNOWN_NETWORK` if `network` is a string that
 * is not one of the four network names, except a name `Object.prototype`
 * defines, such as `'toString'`, `'constructor'` or `'__proto__'`: the lookup
 * returns that prototype member instead of throwing.
 *
 * @remarks
 * See [Features](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/features.md).
 *
 * @category Networks
 */
export function getQbitNetwork(network: QbitNetworkName | QbitNetworkParams): QbitNetworkParams {
  if (typeof network !== 'string') return network
  const params = qbitNetworks[network]
  if (params === undefined) {
    throw new QbitProtocolError('UNKNOWN_NETWORK', `unknown qbit network: ${network}`)
  }
  return params
}

function networkNameForHrp(hrp: string): QbitNetworkName | undefined {
  for (const params of Object.values(qbitNetworks)) {
    if (params.bech32Hrp === hrp) return params.name
  }
  return undefined
}

export { networkNameForHrp }
