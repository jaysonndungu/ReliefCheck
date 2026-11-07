import { useEffect } from 'react'

type Props = {
  title: string
  summary: string
  story: string
}

/** Clearly labeled placeholder for a screen owned by a later story. Shows no sample answers. */
export function PlaceholderPage({ title, summary, story }: Props) {
  useEffect(() => {
    document.title = `${title} · ReliefCheck`
  }, [title])

  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">{title}</h1>
      <p className="lead">{summary}</p>
      <p className="notice">
        <strong>Not available yet.</strong> This screen is being built in {story}. No answers or evidence are
        shown until a reviewed knowledge base is published.
      </p>
    </section>
  )
}
