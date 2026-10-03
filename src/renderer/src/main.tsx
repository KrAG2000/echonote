import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/app.css'
import { App } from './App'
import { Overlay } from './Overlay'

const isOverlay = window.location.hash.startsWith('#/overlay')
document.body.classList.toggle('overlay-body', isOverlay)

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isOverlay ? <Overlay /> : <App />}</StrictMode>
)
