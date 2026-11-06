import { NavLink, Outlet } from 'react-router'
import { ApiStatusBanner } from '../features/health/ApiStatusBanner'
import { useApiStatus } from '../features/health/useApiStatus'

const NAV_ITEMS = [
  { to: '/', label: 'Ask ReliefCheck', end: true },
  { to: '/appeal', label: 'Check an Appeal', end: false },
  { to: '/compare', label: 'Compare Channels', end: false },
  { to: '/about', label: 'About the Evidence', end: false },
] as const

export function Layout() {
  const { status, retry } = useApiStatus()

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="container header-inner">
          <NavLink to="/" className="brand" end>
            ReliefCheck
          </NavLink>
          <nav aria-label="Primary">
            <ul className="nav-list">
              {NAV_ITEMS.map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to} end={item.end} className="nav-link">
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      <div className="container">
        <ApiStatusBanner status={status} onRetry={() => void retry()} />
      </div>
      <main id="main" className="container main" tabIndex={-1}>
        <Outlet />
      </main>
      <footer className="site-footer">
        <div className="container">
          ReliefCheck shows documented evidence, not certification. It cannot guarantee that a charity,
          page or payment is safe.
        </div>
      </footer>
    </>
  )
}
