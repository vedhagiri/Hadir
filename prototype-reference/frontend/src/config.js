// Single place to change the backend URL.
// Use VITE_API_BASE env var to override at build time:
//   VITE_API_BASE=http://192.168.0.100:5006 npm run build
export const API_BASE =
  import.meta.env.VITE_API_BASE || 'http://localhost:5006'

// Helper: prefix a relative path like "/api/stats" with API_BASE
export const apiUrl = (path) => `${API_BASE}${path}`
