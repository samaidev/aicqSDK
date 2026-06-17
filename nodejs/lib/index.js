"use strict";
/**
 * AICQ SDK — Public API surface
 * Re-exports all modules for consumer access.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionError = exports.AuthError = exports.AICQError = exports.computeFingerprint = exports.generateNonce = exports.boxDecrypt = exports.boxEncrypt = exports.decrypt = exports.encrypt = exports.verify = exports.sign = exports.generateExchangeKeypair = exports.generateSigningKeypair = exports.AICQAgentClient = exports.AICQClient = void 0;
// Main client class
var client_1 = require("./client");
Object.defineProperty(exports, "AICQClient", { enumerable: true, get: function () { return client_1.AICQClient; } });
// Ephemeral (HTTP-only) client
var ephemeral_1 = require("./ephemeral");
Object.defineProperty(exports, "AICQAgentClient", { enumerable: true, get: function () { return ephemeral_1.AICQAgentClient; } });
// Crypto module (all functions)
var crypto_1 = require("./crypto");
Object.defineProperty(exports, "generateSigningKeypair", { enumerable: true, get: function () { return crypto_1.generateSigningKeypair; } });
Object.defineProperty(exports, "generateExchangeKeypair", { enumerable: true, get: function () { return crypto_1.generateExchangeKeypair; } });
Object.defineProperty(exports, "sign", { enumerable: true, get: function () { return crypto_1.sign; } });
Object.defineProperty(exports, "verify", { enumerable: true, get: function () { return crypto_1.verify; } });
Object.defineProperty(exports, "encrypt", { enumerable: true, get: function () { return crypto_1.encrypt; } });
Object.defineProperty(exports, "decrypt", { enumerable: true, get: function () { return crypto_1.decrypt; } });
Object.defineProperty(exports, "boxEncrypt", { enumerable: true, get: function () { return crypto_1.boxEncrypt; } });
Object.defineProperty(exports, "boxDecrypt", { enumerable: true, get: function () { return crypto_1.boxDecrypt; } });
Object.defineProperty(exports, "generateNonce", { enumerable: true, get: function () { return crypto_1.generateNonce; } });
Object.defineProperty(exports, "computeFingerprint", { enumerable: true, get: function () { return crypto_1.computeFingerprint; } });
// Error classes
var errors_1 = require("./errors");
Object.defineProperty(exports, "AICQError", { enumerable: true, get: function () { return errors_1.AICQError; } });
Object.defineProperty(exports, "AuthError", { enumerable: true, get: function () { return errors_1.AuthError; } });
Object.defineProperty(exports, "ConnectionError", { enumerable: true, get: function () { return errors_1.ConnectionError; } });
//# sourceMappingURL=index.js.map