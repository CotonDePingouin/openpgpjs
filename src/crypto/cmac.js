/**
 * @fileoverview This module implements AES-CMAC on top of
 * native AES-CBC using either the WebCrypto API or Node.js' crypto API.
 * @module crypto/cmac
 */

import { cbc as nobleAesCbc } from '@noble/ciphers/aes';
import util from '../util';

const webCrypto = util.getWebCrypto();
const nodeCrypto = util.getNodeCrypto();


/**
 * This implementation of CMAC is based on the description of OMAC in
 * http://web.cs.ucdavis.edu/~rogaway/papers/eax.pdf. As per that
 * document:
 *
 * We have made a small modification to the OMAC algorithm as it was
 * originally presented, changing one of its two constants.
 * Specifically, the constant 4 at line 85 was the constant 1/2 (the
 * multiplicative inverse of 2) in the original definition of OMAC [14].
 * The OMAC authors indicate that they will promulgate this modification
 * [15], which slightly simplifies implementations.
 */

const blockLength = 16;


/**
 * xor `padding` into the end of `data`. This function implements "the
 * operation xor→ [which] xors the shorter string into the end of longer
 * one". Since data is always as least as long as padding, we can
 * simplify the implementation.
 * @param {Uint8Array} data
 * @param {Uint8Array} padding
 */
function rightXORMut(data, padding) {
  const offset = data.length - blockLength;
  for (let i = 0; i < blockLength; i++) {
    data[i + offset] ^= padding[i];
  }
  return data;
}

function pad(data, padding, padding2) {
  // if |M| in {n, 2n, 3n, ...}
  if (data.length && data.length % blockLength === 0) {
    // then return M xor→ B,
    return rightXORMut(data, padding);
  }
  // else return (M || 10^(n−1−(|M| mod n))) xor→ P
  const padded = new Uint8Array(data.length + (blockLength - (data.length % blockLength)));
  padded.set(data);
  padded[data.length] = 0b10000000;
  return rightXORMut(padded, padding2);
}

const zeroBlock = new Uint8Array(blockLength);

export default async function CMAC(key) {
  const cbc = await CBC(key);

  // L ← E_K(0^n); B ← 2L; P ← 4L
  const padding = util.double(await cbc(zeroBlock));
  const padding2 = util.double(padding);

  return async function(data) {
    // return CBC_K(pad(M; B, P))
    return (await cbc(pad(data, padding, padding2))).subarray(-blockLength);
  };
}

async function CBC(key) {
  if (util.getNodeCrypto()) { // Node crypto library
    return async function(pt) {
      const en = new nodeCrypto.createCipheriv('aes-' + (key.length * 8) + '-cbc', key, zeroBlock);
      const ct = en.update(pt);
      return new Uint8Array(ct);
    };
  }

  if (util.getWebCrypto()) {
    try {
      key = await webCrypto.importKey('raw', key, { name: 'AES-CBC', length: key.length * 8 }, false, ['encrypt']);
      return async function(pt) {
        const ct = await webCrypto.encrypt({ name: 'AES-CBC', iv: zeroBlock, length: blockLength * 8 }, key, pt);
        return new Uint8Array(ct).subarray(0, ct.byteLength - blockLength);
      };
    } catch (err) {
      // no 192 bit support in Chromium, which throws `OperationError`, see: https://www.chromium.org/blink/webcrypto#TOC-AES-support
      if (err.name !== 'NotSupportedError' &&
        !(key.length === 24 && err.name === 'OperationError')) {
        throw err;
      }
      util.printDebugError('Browser did not support operation: ' + err.message);
    }
  }

  return async function(pt) {
    return nobleAesCbc(key, zeroBlock, { disablePadding: true }).encrypt(pt);
  };
}
