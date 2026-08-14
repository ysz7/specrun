// Renderer entry: mount the React app. The typed window.alethic bridge is already in place (preload).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';

// Global keyframes: the in-progress plan-step pulse (Phase 9 task 4) and the chat working blink.
const style = document.createElement('style');
style.textContent =
  '@keyframes alethicPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(217,98,43,0.35); } 50% { box-shadow: 0 0 0 6px rgba(217,98,43,0); } }' +
  '@keyframes alethicBlink { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }';
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
