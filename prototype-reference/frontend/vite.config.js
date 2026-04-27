import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite dev server runs on 5173, backend on 5006.
// CORS is handled by FastAPI; no proxy needed for fetch().
// The MJPEG <img> tag points directly at the backend URL too.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
})
