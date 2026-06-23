"use strict";
/**
 * AICQ SDK — Crypto module
 * Ed25519 signing, X25519 key exchange, and NaCl secret/box encryption
 * powered by tweetnacl.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateSigningKeypair = generateSigningKeypair;
exports.derivePublicKeyFromSecret = derivePublicKeyFromSecret;
exports.sign = sign;
exports.verify = verify;
exports.generateExchangeKeypair = generateExchangeKeypair;
exports.encrypt = encrypt;
exports.decrypt = decrypt;
exports.boxEncrypt = boxEncrypt;
exports.boxDecrypt = boxDecrypt;
exports.generateNonce = generateNonce;
exports.computeFingerprint = computeFingerprint;
const tweetnacl_1 = __importDefault(require("tweetnacl"));
const tweetnacl_util_1 = __importDefault(require("tweetnacl-util"));
// ─── Hex encode / decode utilities ───
function hexEncode(bytes) {
    return Buffer.from(bytes).toString("hex");
}
function hexDecode(hex) {
    return Uint8Array.from(Buffer.from(hex, "hex"));
}
// ─── Signing (Ed25519) ───
/**
 * Generate an Ed25519 signing keypair.
 * @returns [publicKeyHex, secretKeyHex]
 */
function generateSigningKeypair() {
    const keypair = tweetnacl_1.default.sign.keyPair();
    return [hexEncode(keypair.publicKey), hexEncode(keypair.secretKey)];
}
/**
 * Derive the Ed25519 public key (hex) from a 64-byte secret key (hex).
 * Used by one-shot invocation helpers where the caller only has the
 * secret key (e.g. InvokeAgentStream / invokeAgentStream).
 *
 * @param secretKeyHex - 128-char hex Ed25519 secret key
 * @returns 64-char hex Ed25519 public key
 */
function derivePublicKeyFromSecret(secretKeyHex) {
    const secretKey = hexDecode(secretKeyHex);
    if (secretKey.length !== 64) {
        throw new Error(`Invalid Ed25519 secret key length: expected 64 bytes (128 hex chars), got ${secretKey.length} bytes`);
    }
    // tweetnacl's sign.keyPair.fromSecretKey expects the 64-byte expanded form
    // and returns the corresponding 32-byte public key.
    const keypair = tweetnacl_1.default.sign.keyPair.fromSecretKey(secretKey);
    return hexEncode(keypair.publicKey);
}
/**
 * Sign a message with an Ed25519 secret key.
 * @param message  - Plaintext message to sign
 * @param secretKeyHex - Hex-encoded 64-byte Ed25519 secret key
 * @returns Hex-encoded signature
 */
function sign(message, secretKeyHex) {
    const secretKey = hexDecode(secretKeyHex);
    const messageBytes = tweetnacl_util_1.default.decodeUTF8(message);
    const signature = tweetnacl_1.default.sign.detached(messageBytes, secretKey);
    return hexEncode(signature);
}
/**
 * Verify an Ed25519 signature.
 * @param message - Original plaintext message
 * @param signatureHex - Hex-encoded signature
 * @param publicKeyHex - Hex-encoded 32-byte Ed25519 public key
 * @returns true if valid
 */
function verify(message, signatureHex, publicKeyHex) {
    const publicKey = hexDecode(publicKeyHex);
    const signature = hexDecode(signatureHex);
    const messageBytes = tweetnacl_util_1.default.decodeUTF8(message);
    return tweetnacl_1.default.sign.detached.verify(messageBytes, signature, publicKey);
}
// ─── Key Exchange (X25519 / Curve25519) ───
/**
 * Generate an X25519 key exchange keypair.
 * @returns [publicKeyHex, secretKeyHex]
 */
function generateExchangeKeypair() {
    const keypair = tweetnacl_1.default.box.keyPair();
    return [hexEncode(keypair.publicKey), hexEncode(keypair.secretKey)];
}
// ─── Symmetric Encryption (XSalsa20-Poly1305) ───
/**
 * Encrypt plaintext using NaCl secretbox (XSalsa20-Poly1305).
 * @param plaintext - Message to encrypt
 * @param nonceHex - 24-byte hex nonce
 * @param keyHex - 32-byte hex key
 * @returns Hex-encoded ciphertext
 */
