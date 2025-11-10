/**
 * Initialize encryption libraries before Discord voice connection
 * This MUST be loaded before @discordjs/voice to ensure crypto methods are available
 */
import _sodium from 'libsodium-wrappers';

// Wait for sodium to be ready
await _sodium.ready;

// Make it globally available for @discordjs/voice to detect
globalThis.sodium = _sodium;

console.log('✅ Encryption library (libsodium-wrappers) initialized');

export default _sodium;
