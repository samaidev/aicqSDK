/**
 * AICQ SDK — Crypto module
 * Ed25519 signing, X25519 key exchange, and NaCl secret/box encryption
 * powered by tweetnacl.
 */
/**
 * Generate an Ed25519 signing keypair.
 * @returns [publicKeyHex, secretKeyHex]
 */
export declare function generateSigningKeypair(): [string, string];
/**
 * Derive the Ed25519 public key (hex) from a 64-byte secret key (hex).
 * Used by one-shot invocation helpers where the caller only has the
 * secret key (e.g. InvokeAgentStream / invokeAgentStream).
 *
 * @param secretKeyHex - 128-char hex Ed25519 secret key
 * @returns 64-char hex Ed25519 public key
 */
export declare function derivePublicKeyFromSecret(secretKeyHex: string): string;
/**
 * Sign a message with an Ed25519 secret key.
 * @param message  - Plaintext message to sign
 * @param secretKeyHex - Hex-encoded 64-byte Ed25519 secret key
 * @returns Hex-encoded signature
 */
export declare function sign(message: string, secretKeyHex: string): string;
/**
 * Verify an Ed25519 signature.
 * @param message - Original plaintext message
 * @param signatureHex - Hex-encoded signature
 * @param publicKeyHex - Hex-encoded 32-byte Ed25519 public key
 * @returns true if valid
 */
export declare function verify(message: string, signatureHex: string, publicKeyHex: string): boolean;
/**
 * Generate an X25519 key exchange keypair.
 * @returns [publicKeyHex, secretKeyHex]
 */
export declare function generateExchangeKeypair(): [string, string];
/**
 * Encrypt plaintext using NaCl secretbox (XSalsa20-Poly1305).
 * @param plaintext - Message to encrypt
 * @param nonceHex - 24-byte hex nonce
 * @param keyHex - 32-byte hex key
 * @returns Hex-encoded ciphertext
 */
export declare function encrypt(plaintext: string, nonceHex: string, keyHex: string): string;
/**
 * Decrypt ciphertext using NaCl secretbox (XSalsa20-Poly1305).
 * @param ciphertextHex - Hex-encoded ciphertext
 * @param nonceHex - 24-byte hex nonce
 * @param keyHex - 32-byte hex key
 * @returns Decrypted plaintext
 */
export declare function decrypt(ciphertextHex: string, nonceHex: string, keyHex: string): string;
/**
 * Encrypt using NaCl box (authenticated public-key encryption).
 * @param plaintext - Message to encrypt
 * @param nonceHex - 24-byte hex nonce
 * @param senderSecHex - Sender's 32-byte X25519 secret key (hex)
 * @param recipientPubHex - Recipient's 32-byte X25519 public key (hex)
 * @returns Hex-encoded ciphertext
 */
export declare function boxEncrypt(plaintext: string, nonceHex: string, senderSecHex: string, recipientPubHex: string): string;
/**
 * Decrypt using NaCl box (authenticated public-key decryption).
 * @param ciphertextHex - Hex-encoded ciphertext
 * @param nonceHex - 24-byte hex nonce
 * @param recipientSecHex - Recipient's 32-byte X25519 secret key (hex)
 * @param senderPubHex - Sender's 32-byte X25519 public key (hex)
 * @returns Decrypted plaintext
 */
export declare function boxDecrypt(ciphertextHex: string, nonceHex: string, recipientSecHex: string, senderPubHex: string): string;
/**
 * Generate a random 24-byte nonce (for secretbox or box).
 * @returns Hex-encoded nonce
 */
export declare function generateNonce(): string;
/**
 * Compute a human-readable fingerprint from a public key.
 * Uses SHA-256 of the public key bytes, formatted in groups of 4 hex chars.
 * @param publicKeyHex - Hex-encoded public key
 * @returns Fingerprint string (e.g., "a1b2 c3d4 e5f6 ...")
 */
export declare function computeFingerprint(publicKeyHex: string): string;
//# sourceMappingURL=crypto.d.ts.map