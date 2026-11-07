import { Link } from 'react-router'

export function NotFoundPage() {
  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">Page not found</h1>
      <p className="lead">This address does not match a ReliefCheck page.</p>
      <p>
        <Link to="/">Go to Ask ReliefCheck</Link>
      </p>
    </section>
  )
}
