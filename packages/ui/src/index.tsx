// Sprint 6.0 — Shared Strategy Intelligence Dashboard components.
// Sprint 6.0.1 — barrel promoted to `.tsx` with an explicit extension
// on the re-export so both the Next.js webpack resolver (web + admin)
// and TypeScript's bundler moduleResolution deterministically pick up
// the JSX-bearing source without falling back to extension guessing.
export * from './strategy/strategy-intelligence';
