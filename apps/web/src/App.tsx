import { Route, Routes } from 'react-router'
import { Layout } from './components/Layout'
import { AdminLogsPage } from './pages/AdminLogsPage'
import { AdminPerformancePage } from './pages/AdminPerformancePage'
import { AppealPage } from './pages/AppealPage'
import { ChatPage } from './pages/ChatPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { PlaceholderPage } from './pages/PlaceholderPage'
import { SourcePage } from './pages/SourcePage'

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<ChatPage />} />
        <Route path="sources/:sourceVersionId" element={<SourcePage />} />
        <Route path="appeal" element={<AppealPage />} />
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
        <Route path="admin/performance" element={<AdminPerformancePage />} />
        <Route path="admin/logs" element={<AdminLogsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
