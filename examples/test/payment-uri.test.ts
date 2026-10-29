import { describe, expect, it } from 'vitest'

import { createPaymentRequest, readPaymentRequest } from '../src/payment-uri'

const ADDRESS = 'qbrt1zzasx2u2z7v9kn4q8e66r57mfw08xvrvdcqfcq6xfte0eau9dgdgqz42zd5'

describe('payment-uri example', () => {
  it('round-trips a payment request', () => {
    const uri = createPaymentRequest(ADDRESS)
    expect(uri).toBe(`qbit:${ADDRESS}?amount=0.5&label=Coffee%20shop&message=1%2B1%3D2`)

    const read = readPaymentRequest(uri)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.request).toMatchObject({
      address: ADDRESS,
      network: 'regtest',
      amount: '0.5',
      label: 'Coffee shop',
      message: '1+1=2',
    })
  })

  it('lowercases an address written in uppercase for a QR code', () => {
    const read = readPaymentRequest(`QBIT:${ADDRESS.toUpperCase()}?amount=1`)
    expect(read).toMatchObject({ ok: true, request: { address: ADDRESS, amount: '1' } })
  })

  it.each([
    ['two amounts', `qbit:${ADDRESS}?amount=1&amount=1000`, 'INVALID_URI'],
    ['a bitcoin: URI', `bitcoin:${ADDRESS}?amount=1`, 'WRONG_URI_SCHEME'],
    [
      'an address on another network',
      'qbit:qb1zzasx2u2z7v9kn4q8e66r57mfw08xvrvdcqfcq6xfte0eau9dgdgqhr7u97?amount=1',
      'WRONG_HRP',
    ],
  ])('rejects %s', (_, uri, code) => {
    expect(readPaymentRequest(uri)).toMatchObject({ ok: false, code })
  })
})
