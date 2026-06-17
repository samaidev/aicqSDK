package aicq

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	"golang.org/x/crypto/nacl/box"
	"golang.org/x/crypto/nacl/secretbox"
)

// ─── Crypto Primitives ───────────────────────────────────────────
// Ed25519 for signing, X25519+XSalsa20-Poly1305 for asymmetric encryption,
// XSalsa20-Poly1305 for symmetric encryption.

// GenerateSigningKeypair generates an Ed25519 signing keypair.
// Returns (publicKeyHex, secretKeyHex).
func GenerateSigningKeypair() (string, string, error) {
	pub, sec, err := ed25519.GenerateKey(nil)
	if err != nil {
		return "", "", fmt.Errorf("generate ed25519 keypair: %w", err)
	}
	return hex.EncodeToString(pub), hex.EncodeToString(sec), nil
}

// GenerateExchangeKeypair generates an X25519 keypair for key exchange.
// Returns (publicKeyHex, secretKeyHex).
func GenerateExchangeKeypair() (string, string, error) {
	pub, sec, err := box.GenerateKey(rand.Reader)
	if err != nil {
		return "", "", fmt.Errorf("generate x25519 keypair: %w", err)
	}
	return hex.EncodeToString(pub[:]), hex.EncodeToString(sec[:]), nil
}

// Sign signs a message with an Ed25519 secret key.
// message is the raw string to sign; secretKeyHex is the hex-encoded 64-byte secret key.
// Returns the signature as hex.
func Sign(message string, secretKeyHex string) (string, error) {
	secBytes, err := hex.DecodeString(secretKeyHex)
	if err != nil {
		return "", fmt.Errorf("decode secret key: %w", err)
	}
	if len(secBytes) != ed25519.PrivateKeySize {
		return "", fmt.Errorf("invalid secret key size: expected %d, got %d", ed25519.PrivateKeySize, len(secBytes))
	}
	sig := ed25519.Sign(ed25519.PrivateKey(secBytes), []byte(message))
	return hex.EncodeToString(sig), nil
}

// SignBytes signs raw bytes with an Ed25519 secret key.
// Returns the signature as hex.
func SignBytes(data []byte, secretKeyHex string) (string, error) {
	secBytes, err := hex.DecodeString(secretKeyHex)
	if err != nil {
		return "", fmt.Errorf("decode secret key: %w", err)
	}
	if len(secBytes) != ed25519.PrivateKeySize {
		return "", fmt.Errorf("invalid secret key size: expected %d, got %d", ed25519.PrivateKeySize, len(secBytes))
	}
	sig := ed25519.Sign(ed25519.PrivateKey(secBytes), data)
	return hex.EncodeToString(sig), nil
}

// Verify verifies an Ed25519 signature.
// Returns true if the signature is valid.
func Verify(message string, signatureHex string, publicKeyHex string) (bool, error) {
	sigBytes, err := hex.DecodeString(signatureHex)
	if err != nil {
		return false, fmt.Errorf("decode signature: %w", err)
	}
	pubBytes, err := hex.DecodeString(publicKeyHex)
	if err != nil {
		return false, fmt.Errorf("decode public key: %w", err)
	}
	if len(pubBytes) != ed25519.PublicKeySize {
		return false, fmt.Errorf("invalid public key size: expected %d, got %d", ed25519.PublicKeySize, len(pubBytes))
	}
	return ed25519.Verify(ed25519.PublicKey(pubBytes), []byte(message), sigBytes), nil
}

// VerifyBytes verifies an Ed25519 signature against raw bytes.
func VerifyBytes(data []byte, signatureHex string, publicKeyHex string) (bool, error) {
	sigBytes, err := hex.DecodeString(signatureHex)
	if err != nil {
		return false, fmt.Errorf("decode signature: %w", err)
	}
	pubBytes, err := hex.DecodeString(publicKeyHex)
	if err != nil {
		return false, fmt.Errorf("decode public key: %w", err)
	}
	if len(pubBytes) != ed25519.PublicKeySize {
		return false, fmt.Errorf("invalid public key size: expected %d, got %d", ed25519.PublicKeySize, len(pubBytes))
	}
	return ed25519.Verify(ed25519.PublicKey(pubBytes), data, sigBytes), nil
}

// Encrypt performs symmetric encryption using XSalsa20-Poly1305.
// keyHex is a 32-byte hex key; nonceHex is a 24-byte hex nonce.
// Returns ciphertext as hex (includes the Poly1305 auth tag).
func Encrypt(plaintext string, nonceHex string, keyHex string) (string, error) {
	var nonce [24]byte
	var key [32]byte

	nonceBytes, err := hex.DecodeString(nonceHex)
	if err != nil {
		return "", fmt.Errorf("decode nonce: %w", err)
	}
	if len(nonceBytes) != 24 {
		return "", fmt.Errorf("invalid nonce size: expected 24, got %d", len(nonceBytes))
	}
	copy(nonce[:], nonceBytes)

	keyBytes, err := hex.DecodeString(keyHex)
	if err != nil {
		return "", fmt.Errorf("decode key: %w", err)
	}
	if len(keyBytes) != 32 {
		return "", fmt.Errorf("invalid key size: expected 32, got %d", len(keyBytes))
	}
	copy(key[:], keyBytes)

	ciphertext := secretbox.Seal(nil, []byte(plaintext), &nonce, &key)
	return hex.EncodeToString(ciphertext), nil
}

