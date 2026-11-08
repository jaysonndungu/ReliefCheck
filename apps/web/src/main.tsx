import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router'
import { Layout } from './components/Layout'
import { PlaceholderPage } from './pages/PlaceholderPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { ChatPage } from './pages/ChatPage'
import { SourcePage } from './pages/SourcePage'
import './styles.css'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<ChatPage />} />
          <Route path="sources/:sourceVersionId" element={<SourcePage />} />
          <Route
            path="appeal"
            element={
              <PlaceholderPage
                title="Check an Appeal"
                summary="Compare a donation link or appeal message against reviewed official channels and published warnings."
                story="US13"
              />
            }
          />
          <Route
            path="compare"
            element={
              <PlaceholderPage
                title="Compare Channels"
                summary="Compare reviewed relief channels side by side by the needs they document."
                story="US14"
              />
            }
          />
          <Route
            path="about"
            element={
              <PlaceholderPage
                title="About the Evidence"
                summary="How sources are reviewed, what the evidence statuses mean, and what ReliefCheck cannot tell you."
                story="a later story"
              />
            }
          />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
