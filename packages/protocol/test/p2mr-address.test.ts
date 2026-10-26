import { describe, expect, it } from 'vitest'

import {
  QbitProtocolError,
  addDescriptorChecksum,
  addressToScriptPubKey,
  bytesToHex,
  decodeP2mrAddress,
  descriptorChecksum,
  encodeP2mrAddress,
  formatQbitUri,
  hexToBytes,
  outputScriptToAddress,
  p2mrAddressFromRoot,
  p2mrScriptPubKey,
  parseQbitUri,
  qbitNetworks,
} from '../src/index'

const RAW_ROOT = hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')
const DESCRIPTOR_ROOT = hexToBytes(
  'b6c785589cc97898d4ca2a044d63d1dd48714693ce7a0038b4fd3baafb32afe9'
)

describe('P2MR address codec', () => {
  it('matches qbit Core rawmr address vectors', () => {
    expect(p2mrAddressFromRoot(RAW_ROOT, 'mainnet')).toBe(
      'qb1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sjq57mw'
    )
    expect(p2mrAddressFromRoot(RAW_ROOT, 'regtest')).toBe(
      'qbrt1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s8kqqny'
    )
  })

  it('matches qbit Core descriptor expansion address vector', () => {
    expect(p2mrAddressFromRoot(DESCRIPTOR_ROOT, 'regtest')).toBe(
      'qbrt1zkmrc2kyue9uf34x29gzy6c73m4y8z35neeaqqw95l5a647ej4l5suqqg6f'
    )
  })

  it('keeps mainnet and Testnet4 addresses distinct and rejects cross-network decoding', () => {
    const mainnetAddress = p2mrAddressFromRoot(RAW_ROOT, 'mainnet')
    const testnet4Address = p2mrAddressFromRoot(RAW_ROOT, 'testnet4')

    expect(mainnetAddress).toMatch(/^qb1z/)
    expect(testnet4Address).toMatch(/^tq1z/)
    expect(mainnetAddress).not.toBe(testnet4Address)
    expect(() => decodeP2mrAddress(mainnetAddress, 'testnet4')).toThrow(QbitProtocolError)
    expect(() => decodeP2mrAddress(testnet4Address, 'mainnet')).toThrow(QbitProtocolError)
  })

  it('round-trips P2MR scriptPubKey and address', () => {
    const address = encodeP2mrAddress(RAW_ROOT, qbitNetworks.regtest)
    const scriptPubKey = p2mrScriptPubKey(RAW_ROOT)

    expect(bytesToHex(scriptPubKey)).toBe(
      '5220000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
    )
    expect(bytesToHex(addressToScriptPubKey(address, 'regtest'))).toBe(bytesToHex(scriptPubKey))
    expect(outputScriptToAddress(scriptPubKey, 'regtest')).toBe(address)
  })

  it('preserves explicit signet context for shared tq HRP addresses', () => {
    const address = encodeP2mrAddress(RAW_ROOT, 'signet')

    expect(decodeP2mrAddress(address).network).toBe('testnet4')
    expect(decodeP2mrAddress(address, 'testnet4').network).toBe('testnet4')
    expect(decodeP2mrAddress(address, 'signet').network).toBe('signet')
  })

  it('strictly rejects wrong HRP, checksum family, witness version, and program length', () => {
    const address = p2mrAddressFromRoot(RAW_ROOT, 'regtest')

    expect(() => decodeP2mrAddress(address, 'mainnet')).toThrow(QbitProtocolError)
    expect(() =>
      decodeP2mrAddress('qbrt1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sfy8ykg')
    ).toThrow(QbitProtocolError)
    expect(() => decodeP2mrAddress('qbrt1z2rkskwvnm8')).toThrow(QbitProtocolError)
    expect(() => decodeP2mrAddress(address.slice(0, -1) + 'x')).toThrow(QbitProtocolError)
  })

  it('parses and formats qbit payment URIs', () => {
    const address = p2mrAddressFromRoot(RAW_ROOT, 'mainnet')
    const uri = formatQbitUri({
      address,
      amount: '1.25000001',
      label: 'Savings',
      message: 'P2MR receive',
    })
    const parsed = parseQbitUri(uri, 'mainnet')

    expect(uri).toBe(`qbit:${address}?amount=1.25000001&label=Savings&message=P2MR%20receive`)
    expect(parsed.address).toBe(address)
    expect(parsed.network).toBe('mainnet')
    expect(parsed.amount).toBe('1.25000001')
    expect(parsed.label).toBe('Savings')
    expect(parsed.message).toBe('P2MR receive')
    expect(() => parseQbitUri(`bitcoin:${address}`)).toThrow(QbitProtocolError)
    expect(() => parseQbitUri(`qbit://${address}`)).toThrow(QbitProtocolError)
    expect(() => formatQbitUri({ address, amount: '1.000000001' })).toThrow(QbitProtocolError)
  })

  it('matches qbit Core descriptor checksum vectors', () => {
    const descriptor =
      "sh(multi(2,[00000000/111'/222]qpubUshNuiPaMcSTQ5GNQyArHA6ivddC7H7JHWe1KNpLDAeMuguxqi4m9QbnPZo9Fc4PAj9LfR6hRMnwfJqBokTxuvWTjriSJkkT2qQMnVc6LKM,qpubUmemoNawQ2YiVy6ip8fWfoPvVfFecNUjQsbs4vEmYNQUsWQAV1rVPoWhWydzGVQVzit97Aj9Gwv3Aoh1Krias5AGrtgUZFm5Ws9AuxW2WD6/0))"

    expect(descriptorChecksum(descriptor)).toBe('94l6a0y8')
    expect(addDescriptorChecksum(descriptor)).toBe(`${descriptor}#94l6a0y8`)
    expect(() => addDescriptorChecksum(`${descriptor}#94l6a0y8`)).toThrow(QbitProtocolError)
    expect(() => descriptorChecksum('raw(Ü)')).toThrow(QbitProtocolError)
  })
})