// Decrypt performs symmetric decryption using XSalsa20-Poly1305.
func Decrypt(ciphertextHex string, nonceHex string, keyHex string) (string, error) {
	var nonce [24]byte
	var key [32]byte

	nonceBytes, err := hex.DecodeString(nonceHex)
	if err != nil {
		return "", fmt.Errorf("decode nonce: %w", err)
	}
	if len(nonceBytes) != 24 {
		return "", fmt.Errorf("invalid nonce size: expected 24, got %d", len(nonceBytes))
	}
	copy(nonce[:], nonceBytes)

	keyBytes, err := hex.DecodeString(keyHex)
	if err != nil {
		return "", fmt.Errorf("decode key: %w", err)
	}
	if len(keyBytes) != 32 {
		return "", fmt.Errorf("invalid key size: expected 32, got %d", len(keyBytes))
	}
	copy(key[:], keyBytes)

	ctBytes, err := hex.DecodeString(ciphertextHex)
	if err != nil {
		return "", fmt.Errorf("decode ciphertext: %w", err)
	}

	plaintext, ok := secretbox.Open(nil, ctBytes, &nonce, &key)
	if !ok {
		return "", fmt.Errorf("decryption failed: authentication error")
	}
	return string(plaintext), nil
}

// BoxEncrypt performs asymmetric encryption (X25519 + XSalsa20-Poly1305).
// senderSecHex is the sender's 32-byte X25519 secret key (hex).
// recipientPubHex is the recipient's 32-byte X25519 public key (hex).
// nonceHex is a 24-byte hex nonce.
// Returns ciphertext as hex.
func BoxEncrypt(plaintext string, nonceHex string, senderSecHex string, recipientPubHex string) (string, error) {
	var nonce [24]byte
	var senderSec [32]byte
	var recipientPub [32]byte

	nonceBytes, err := hex.DecodeString(nonceHex)
	if err != nil {
		return "", fmt.Errorf("decode nonce: %w", err)
	}
	if len(nonceBytes) != 24 {
		return "", fmt.Errorf("invalid nonce size: expected 24, got %d", len(nonceBytes))
	}
	copy(nonce[:], nonceBytes)

	secBytes, err := hex.DecodeString(senderSecHex)
	if err != nil {
		return "", fmt.Errorf("decode sender secret: %w", err)
	}
	if len(secBytes) != 32 {
		return "", fmt.Errorf("invalid sender secret size: expected 32, got %d", len(secBytes))
	}
	copy(senderSec[:], secBytes)

	pubBytes, err := hex.DecodeString(recipientPubHex)
	if err != nil {
		return "", fmt.Errorf("decode recipient public: %w", err)
	}
	if len(pubBytes) != 32 {
		return "", fmt.Errorf("invalid recipient public size: expected 32, got %d", len(pubBytes))
	}
	copy(recipientPub[:], pubBytes)

	ciphertext := box.Seal(nil, []byte(plaintext), &nonce, &recipientPub, &senderSec)
	return hex.EncodeToString(ciphertext), nil
}

// BoxDecrypt performs asymmetric decryption (X25519 + XSalsa20-Poly1305).
// recipientSecHex is the recipient's 32-byte X25519 secret key (hex).
// senderPubHex is the sender's 32-byte X25519 public key (hex).
// nonceHex is a 24-byte hex nonce.
// Returns the plaintext string.
func BoxDecrypt(ciphertextHex string, nonceHex string, recipientSecHex string, senderPubHex string) (string, error) {
	var nonce [24]byte
	var recipientSec [32]byte
	var senderPub [32]byte

	nonceBytes, err := hex.DecodeString(nonceHex)
	if err != nil {
		return "", fmt.Errorf("decode nonce: %w", err)
	}
	if len(nonceBytes) != 24 {
		return "", fmt.Errorf("invalid nonce size: expected 24, got %d", len(nonceBytes))
	}
	copy(nonce[:], nonceBytes)

	secBytes, err := hex.DecodeString(recipientSecHex)
	if err != nil {
		return "", fmt.Errorf("decode recipient secret: %w", err)
	}
	if len(secBytes) != 32 {
		return "", fmt.Errorf("invalid recipient secret size: expected 32, got %d", len(secBytes))
	}
	copy(recipientSec[:], secBytes)

	pubBytes, err := hex.DecodeString(senderPubHex)
	if err != nil {
		return "", fmt.Errorf("decode sender public: %w", err)
	}
	if len(pubBytes) != 32 {
		return "", fmt.Errorf("invalid sender public size: expected 32, got %d", len(pubBytes))
	}
	copy(senderPub[:], pubBytes)

	ctBytes, err := hex.DecodeString(ciphertextHex)
	if err != nil {
		return "", fmt.Errorf("decode ciphertext: %w", err)
	}

	plaintext, ok := box.Open(nil, ctBytes, &nonce, &senderPub, &recipientSec)
	if !ok {
		return "", fmt.Errorf("decryption failed: authentication error")
	}
	return string(plaintext), nil
}

// GenerateNonce generates a random 24-byte nonce and returns it as hex.
func GenerateNonce() (string, error) {
	var nonce [24]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", fmt.Errorf("generate nonce: %w", err)
	}
	return hex.EncodeToString(nonce[:]), nil
}

// ComputeFingerprint computes a human-readable fingerprint for a public key.
// Takes the SHA-256 hash and returns hex groups (e.g., "a1b2 c3d4 e5f6 ...").
func ComputeFingerprint(publicKeyHex string) string {
	pubBytes, err := hex.DecodeString(publicKeyHex)
	if err != nil {
		return ""
	}
	h := sha256.Sum256(pubBytes)
	full := hex.EncodeToString(h[:])
	// Group into 4-char chunks for readability
	result := ""
	for i := 0; i < len(full); i += 4 {
		if i > 0 {
			result += " "
		}
		end := i + 4
		if end > len(full) {
			end = len(full)
		}
		result += full[i:end]
	}
	return result
}