function encrypt(plaintext, nonceHex, keyHex) {
    const nonce = hexDecode(nonceHex);
    const key = hexDecode(keyHex);
    const messageBytes = tweetnacl_util_1.default.decodeUTF8(plaintext);
    const ciphertext = tweetnacl_1.default.secretbox(messageBytes, nonce, key);
    if (!ciphertext) {
        throw new Error("Encryption failed — invalid key or nonce length");
    }
    return hexEncode(ciphertext);
}
/**
 * Decrypt ciphertext using NaCl secretbox (XSalsa20-Poly1305).
 * @param ciphertextHex - Hex-encoded ciphertext
 * @param nonceHex - 24-byte hex nonce
 * @param keyHex - 32-byte hex key
 * @returns Decrypted plaintext
 */
function decrypt(ciphertextHex, nonceHex, keyHex) {
    const nonce = hexDecode(nonceHex);
    const key = hexDecode(keyHex);
    const ciphertext = hexDecode(ciphertextHex);
    const plaintext = tweetnacl_1.default.secretbox.open(ciphertext, nonce, key);
    if (!plaintext) {
        throw new Error("Decryption failed — invalid ciphertext, nonce, or key");
    }
    return tweetnacl_util_1.default.encodeUTF8(plaintext);
}
// ─── Asymmetric Box Encryption (X25519 + XSalsa20-Poly1305) ───
/**
 * Encrypt using NaCl box (authenticated public-key encryption).
 * @param plaintext - Message to encrypt
 * @param nonceHex - 24-byte hex nonce
 * @param senderSecHex - Sender's 32-byte X25519 secret key (hex)
 * @param recipientPubHex - Recipient's 32-byte X25519 public key (hex)
 * @returns Hex-encoded ciphertext
 */
function boxEncrypt(plaintext, nonceHex, senderSecHex, recipientPubHex) {
    const nonce = hexDecode(nonceHex);
    const senderSec = hexDecode(senderSecHex);
    const recipientPub = hexDecode(recipientPubHex);
    const messageBytes = tweetnacl_util_1.default.decodeUTF8(plaintext);
    const ciphertext = tweetnacl_1.default.box(messageBytes, nonce, recipientPub, senderSec);
    if (!ciphertext) {
        throw new Error("Box encryption failed — invalid keys or nonce length");
    }
    return hexEncode(ciphertext);
}
/**
 * Decrypt using NaCl box (authenticated public-key decryption).
 * @param ciphertextHex - Hex-encoded ciphertext
 * @param nonceHex - 24-byte hex nonce
 * @param recipientSecHex - Recipient's 32-byte X25519 secret key (hex)
 * @param senderPubHex - Sender's 32-byte X25519 public key (hex)
 * @returns Decrypted plaintext
 */
function boxDecrypt(ciphertextHex, nonceHex, recipientSecHex, senderPubHex) {
    const nonce = hexDecode(nonceHex);
    const recipientSec = hexDecode(recipientSecHex);
    const senderPub = hexDecode(senderPubHex);
    const ciphertext = hexDecode(ciphertextHex);
    const plaintext = tweetnacl_1.default.box.open(ciphertext, nonce, senderPub, recipientSec);
    if (!plaintext) {
        throw new Error("Box decryption failed — invalid ciphertext, keys, or nonce");
    }
    return tweetnacl_util_1.default.encodeUTF8(plaintext);
}
// ─── Nonce Generation ───
/**
 * Generate a random 24-byte nonce (for secretbox or box).
 * @returns Hex-encoded nonce
 */
function generateNonce() {
    const nonce = tweetnacl_1.default.randomBytes(tweetnacl_1.default.box.nonceLength); // 24 bytes
    return hexEncode(nonce);
}
// ─── Fingerprint ───
/**
 * Compute a human-readable fingerprint from a public key.
 * Uses SHA-256 of the public key bytes, formatted in groups of 4 hex chars.
 * @param publicKeyHex - Hex-encoded public key
 * @returns Fingerprint string (e.g., "a1b2 c3d4 e5f6 ...")
 */
function computeFingerprint(publicKeyHex) {
    const pubBytes = hexDecode(publicKeyHex);
    // Use Node.js built-in crypto for SHA-256
    const hash = sha256(pubBytes);
    // Format as groups of 4 hex chars, uppercase
    return hash.match(/.{1,4}/g)?.join(" ").toUpperCase() ?? hash.toUpperCase();
}
/**
 * SHA-256 hash using Node.js built-in crypto.
 */
function sha256(data) {
    const crypto = require("crypto");
    return crypto.createHash("sha256").update(Buffer.from(data)).digest("hex");
}
//# sourceMappingURL=crypto.js.map