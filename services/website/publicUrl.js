import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { httpError } from '../../utils/httpError.js';

const TRACKING_PARAMETERS = new Set([
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src'
]);
const BLOCKED_EXTENSIONS = /\.(?:7z|avi|avif|bmp|css|csv|docx?|eot|epub|exe|gif|gz|ico|jpe?g|js|json|m4a|m4v|mov|mp3|mp4|mpeg|ogg|otf|pdf|png|pptx?|rar|rss|svg|tar|tiff?|ts|txt|wav|webm|webp|woff2?|xlsx?|xml|zip)$/i;
const BLOCKED_ACTION_PATHS = /\/(?:log-?out|sign-?out|delete|remove-account)(?:\/|$)/i;

export async function assertPublicHttpUrl(input, options = {}) {
  let url;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(String(input || ''));
  } catch {
    throw httpError(400, 'Enter a valid website URL.');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw httpError(400, 'Website URL must use http or https.');
  }
  if (url.username || url.password) {
    throw httpError(400, 'Website URLs containing credentials are not allowed.');
  }
  if (options.allowedOrigin && url.origin !== options.allowedOrigin) {
    throw httpError(400, 'Only pages from the discovered website can be captured.');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw httpError(400, 'Private, local, and reserved network addresses are not allowed.');
  }
  const lookupFn = options.lookupFn || lookup;
  let addresses;
  try {
    addresses = await lookupFn(hostname, { all: true, verbatim: true });
  } catch {
    throw httpError(400, 'The website hostname could not be resolved.');
  }
  if (!addresses?.length || addresses.some(({ address }) => isPrivateOrReservedIp(address))) {
    throw httpError(400, 'Private, local, and reserved network addresses are not allowed.');
  }
  return url;
}

export function normalizeInternalUrl(input, baseUrl, allowedOrigin) {
  let url;
  try {
    url = new URL(String(input || ''), baseUrl);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== allowedOrigin) return null;
  if (url.username || url.password || url.href.length > 2048) return null;
  if (BLOCKED_EXTENSIONS.test(url.pathname) || BLOCKED_ACTION_PATHS.test(url.pathname)) return null;

  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMETERS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/{2,}/g, '/');
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}

export function isPrivateOrReservedIp(address) {
  const value = String(address || '').toLowerCase().split('%')[0];
  const version = net.isIP(value);
  if (version === 4) return isPrivateIpv4(value);
  if (version !== 6) return true;

  if (value === '::' || value === '::1') return true;
  if (/^(?:fc|fd)/.test(value) || /^fe[89ab]/.test(value) || /^ff/.test(value)) return true;
  if (/^2001:db8(?::|$)/.test(value)) return true;
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  const mappedHex = value.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isPrivateIpv4([
      high >> 8,
      high & 255,
      low >> 8,
      low & 255
    ].join('.'));
  }
  return false;
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}
