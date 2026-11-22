import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import App from './App.tsx'
import { readSignInReturn } from './lib/auth.ts'
import { normalizeLocation } from './router.ts'

// Back from Google (/?signed_in=1 or /?signin=error…) → /archive, parameters stripped.
readSignInReturn()
// /daily/ → /daily, ?daily=1 → /daily, unknown → /, before anything reads the path.
normalizeLocation()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
