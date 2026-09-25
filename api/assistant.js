// api/assistant.js
// Dedicated voice assistant route. It intentionally reuses the same handler
// as the main chat so auth, rate limits, model fallback, and formatting stay consistent.
export { default } from './chat.js';
