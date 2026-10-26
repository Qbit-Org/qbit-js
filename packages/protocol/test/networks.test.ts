import { describe, expect, it } from 'vitest'

import { getQbitNetwork, qbitNetworks } from '../src/index'

describe('qbit network parameters', () => {
  it('advertises the exact qbit Core mainnet parameters as ready', () => {
    expect(qbitNetworks.mainnet.mainnetReady).toBe(true)
    expect(getQbitNetwork('mainnet')).toEqual({
      name: 'mainnet',
      bech32Hrp: 'qb',
      p2pPort: 8355,
      rpcPort: 8352,
      mainnetReady: true,
      bip32: {
        public: 0x03f72815,
        private: 0x03f723db,
        publicPrefix: 'qpub',
        privatePrefix: 'qprv',
      },
    })
  })

  it('retains the exact qbit Core Testnet4 parameters', () => {
    expect(getQbitNetwork('testnet4')).toEqual({
      name: 'testnet4',
      bech32Hrp: 'tq',
      p2pPort: 48355,
      rpcPort: 48352,
      mainnetReady: true,
      bip32: {
        public: 0x0435dbad,
        private: 0x0435dc31,
        publicPrefix: 'tqpb',
        privatePrefix: 'tqpv',
      },
    })
  })
})
