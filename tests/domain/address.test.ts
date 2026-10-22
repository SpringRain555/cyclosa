/**
 * 哪些位址算公開網路（ADR-0038）。**每一種繞法都要有一列** ——
 * 少判一種，就是一條讓網頁轉址打進本機的路。
 */
import { describe, expect, it } from 'vitest';

import { addressScope } from '../../src/domain/ingest/address.js';

describe('addressScope', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['0.0.0.0', 'unspecified'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local'],
    ['100.64.0.1', 'shared'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1%eth0', 'link-local'],
    ['fd12:3456::1', 'private'],
    ['ff02::1', 'multicast'],
    // IPv4 包在 IPv6 裡：照裡面那個判，不然就是繞過 IPv4 規則的路
    ['::ffff:127.0.0.1', 'loopback'],
    ['[::ffff:7f00:1]', 'loopback'],
    ['::ffff:192.168.0.10', 'private'],
    ['64:ff9b::a9fe:a9fe', 'link-local'],
  ])('%s → %s', (ip, scope) => {
    expect(addressScope(ip)).toBe(scope);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
  ])('%s 是公開位址', (ip) => {
    expect(addressScope(ip)).toBe('public');
  });

  it.each(['', 'localhost', '1.2.3', '256.1.1.1', '1:2:3:4:5:6:7:8:9', '::1::', 'example.com'])(
    '認不得的 %j 不當公開位址',
    (text) => {
      expect(addressScope(text)).toBe('invalid');
    },
  );
});
