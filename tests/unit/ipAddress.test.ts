import { describe, expect, it } from 'vitest';
import { classifyIp, isPublicIp } from '../../src/security/ipAddress.js';

describe('classifyIp', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'cloud-metadata'],
    ['169.254.10.10', 'link-local'],
    ['100.100.100.200', 'cloud-metadata'],
    ['100.64.0.1', 'carrier-grade-nat'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['198.18.0.1', 'reserved'],
    ['192.0.2.10', 'documentation'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456::1', 'unique-local'],
    ['fd00:ec2::254', 'cloud-metadata'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['not-an-ip', 'invalid'],
  ])('%s -> %s', (address, expected) => {
    expect(classifyIp(address)).toBe(expected);
  });

  it('checks IPv4 addresses embedded in IPv6 forms', () => {
    expect(classifyIp('::ffff:127.0.0.1')).toBe('loopback');
    expect(classifyIp('::ffff:7f00:1')).toBe('loopback');
    expect(classifyIp('::ffff:169.254.169.254')).toBe('cloud-metadata');
    expect(classifyIp('64:ff9b::10.0.0.1')).toBe('private');
    expect(classifyIp('2002:c0a8:0101::1')).toBe('private'); // 6to4 of 192.168.1.1
    expect(classifyIp('::ffff:8.8.8.8')).toBe('public');
  });

  it('treats ordinary public addresses as public', () => {
    expect(isPublicIp('8.8.8.8')).toBe(true);
    expect(isPublicIp('1.1.1.1')).toBe(true);
    expect(isPublicIp('2606:4700:4700::1111')).toBe(true);
    expect(isPublicIp('172.32.0.1')).toBe(true); // just outside 172.16/12
  });
});
