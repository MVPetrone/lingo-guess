import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import App from './App.tsx'
import { normalizeLocation } from './router.ts'

// /daily/ → /daily, ?daily=1 → /daily, unknown → /, before anything reads the path.
normalizeLocation()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
